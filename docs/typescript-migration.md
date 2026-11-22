# TypeScript, modules and Astro for the site: design

Status: **done, pending merge**: steps 1 to 10 are built on the branch (groundwork, `shared/`, schemas, pages and components, photos, small islands, shopping and sign-in, chat, the backend to `.ts`, docs and skills), to be merged to `main` once (4.12); rewritten around Astro (2026-11-22). The decisions are in section 4, new questions in
section 5 and the order of work in section 6. When a question is decided, move it to section 4 with its consequences and update
sections 3 and 6.

## 1. Why

The site's browser scripts (`templates/*.js` copied into `dist/`) are hand-written vanilla JS, copied byte for byte. That's
a leftover from the project's first rule: "every page is complete and readable with JS off; no frameworks, no bundler, no npm
packages in `dist/`" (`docs/chatbot-design.md` §2, `design.md` "Every page must read fine with JS off"). The root `CLAUDE.md`
already allows a bundler and npm packages. The JS-off rule is no longer wanted: the site is built in the Pages workflow anyway, and
what it costs us now is:

1. **Code written twice.** `.claude/rules/kept-in-step.md` lists five pieces of logic that exist once in the site and once in
   `mcp-server/`: the ingredient line, the rounding of scaled amounts, `parseQuantity` / `neededAmount`, `loadShoppingList` and the
   recipe format. Three of them have no test and are checked by hand. With modules, each becomes one file that both sides import.
2. **Large untyped scripts.** `templates/chat.js` (≈3,200 lines), `shopping.js` (≈800) and `auth.js` (≈600) read JSON the build
   embeds in each page (`#page-context`, `#shopping-data`, `#cook-recipe`) and the `/chat` event stream. Nothing checks that
   the build, the browser and the backend agree on those shapes.
3. **Pages drawn twice.** The shopping page is rendered at build time by `templates/shopping-list.js` and again in the browser by
   `shopping.js`, two codes that must agree.
4. **Scripts linked through globals and hacks.** `chat.js` and `shopping.js` find sign-in through `window.RecipeAuth`;
   `chat.js` and `auth.js` end with `if (typeof module !== "undefined") module.exports = …` so the backend's tests can load
   them; `mcp-server/test/phase6.test.js` reads `templates/servings.js` as text.
5. **Two module systems.** `build.js` and the renderers in `templates/` use CommonJS, while `mcp-server/` is ESM.

## 2. What stays the same

- **The one hard requirement** (`CLAUDE.md`): the site is built in the Pages workflow and served as static files from GitHub Pages.
  Astro runs only inside that build (4.1); nothing of it runs after the deploy.
- **The site stays light:** pages are HTML; only the interactive parts ship JS (4.6).
- The browser only calls our backend, Supabase Auth and the site's own files. No secrets in the browser.
- The backend stays the only writer to the repo. `recipes/*.md`, `images/recipes/`, `shopping-list.json` and `data/ingredients.json`
  keep their formats and places, so the backend's writes don't change.
- **Every URL stays:** `index.html`, `next-week.html`, `shopping-list.html`, `recipes/<slug>.html` under
  `https://petrotiurin.github.io/favourite-recipes/`. The backend links to recipe pages (`pageUrl` in `mcp-server/lib/recipes.js`),
  and people have them in chats and bookmarks.
- `/chat` and `/stocktake` keep their request and response shapes.

## 3. Proposed shape

Written before the work; **as built** it is this (deviations after the block):

```
astro.config.ts       output "static", site + base, build.format "file", the Preact integration, Sätteri Markdown (smart punctuation off)
src/content.config.ts the recipes collection: recipes/*.md, validated by the recipe schema from shared/ + every ingredient `item` in the catalogue
src/pages/            index.astro, next-week.astro, shopping-list.astro, recipes/[slug].astro: one file per page (URL), plain HTML out
src/components/       the static pieces, .astro: Layout, SiteBar, Tile, WeekHead, IngredientList, Photo, Icon. No JS in the browser
src/islands/          the interactive pieces, Preact .tsx: Search, Servings, CookActions (WakeLock, CookClaude), Shopping, SignIn, chat/ (the chat)
src/lib/              site-only helpers and stores (week rules, status, shopping numbers, the sign-in store, servings store, reload guard, photos, env) and
                      src/lib/chat/, the chat's logic (no Preact), each with Vitest tests next to it
src/integrations/     static-files.ts: copies the original photos (and nothing else now) into dist/
shared/               zod schemas (recipe, catalogue, shopping list, page context, chat events) and logic used by the site and the backend; own package.json, "type": "module"
styles/style.css      still the one stylesheet, imported by the layout (Astro bundles it with a hashed name)
recipes/, images/, data/, shopping-list.json   unchanged: the backend's files
mcp-server/           the backend, unchanged in role; TypeScript run by Node 24 (4.10), imports shared/
```

`build.js` and `templates/` are gone: Astro's pages, components and islands replace them.

Deviations from the proposal, briefly: Markdown is rendered by Astro 7's default Sätteri processor, not remark (step 4); the chat's logic is
`src/lib/chat/` next to the island, not inside it (step 8); the sign-in sheet is mounted by a module script (`src/lib/auth-boot.ts`), not an island
(step 7); the originals of the photos are still published beside the sized copies (step 5); the backend's `.ts` files are shipped by `includeFiles`
and `shared/`'s packages come from a `postinstall` script (step 9); the reload guard listens to `astro:hydration-error` as well as `vite:preloadError`
(step 6). Each is under its "Step N as built".

**The Pages workflow** runs `npm ci` then `npm run build`, which is `tsc -p shared` + `astro check` (types, including `.astro` files) + `vitest run` +
`astro build`, and uploads `dist/` as today (with Astro's image cache restored between runs). **Locally:** Node 24 (`.nvmrc`); `npm run dev` is `astro dev`
(live reload on a change to a recipe, a page or an island); `npm run build` + `npx astro preview` to see the real output. `npx serve dist` and `file://` don't
work: pages link their files under `/favourite-recipes/`.

## 4. Decided

### 4.1 Astro builds the site, as a static site only

Astro is a widely used framework for content sites built around islands (4.6). It does what we'd otherwise write ourselves: read
the Markdown recipes against a schema, render pages to HTML, bundle each island's script with hashed names, a dev server, TypeScript.
Vite is underneath.

- **Static only:** `output: "static"` and no server adapter installed. Astro then runs once, in the GitHub Actions build, writes
  plain files into `dist/`, and GitHub Pages serves them. A page that tried to render per visit fails the build. No load on any
  server, and the backend is untouched.
- **The URLs:** `site: "https://petrotiurin.github.io"`, `base: "/favourite-recipes"`, `build.format: "file"` (writes
  `recipes/<slug>.html`, not `recipes/<slug>/index.html`). Links inside pages go through the base. **Checked in step 1 (Astro 7.4.13):**
  `astro dev` answers `/favourite-recipes/index.html`, `next-week.html`, `shopping-list.html` and `recipes/<slug>.html` with 200 (`/favourite-recipes/recipes/pancakes`
  without the extension answers too, which the built site doesn't; the root `/` is a 404 in dev because of the base).
- **Recipe Markdown** is rendered by Astro's Markdown (remark, GitHub-flavoured) instead of `marked`. The two can differ in small
  ways, so step 4 compares the pages' text before and after.
- **The build time** grows by some seconds; visitors don't see it.

### 4.2 Node 24 everywhere

- `.github/workflows/deploy.yml`: `node-version: 24` (today 20).
- `mcp-server/package.json`: `"engines": { "node": "24.x" }` (today 22.x). The Vercel project is already set to 24.x but
  `engines` overrides it: every build logs that warning, three times. That warning goes away.
- Root `package.json`: add `"engines": { "node": ">=24" }` and `"type": "module"`. Local development: an `.nvmrc` with `24`.
- **Native type stripping:** Node 24 runs `.ts` files directly (only types are removed, nothing is compiled). The backend and
  `shared/` rely on this, so they can't use TypeScript syntax that generates code (`enum`, `namespace`, constructor parameter
  properties): their tsconfig sets `"erasableSyntaxOnly": true`, and relative imports keep the `.ts` extension
  (`allowImportingTsExtensions`). The site's own files go through Astro, which handles `.astro` and `.tsx`.

### 4.3 Shared code lives in a top-level `shared/`

Tested on a preview deploy of the backend (2026-11-22): a function in `mcp-server/api/` importing `../../shared/x.js` builds and
runs, so the Vercel project ships files outside its root directory. The first try failed with "Named export not found… is a
CommonJS module": Node reads a file's module type from the nearest `package.json`, and the root one has no `"type": "module"`.
With `shared/package.json` saying `{ "type": "module" }` it returned 200, so Vercel also ships that `package.json`.

- `shared/` has its own `package.json` (`"type": "module"`).
- `mcp-server/vercel.json`: `ignoreCommand` becomes `git diff --quiet HEAD^ HEAD -- . ../shared`, or a change only in `shared/`
  never redeploys the backend.
- `deploy.yml` needs nothing: it only ignores `mcp-server/**`, so a `shared/` change rebuilds the site.
- One shared change deploys both sides, so it must keep both working in the same commit.
- `.claude/rules/kept-in-step.md` is deleted once its pieces are single-sourced: step 2 left it with the two browser scripts and the recipe-format prose (see "Step 2 as built"); it went in step 7, and its recipe-format note moved to the step 10 list.

### 4.4 Data shapes are zod schemas in `shared/`

Recipe frontmatter and ingredients, `shopping-list.json`, the catalogue, the page-context JSON and the `/chat` events are defined
once as zod schemas in `shared/`, with their TypeScript types inferred (`z.infer`).

- The recipes collection (`src/content.config.ts`) uses the recipe schema, so `astro build` fails on a bad recipe with the same
  rules the backend writes with, plus a check that every ingredient's `item` is in `data/ingredients.json`. That replaces
  `checkIngredients` and the frontmatter check in `build.js`.
- The browser imports only types (`import type`), so zod isn't in any browser script.
- **One zod for everything:** Astro brings its own zod (`astro/zod`), and `defineCollection` expects a schema from that zod's major
  version. `shared/` depends on the same major version, and the backend moves to it too: today it's on zod 3 with
  `zod-to-json-schema`, and zod 4 has `z.toJSONSchema` built in.
- **Checked in step 1:** Astro 7.4.13 depends on **zod 4.6.7** (`astro/zod` is that copy; npm dedupes it with a root `zod`). A schema
  written against a *separate* install of zod 4.6.7 (a stand-in for `shared/`, its own `package.json` and `node_modules`) is accepted by
  `defineCollection` with the `glob` loader: all 72 recipes load, defaults (`.default([])`) apply, and a recipe that breaks the schema
  fails the build with `InvalidContentEntryDataError` naming the file and field. A zod **3** schema (the backend's `zod@3.25.76`, a plain `z.object({ title })` test) loads the entries
  but the build warns `An error was encountered while creating the JSON schema ... reading 'def'` (Astro's zod 4 `toJSONSchema` can't read
  a zod 3 schema), so it's unsupported; the `zod/v4` subpath of zod 3.25 loaded without a warning, but it wasn't tested further. So `shared/` and the backend use `zod@^4` (the same major as Astro), with no need for the two to be the same copy.

### 4.5 The JS-off rule goes; pages are still HTML

Every page is written to HTML by the build: fast first view on a weak signal (the shop), a readable page if a script fails, link
previews in WhatsApp and iMessage. JS may now add features that only exist with JS.

Rewritten in step 4: `design.md` ("Every page must read fine with JS off"), `docs/chatbot-design.md` §2, `.claude/rules/site.md`
and `chat.md`, the root `CLAUDE.md` part 2, and the "works without JS" code comments.

### 4.6 Islands: only the interactive parts ship JS

An island is one interactive part of a page. Astro writes it into the page's HTML at build time like everything else, and only
the islands ship a script that takes them over in the browser. Everything else is `.astro` components, which ship no JS.

| Island | Pages | Loads (Astro directive) |
| --- | --- | --- |
| Search | home | `client:load` |
| Servings selector | recipe (when scalable) | `client:visible` |
| Keep screen on, Cook with Claude | recipe | `client:visible` |
| Shopping list and stocktake | shopping | `client:load` |
| Sign-in | the account button on the shopping page (an island) and in the chat's header; the sheet on every page of a build with sign-in (mounted by a module script, see "Step 7 as built") | `client:load` / with the page |
| Chat | every page, when `CHAT_API_URL` is set | `client:idle`: once the page has loaded and settled |

- An island's data is passed as props; Astro writes them into the page next to the island. That replaces the `#shopping-data` and
  `#cook-recipe` blocks. `#page-context` stays, written by the layout, for the chat.
- **Islands that need the same state** (the chat and the shopping list both need sign-in) share it through one module, a small
  store with `@preact/signals`. That replaces `window.RecipeAuth`.
- `auth` and the chat appear only when their env vars are set at build time (`SUPABASE_URL` + `SUPABASE_ANON_KEY`,
  `CHAT_API_URL`), as today.
- **Weight:** a page with no islands ships no JS. A page with islands gets Preact (≈4 KB, cached across pages), Astro's island
  loader (≈1 KB, in the page) and its islands' code.

### 4.7 Preact for the islands

Small (≈4 KB), JSX, Astro's `@astrojs/preact` integration. Only islands are Preact; pages and static parts are `.astro`.

- **The chat's safety rule stays:** model text becomes DOM nodes, never HTML (`chat-render.test.js` today). In Preact: never
  `dangerouslySetInnerHTML` for anything from the model or a user; the test moves to the component.

### 4.8 Strict TypeScript; `chat.js` is split before it's converted

- The site's tsconfig extends `astro/tsconfigs/strict`; the backend and `shared/` are strict too (4.2). `astro check` and `tsc`
  run in the build.
- `chat.js` is first split into modules along its existing seams (rendering, the `/chat` stream, the tray, the panel and its
  sheets), then each becomes components.

### 4.9 Vitest for the site and `shared/`

It reads Astro's Vite config (`getViteConfig` from `astro/config`), so JSX and imports work as in the build. Islands are tested in a
fake DOM (`happy-dom`); `.astro` components through Astro's Container API (renders a component to HTML in a test). The backend keeps
`node --test`. The backend's tests of site code (`phase6.test.js` reading `servings.js`, `ingredients.test.js`,
`chat-render.test.js`) move to `shared/` or to the island they test.

### 4.10 The backend moves to TypeScript in this migration

After the site, as the last code step. Vercel builds `.ts` functions in `api/`, and the tests run on `.ts` with Node 24.
**To test on a preview first:** that Vercel's build accepts relative imports written with the `.ts` extension, from `api/` into
`lib/` and into `../shared/`. If it doesn't, tsconfig's `rewriteRelativeImportExtensions` or a build step for the backend is needed.
Checked the same way as 4.3.

### 4.11 Hashed script names

Astro names every script and the stylesheet after their contents (`_astro/chat.3f9a.js`), and each page links the exact files it
was built with. Astro's default; nothing to build.

- **What it fixes, and how much:** GitHub Pages tells browsers a file is good for 10 minutes (`Cache-Control: max-age=600`, which
  we can't change). With fixed names, a phone can get today's page with the `chat.js` it saved before a deploy, for up to those 10
  minutes. With hashed names a page always gets the files it was built with. A small gain; we take it because it comes free.
  Caching files for a year (the usual reason for hashed names) isn't possible on Pages.
- **What it adds: a page left open across a deploy.** Islands load their script later (when scrolled into view, or when the
  browser is idle), and each deploy replaces the whole site, so the old hashed files are gone. A recipe page left open for hours
  then scrolled to the servings selector asks for `servings.3f9a.js`, gets a 404, and the selector stays dead. With fixed names it
  would have got the new `servings.js`, which usually works.
- **The fix: reload once.** The layout adds a few lines that listen for Vite's `vite:preloadError` event (a script or one of its
  parts failed to load) and reload the page, so it comes back with today's files. To avoid a loop when the file is really missing,
  it reloads at most once per page per minute (a timestamp in `sessionStorage`) and otherwise leaves the page as it is. It skips the
  reload while the chat has an unsent message in its box. Step 6 adds it with the first island; a test checks it reloads once and
  not again. (Built in step 6 on two events, not one: Astro imports an island's script directly, not through Vite's preload helper, so a
  gone island script raises Astro's `astro:hydration-error`, not `vite:preloadError`; see "Step 6 as built".)

### 4.12 It ships as one PR

The steps in section 6 are commits on one long-lived branch, merged to `main` once at the end: one site deploy and one backend
deploy, at the same time.

- **Checking it before the merge:** Pages doesn't deploy branches, so the site is checked locally: `npm run build` on the branch,
  its pages' text compared with `dist/` built from `main` (it should only change where a step meant it to), and clicked through in
  a browser (servings, search, the shopping list and stocktake, sign-in, the chat against the preview backend). The backend gets a
  Vercel preview per push, as in 4.3.
- **`main` keeps moving:** the backend commits recipes, photos, the catalogue and the shopping list to `main` every week. Those
  files keep their formats, so merging `main` into the branch regularly is cheap. Changes to `templates/`, `build.js`,
  `styles/` or `mcp-server/` on `main` while the branch is open conflict with the migration: hold them, or port them to the branch
  in the same week.
- **Rollback:** revert the merge commit; both sides redeploy as they were.

### 4.13 Recipe photos are sized by Astro

Today every tile loads the full photo: the backend stores each one as a JPEG up to 1600px on the long edge, and a tile shows it
about 180px wide on a phone (72 recipes, 19 MB of photos). Astro's `<Image>` / `<Picture>` make a few smaller sizes of each photo
in a modern format (WebP, AVIF where it pays) at build time, with `srcset` so the phone picks the size it needs; tiles, the recipe
page's hero and the chat's recipe cards all use them.

- `images/recipes/` and the frontmatter's `image:` don't change: the backend keeps writing the same files. The pages find each
  photo from its `image:` path (an `import.meta.glob` over `images/recipes/`), and a recipe whose photo is missing fails the build
  as it should.
- The pages use the sized copies. Anything outside the pages that links straight to `/images/recipes/<slug>.jpg` (the chat's cards, the
  backend's tool results) is checked in step 5 and either moved to the sized copies or keeps a copied original (decided in "Step 5 as built":
  the originals are still published).
- **Build time:** every photo is resized on every build unless the sized copies are cached. The Pages workflow caches Astro's
  image cache (`node_modules/.astro`) with `actions/cache`, so a build only resizes new photos.

## 5. Open questions

None at the moment. New ones go here as the work turns them up.

## 6. Order

Commits on the one branch (4.12), in this order. Each leaves a site that builds and works, so the branch can be checked at every
step.

1. **Groundwork** (done): Node 24 in the workflow and the backend, `.nvmrc`, root `"type": "module"`. Astro with the Preact integration,
   `astro.config.ts` (static, base, `build.format: "file"`), strict tsconfig, Vitest, `npm run build` / `dev`. The first pages are
   thin: each `.astro` page calls the existing renderer and outputs its HTML (`<Fragment set:html={…} />`), and the existing
   scripts are served as they are. The same site, built by Astro. The checks marked "to check in step 1" (4.1, 4.4).
2. **`shared/`** (done): the kept-in-step pieces as `.ts`, with their tests; the site and the backend import them; `ignoreCommand`
   gets `../shared`; `.claude/rules/kept-in-step.md` shrunk (deleted in step 7).
3. **Schemas** (done): the zod schemas in `shared/`; the recipes collection validates with them, and the catalogue check; the backend's
   recipe format uses them.
4. **Pages and components** (done): layout, site bar, tile, ingredient list, index, next week, recipe and the static parts of the
   shopping page, as `.astro`; `templates/` renderers and `build.js` go. Compare the pages' text with `main`. Rewrite the JS-off
   rules (4.5).
5. **Photos** (done) sized by Astro (4.13), the image cache in the workflow, and the check of who links to the originals.
6. **Small islands** (done): search, servings, wake-lock, cook with Claude; the reload-once guard for scripts gone after a deploy (4.11).
7. **Shopping and sign-in islands** (done): one render for the shopping list; the sign-in store (with a `window.RecipeAuth` shim for the chat until step 8).
8. **Chat** (done): split `chat.js` into modules, then convert each into components; the safe-render test moves with it.
9. **The backend to `.ts`** (done): first a preview test of `.ts` imports on Vercel (4.10), then `lib/`, `api/` and the tests.
10. **Docs and skills** (done): the root `CLAUDE.md` (directory layout, build and preview commands), `.claude/rules/site.md` and
    `shopping-list.md`, the `add-recipe` skill (its build step), `mcp-server/CLAUDE.md` where it names site files. Also the recipe format's prose
    (the note `.claude/rules/kept-in-step.md` carried until step 7): `.claude/skills/add-recipe/SKILL.md` and the schema in the root `CLAUDE.md`
    describe what the zod schemas in `shared/recipe.ts` enforce, by hand; rewrite the skill around the schema (or generate the schema text from it)
    so there is one source, and until then change them together. (Done: see "Step 10 as built".)

### Step 1 as built

- `build.js` is gone already (not at step 4): its loaders and the ingredient check live in `src/lib/site-data.ts`; the pages in
  `src/pages/` call the existing renderers in `templates/` (now ES modules) with `<Fragment set:html>`. `compressHTML` is off, so the
  output is byte for byte what `build.js` wrote (the only extra files are Astro's `_astro/` Preact chunks, which no page loads yet).
- The existing scripts, `styles/style.css` and `images/` are copied by `src/integrations/static-files.ts` (build and dev), under
  their old names; `auth.js` / `chat.js` only with the same env vars as before. Their sources were renamed `templates/auth.cjs` and
  `templates/chat.cjs`, because the root `"type": "module"` would otherwise load them as ES modules and the backend's tests that
  `require` them (`module.exports` at the end) would break; the published names are unchanged.
- `BUILD_OUT_DIR` still picks another output folder (`astro.config.ts`); the backend's tests build with
  `node node_modules/astro/bin/astro.mjs build`.

### Step 2 as built

- `shared/` (`package.json` `"type": "module"`; `tsconfig.json` strict, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, nodenext,
  checked by `tsc -p shared`, the first part of `npm run build`; the root tsconfig includes it too, so `astro check` sees it):
  `ingredient-line.ts` (was `templates/ingredients.js` and `mcp-server/lib/ingredient-line.js`, identical but for the server's
  `scaledMarkdown`, which is now there for both), `quantity.ts` (`formatQuantity`, was `mcp-server/lib/scaling.js` and `format()` in
  `servings.js`), `shopping-list.ts` (`BASE_SERVINGS`, `DEFAULT_SERVINGS`, `parseQuantity`, `neededAmount`, `loadShoppingList`).
  Both sides import them by relative path with the `.ts` extension; the backend's `lib/shopping-list.js` re-exports what its callers
  used and keeps its own 2-decimal `neededAmount` wrapper (the shared one isn't rounded, as the site's never was).
- **Differences between the copies, and what was kept:** (1) `neededAmount`: the backend rounded to 2 decimals, the site didn't, and
  `servingsOf` was `??` on the server and `||` on the site. Shared: unrounded and `||` (a 0 or missing plan value means
  `DEFAULT_SERVINGS`; the server validates 1..12 on write, so nothing stored changes); the backend wraps it with `round`. (2) `loadShoppingList`:
  the site dropped sections with no name or no items and gave null for a list with none, warned about unparsable files, and would have thrown
  on a JSON `null`; the backend returned the parsed file as it was and silently null for bad JSON. Shared: the site's rule plus a guard for a
  non-object; the backend now also gets null for a file with no usable section, and so loses nothing it could use (status "none", no
  stocktake to apply). The backend passes no `warn`, so it stays silent. (3) The ingredient line, `parseQuantity` and the rounding were the same.
- **The browser scripts keep their own copies until step 6/7** (the least throwaway option: a build-time bundle of the shared functions
  would be deleted when the scripts become islands): `servings.js` `format()` and `shopping.js` `need()` stay as they are, each guarded by
  a test in `shared/test/` that evaluates the script's function and compares it with the shared one over many inputs; the tests go with the copies.
  `shopping.js`'s `formatNumber` and the static page's `fmtAmount` are other duplicates, not on the original list, and wait for step 7.
- **Recipe format:** the code half (`mcp-server/lib/recipe-format.js`) has no copy on the site; the site's check is `checkIngredients` in
  `src/lib/site-data.ts` (uses the shared `UNITS` and `sectionErrors`). The rest is the prose of the `add-recipe` skill and the root
  `CLAUDE.md`, so `kept-in-step.md` stays for it until steps 3 and 10.
- Tests: the line, sections and book checks of `mcp-server/test/ingredients.test.js` and the rounding part of `phase6.test.js` moved to
  `shared/test/` (Vitest, in the root config, so `npm run build` runs them); the backend keeps the catalogue and site-build tests.
- **Not checked: Vercel with `.ts` imports from `.js` functions** (4.10). `api/*.js` now import `../../shared/*.ts` through `lib/`.
  `node --test` is fine on Node 24, a Vercel preview is the open check before this branch is relied on.

### Step 3 as built

- **`shared/`** (zod `^4.6.7`, declared in `shared/package.json` and the root; `z.infer` types exported): `recipe.ts` (`ingredientObject` = the fields with the
  agent-facing descriptions and refusal messages; `ingredientSchema` / `storedIngredientSchema` = those plus the whole-line rules; `ingredientProblems(ing, i)` =
  the strings a write is refused with; `recipeFrontmatterSchema`; `COURSES`), `catalogue.ts` (`catalogueSchema`, `SECTIONS`, `SHOP_UNITS`), `shopping-list.ts`
  (`shoppingListSchema`; `amounts` values may be `null`, as in the real file), `page-context.ts` (`pageContextSchema` = what the layout embeds, `chatPageSchema` =
  the `page` the chat sends), `chat-events.ts` (`chatEventData` by event name, `chatEventSchema` for `emit({ type, ...data })`). `ingredient-line.ts` gained
  `sectionIssues` (structured) and `UNITS` is now `as const`. Tests: `shared/test/schemas.test.ts` (every recipe, the catalogue and
  `shopping-list.json` validate; the messages; the layout's page context; one sample per chat event). The backend's chat tests also check every event
  they read against `chatEventData` (strict), which found two undocumented bits of the wire: `tray` carries an optional `label` and sometimes no `added`.
- **The site:** `src/content.config.ts` is the recipes collection (glob `recipes/*.md`, `recipeFrontmatterSchema` + every ingredient `item` in the catalogue, the
  catalogue itself checked against `catalogueSchema`). A bad recipe fails `astro build` naming the file and the field (`InvalidContentEntryDataError`:
  `ingredients.0.item: rice: item "no-such-thing" isn't in data/ingredients.json`). Astro shows the first failing recipe only. `src/lib/site-data.ts`
  gets recipes from `getCollection` (async now; pages `await` it) and keeps one body check (no `## Ingredients` heading); `checkIngredients` and the
  frontmatter check are gone. `dist/` is byte-identical to the build of the commit before.
- **The backend** is on zod 4 (`zod-to-json-schema` removed; `z.toJSONSchema(..., { target: "draft-7", io: "input" })` for the chat's function tools;
  `@modelcontextprotocol/sdk` 1.31 already takes zod 4 shapes, no upgrade). Its tools' ingredient input is `ingredientObject`;
  `ingredientSchemaErrors` in `lib/catalogue.js` is `ingredientProblems` (checked against the old function on 40,000 random ingredients: same messages, same
  order); `KEY_ORDER` in `lib/recipe-format.js` is the schema's key order. `COURSES`, `SECTIONS`, `SHOP_UNITS` live in `shared/`.
- **Differences, on purpose:** a tool call with a bad ingredient is now refused at the argument check with the specific message
  ("ingredients.0.unit: unit \"oz\" isn't one of …") instead of zod's generic one; `optional: false` is refused in a tool call as before but accepted in a
  file (as before); a non-string `item` is refused. The tool listings (`tools/list` and the chat's function definitions) are equivalent but not identical:
  no `additionalProperties: false` (zod 4's input mode doesn't write it; unknown keys are still stripped), `maximum: 9007199254740991` on integers,
  `propertyNames` on records, `oneOf` for `batch_changes`' discriminated union, repeated schemas inlined instead of `$ref`.
- **Not checked: zod on Vercel.** `shared/*.ts` now import `zod`. Node resolves it from `shared/` upwards (locally the root `node_modules`), but the backend's
  deploy installs only `mcp-server/`'s dependencies, so on Vercel `import "zod"` from `shared/` has nowhere to resolve. A preview deploy is needed
  before this is relied on; the likely fixes are `installCommand` in `mcp-server/vercel.json` that also installs `../shared` (it has the dependency declared),
  or an npm workspace at the repo root. Not changed here.
- Still by hand: the prose of the `add-recipe` skill and the root `CLAUDE.md` schema (step 10; `kept-in-step.md` says so).

### Step 4 as built

- **`src/components/`** (`.astro`, no browser JS): `Layout` (head, the `#page-context` JSON through `pageContextSchema` and `scriptJson`, footer, the `auth.js` / `chat.js` script tags from
  `src/lib/env.ts`), `SiteBar`, `Tile`, `WeekHead`, `IngredientList` (the lines from `ingredientHtml`, so `data-qty` is unchanged), `ServingsPicker`, `ShopItem`, `Icon`. The pages are
  `src/pages/index`, `next-week`, `shopping-list` and `recipes/[slug]` (the Markdown body is `render(entry)` from the collection). `src/lib/`: `status.ts` (was `templates/status.js`),
  `week.ts` (the home page's order), `shopping.ts` (the shopping page's numbers and the `#shopping-data` data), `recipe-text.ts` (`recipePlainText`, nobody outside the recipe page used it),
  `env.ts`, `json.ts`, `site-data.ts`. The renderers in `templates/` and `marked` are gone; the browser scripts in `templates/` stay and are copied as before.
- **Same HTML hooks:** every id, class and `data-*` the scripts use, `#page-context`, `#cook-recipe` and `#shopping-data` (parsed and deep-compared) are unchanged. Links stay relative to the page (`rootPrefix`),
  as before, and `style.css` is still the copied file, linked by name: bundling it with a hashed name (section 3) waits for step 6, with the reload-once guard (4.11).
- **Checked against HEAD before this step** (both built in a worktree, with and without the four dummy env vars, plus a shopping list with nothing, everything at home and awkward characters): the
  pages' DOM (tags, attributes, text) and all JSON blocks are equal except for three things: Astro's Markdown adds `id` to the `##` headings of recipe bodies (`id="instructions"`, `id="notes"`); `<body class="">`
  is now `<body>` on the two pages with no body class; and escaping in the raw text (`&#39;` for `'`) that parses to the same text.
- **Markdown:** Astro 7's default processor is Sätteri; it adds smart punctuation by default, which `marked` never did, so `astro.config.ts` turns it off (`satteri({ features: { smartPunctuation: false } })`,
  `@astrojs/markdown-satteri` is a direct dependency for that). With it off all 72 recipe bodies came out as before.
- **Tests:** Vitest for each `src/lib` file; `src/components/components.test.ts` renders `IngredientList`, `Layout`, `Tile`, `WeekHead` and `ShopItem` through the Container API. It needs
  `// @vitest-environment node`: under happy-dom the `.astro` files compile for the browser and the container can't render them. The layout's page-context test moved from `shared/test/schemas.test.ts` there.

### Step 5 as built

- **Code:** `src/lib/photos.ts` finds a photo from the frontmatter `image:` (`import.meta.glob("/images/recipes/*.{jpg,jpeg,png,webp}")`) and throws, naming the recipe, when the
  file isn't there (that fails the build; a Container test covers it). It also holds how big each kind of photo is shown (`PHOTO_SIZES`). `src/components/Photo.astro` wraps `<Image>`: WebP, quality 80, `widths` + `sizes`
  (so `srcset`), `width`/`height` set, `loading` as before (tiles lazy, the hero eager). Kinds: **tile** 240/360/540 wide, cropped to a square at build time (the CSS `aspect-ratio: 1/1; object-fit: cover` did that in the
  browser; sizes `(min-width: 720px) 260px, 50vw`); **hero** 480/800/1200, uncropped (CSS crops: 4:5 on a phone, 3:2 from 720px; sizes `(min-width: 1100px) 1100px, 100vw`); **thumb** 72/108, square, for the
  round photos on the shopping page (36px / 24px shown). `Tile`, the recipe page's hero and the shopping page (header bubbles, recipe list, each row's bubbles, and the `image` in `#shopping-data` that `shopping.js` draws
  from, through the new optional `imageUrl` argument of `shoppingData`) use it. A size bigger than the file is never asked for.
- **CSS:** the `height` attribute (set so the page doesn't jump while the photo loads) beats `aspect-ratio`, so `.tile-image` and `.recipe-hero` got `height: auto`. Nothing else changed; sizes shown are the same as before
  (168x168 tile and 390x488 hero on an iPhone-size screen).
- **WebP only, no AVIF.** Measured with sharp on 12 photos (average per image, WebP q80 / AVIF q60): tile 540px 52.5 / 38.9 KB, hero 800px 97 / 72 KB, so AVIF is about 26% smaller than WebP, but takes 30-50x longer to encode (1.5-2.7 s per
  image against 50-80 ms), which would make a cold build minutes long for about 14 KB saved per tile. WebP is 15-20% smaller than the JPEG at the same size and the sizes are where the saving is.
- **Image cache:** Astro 7 keeps the resized files in `<cacheDir>/assets` (default `node_modules/.astro/assets`, 446 files / 27 MB for 72 photos). `npm ci` empties `node_modules`, so the workflow restores it *after* `npm ci` with
  `actions/cache` on `node_modules/.astro/assets`, key `astro-images-<hash of images/recipes/**>`, restore key `astro-images-`: a new photo changes the key, the last cache is restored, and only the new photo is resized.
  (Photos that are replaced or removed stay in the cache until the key prefix is evicted; harmless, it is a few MB.) `astro.config.ts` takes `ASTRO_CACHE_DIR` to put the cache elsewhere.
- **Tests that build the site** (`mcp-server/test/ingredients.test.js`, `chat-switch.test.js`, `phase6.test.js`) each use their own cache dir (`ASTRO_CACHE_DIR`), which also removes the flakiness of parallel builds sharing
  `node_modules/.astro`; the ingredients test copies a photo for its fake recipe, since a missing photo fails the build.
- **Who links to the originals (`/images/recipes/<slug>.jpg`):** the backend gives the chat absolute URLs `${siteUrl}/images/recipes/...` for recipe cards (`mcp-server/lib/chat-ui.js`, `lib/tray.js` card.recipe, drafts-review and
  optional-items cards through them), which `templates/chat.cjs` checks against the site's origin and draws as `.tile-image` / review / optional-photo images (the cards are at most a phone-width tile). Nothing else outside
  `src/` uses the path: the skills, `mcp-server/workflows/` and the MCP tools' results only talk about the file written to `images/recipes/`, there are no `og:image` tags, and `pageUrl` is the recipe page. **Decision: the originals
  are still copied into `dist/images/recipes/` (as `static-files.ts` always did), the chat and any outside link keep working unchanged, and the pages use the sized copies.** The cost is dist size: 46 MB instead of 19 MB (19 MB
  originals + 27 MB sized copies); Pages' limit is 1 GB and users only download what a page uses. Moving the chat's cards to sized copies needs the backend to know Astro's hashed file names, so it waits for step 8 (the chat
  rewrite), when it can be reconsidered (a fixed-name thumbnail set would be the way); if the cards moved and nothing else linked out, the originals could stop being published then.
- **Measured** (4-core machine): cold image cache `astro build` 9.5 s (2.2 s before this step), warm cache 2.2 s. An iPhone-size screen (390x844 at 3x, Chromium, scrolled to the bottom): images downloaded for the home page
  63 images / 16.9 MB before, 3.1 MB after; next week 2.8 MB to 0.65 MB; a recipe page 221 KB to 182 KB; the shopping page 2.8 MB to 54 KB. Page text: 74 of 75 pages are the same apart from the `<img>` tags and whitespace around them;
  the shopping page's `#shopping-data` has the thumbnail paths. No console errors, no broken images on the home page, next week, a recipe page and the shopping page.

### Step 6 as built

- **Islands** (`src/islands/*.tsx`, strict, Preact; the page is written to HTML with each island's markup in it and Astro hydrates it): `Search` (`client:load`, home page), `Servings` (`client:visible`, scalable recipe pages),
  `CookActions` (`client:visible`, every recipe page) = `WakeLock` ("Keep screen on") + `CookClaude`. Same ids, classes and `data-*` as the scripts had (`#recipe-search`, `.servings-picker [aria-pressed]`, `.cook-bar`, which the chat reads).
  Helpers in `src/lib/`, each with tests: `rescale.ts` (writes the amounts into the page's `.qty` / `.qty-unit` from `formatQuantity`), `tile-filter.ts`, `cook-prompt.ts` (the prompt, ported string for string), `icons.ts` (the icon paths, shared
  by `Icon.astro` and the islands' `Icon.tsx`), `servings.ts` (the store), `reload-guard.ts`. Tests: `src/islands/islands.test.tsx` (happy-dom: rescale at 1/2/4 incl. the `formatQuantity` edge cases, unit words, search, wake-lock
  with a mocked `navigator.wakeLock` and without one, the link at each servings), `src/lib/reload-guard.test.ts`, and the Layout test (the guard is in the head and works as written into the page).
- **One island for the two pills.** `client:visible` watches an island's elements, and a wake-lock island that renders nothing (the build can't know the browser) would never wake, so the wake-lock button is written at build time (and removed again on a
  browser without the API: no button there, as before) and shares the `CookActions` island with the Cook with Claude link. The 4.6 table already put them on one row.
- **The store.** `src/lib/servings.ts` is a `@preact/signals` signal (a new direct dependency; it was already installed through `@astrojs/preact`): `Servings` sets it, `CookClaude` reads it. This replaces reading `aria-pressed` off the DOM
  after the picker's click.
- **What the page says before the islands load** (the old scripts un-hid things when they ran): the cook bar is no longer `hidden` (a hidden element is never "visible", so its islands would never wake). The picker is written with the recipe's own number
  pressed, because the amounts on the page are for it, and moves to 4 (`DEFAULT_SERVINGS`, as the scripts did) when it loads. The static "Serves n" chip is written only when there is no picker (the old script hid it). "Cook with Claude" is a real link
  from the start, at the recipe's own number, with the recipe page's canonical address in the prompt, and takes the browser's address and the picker's number when it loads. `#cook-recipe` is gone; nothing read it (checked: `templates/chat.cjs`, `shopping.js`, `mcp-server/`).
  An island below the fold wakes when scrolled into view and its link's `href` is then current (the picker's number is in the store before that).
- **`shared/servings.ts`** (new, no imports) holds `BASE_SERVINGS` and `DEFAULT_SERVINGS`; `shared/shopping-list.ts` re-exports them. Importing them from `shopping-list.ts` pulled zod into the servings island (90 KB instead of 1.4 KB): **a browser module must not import
  a `shared/` file that imports zod** (4.4). Step 7 has to keep that in mind for the shopping list's `neededAmount`.
- **Gone:** `templates/search.js`, `servings.js`, `wakelock.js`, `cook-claude.js`, `components/ServingsPicker.astro`, the guard test in `shared/test/quantity.test.ts` and its row in `.claude/rules/kept-in-step.md`, and the copy of `format()`. `static-files.ts` copies `shopping.js`,
  `auth.js`, `chat.js` and the original photos only; the dev middleware no longer serves `style.css`.
- **The stylesheet is bundled** by importing it in `Layout.astro`: `_astro/<name>.<hash>.css` (named `site-data...` after the chunk it landed in), minified by Vite (67 KB to 47.6 KB, 13.7 to 9.4 KB gzipped), linked absolutely under the base (`/favourite-recipes/_astro/...`), after the Google
  Fonts link as before. Nothing depends on the old `style.css` URL (grepped `templates/`, `mcp-server/`, the workflows, docs: only a Layout test and comments). The root `CLAUDE.md` build section now says `npx astro preview`, since pages link their files under the base
  (this was already true of the photos since step 5; `npx serve dist` and `file://` show no styles).
  Checked in Chromium, 390 and 1100 px wide, light and dark, on the home page, next week, three recipes and the shopping page (5,344 elements, every computed property but custom properties, which Vite rewrites as written, e.g. `#fff` for `#ffffff`): the same, except `background-position: 0% 0%` is
  `0px 0px` (same place) and sub-pixel text widths from the machine's fonts, plus the "Serves n" chip that is meant to be gone.
- **The reload guard** (`src/lib/reload-guard.ts`, written into every page's head, first in it, by `reloadOnStaleScript.toString()`, so it is tested as TypeScript and runs as an inline script: 567 bytes): on `vite:preloadError` **and `astro:hydration-error`**, reload unless (a) it reloaded this page in the last
  minute (`sessionStorage`, key per path), (b) `sessionStorage` can't be used (it couldn't remember, so it might loop), or (c) the chat's `textarea.chat-input` holds non-blank text (this doesn't use up the one reload). **Deviation from 4.11:** Astro 7 loads an island's script with a plain `import()`
  (retrying once after a second with a cache-busting query), not through Vite's preload helper, so a gone island script never raises `vite:preloadError`; it raises `astro:hydration-error` (a bubbling event on the `astro-island`). The guard listens to both. Any hydration import failure counts, not only a 404.
- **Stale-chunk check** (Chromium, the built site with `CookActions.*.js` deleted from a copy of `dist/`): the page loads, the import fails twice (Astro's retry), the page reloads once, fails again and stays as it is: 2 loads after 10 s, none more; a manual reload inside the minute doesn't reload again. With the file back after
  the first failure (a deploy finishing): reloads once, the island wakes, the link and the toggle work. With text in the chat box: no reload, text kept, and a `vite:preloadError` after emptying it reloads.
- **Checked against the HEAD build** (both in Chromium with iPhone emulation, 390x844 at 3x, no console errors on any page): all 72 recipe pages: after each click on 1, 2, 4, 2, 1, 4 the amounts, unit words, ingredient lines and the Cook with Claude `href` (with the port normalised) are equal, and equal on load (468 checks, 0 differences); 6 recipes
  have no picker and the same link. Search ("tuna", "TUNA  melt", "chicken salad", no match, empty, spaces): the same tiles and `is-searching`. Wake lock (mocked API): request, release and the toggle's text and `aria-pressed` the same; without the API: no button, the link stays.
  The pages' DOM (tags, attributes, text, JSON blocks) differs only by: the stylesheet link (hashed, absolute), the guard `<script>` in every head, Astro's island loader scripts and `astro-island` elements, the removed `<script src>` tags and `#cook-recipe`, the cook bar without `hidden`
  (and the wake-lock button and link inside it from the start), the picker without `hidden` and with the recipe's own number pressed, and the recipe pages with a picker without the "Serves n" chip. The home page's search box is the same markup.
- **JS shipped** (iPhone emulation, bytes as served, gzipped in brackets; "inline" is in the HTML): home page 0.7 KB (0.4) before, 19.1 KB (8.8) + 5.6 KB inline (2.4) after: Preact, the Astro renderer and the island. Next week and shopping: nothing new but the 0.6 KB guard inline (shopping still has `shopping.js`, 33.7 KB).
  Scalable recipe page 8.4 KB (3.6) before, 30.6 KB (13.7) + 5.9 KB inline (2.5) after; a recipe with no picker 5.9 KB (2.7) before, 29.2 KB (12.9) + 5.9 KB inline after. The step buys the shared Preact/Astro runtime (about 26 KB raw, 12 KB gzipped, cached across pages), which the shopping list and chat will also use.
  The `astro-island` loader is inlined (about 5 KB, the first island in the page brings it).
- **`client:visible` and the phone:** the cook bar's pills sit under the servings picker on a phone and may be below the fold; their island wakes when they scroll in, and the link then has the picker's number. A tap on the pills in the few milliseconds before they wake is the same as a tap on the old page before its script ran.
- **Search** now also applies what the box holds when it loads (text typed before the island woke, or put back by the browser on Back), which the script never did.
- **Not checked:** Safari/iOS itself (Chromium emulation only), the real Screen Wake Lock (headless Chromium has the API; the lock itself was mocked), `vite:preloadError` from a real chunk (nothing in the pages' output uses Vite's preload helper yet; the event is covered by a test and by dispatching it).

### Step 7 as built

- **The shopping list is one render.** `src/islands/Shopping.tsx` (`client:load`) is drawn at build time from the saved list (the island's props: the plan, the list's version hash, the stocktake date, the sections, the recipes' title/thumbnail/page,
  and the `/stocktake` address when the build has it) and taken over in the browser. The static `.astro` markup (`ShopItem.astro`, the list part of `shopping-list.astro`), `templates/shopping.js` and `#shopping-data` are gone (nothing else read it: checked `templates/chat.cjs`, `mcp-server/`,
  the skills). The static header ("For n recipes", the recipe links) is still `.astro`. The page's numbers are `src/lib/shopping-state.ts` (need, remaining, fill rows, what the browser keeps; tested in `shopping-state.test.ts`); `src/lib/shopping.ts` keeps what only the build needs (dates, the
  plan, `shoppingProps`). Markup is the script's, element for element: the same ids, classes and `data-*`, except `data-focus` (Preact keeps focus by itself) and that the two tab views are keyed so one's elements are never reused for the other.
- **Single-sourced:** `shared/shopping-quantity.ts` (new, no zod) has `parseQuantity` and `neededAmount` (re-exported from `shared/shopping-list.ts`, so the backend's imports are unchanged) and the island imports it, so a browser module still pulls in no zod (the bundle is 15 KB, not 90 KB).
  `formatAmount` / `formatNumber` / `withUnit` are in `shared/quantity.ts` next to `formatQuantity` (the script's `formatNumber` = metric to one decimal under 10 and whole from 10, anything else `formatQuantity`; `withUnit` attaches metric units). They replace the script's `formatNumber` / `withUnit`
  and the static page's `fmtAmount` (2 decimals), so the page is written the way it is read: **a build-time difference from the HEAD static markup** is that a fractional need is "1½ heads" / "¾" where the static page wrote "1.5 heads" / "0.75" (the script already rewrote it that way as soon as it ran). The backend's own `fmtAmount` in `mcp-server/lib/shopping-list.js`
  (the text of `get_shopping_list` for agents, 2 decimals) is a different job and was left. The `need()` guard test, the copy in the script and the kept-in-step row are gone; `.claude/rules/kept-in-step.md` was only prose after that and is deleted, its recipe-format note moved to the step 10 list.
  Icons: the paths the script drew itself (`house`, `house-all` filled, `house-clear`, `slide`, `check`, `undo`, `person`, `close`, `minus`, `plus`) are in `src/lib/icons.ts` with the rest (a `filled` flag, `Icon.astro` / `Icon.tsx`). The script's cart was a slightly different drawing from the house set's (stroke 2, a 0.5 px offset); the tabs now use the house one.
- **What the browser keeps is read after the first render** (`useLayoutEffect`, then a state update before paint; `useHydrated` in `src/lib/hydrated.ts`): the first browser render equals the page the build wrote (nothing ticked, the plan, signed out), then ticks, servings, unsaved edits, a stocktake saved from here and folded aisles are loaded, so hydration never sees
  different markup. **`localStorage` keys are unchanged** (`shopping-ticks:<version>`, `shopping-plan:<version>`, `shopping-draft:<version>`, `shopping-stocktake:<version>`, `shopping-collapsed`, and the session below), as are the clean-up rules (other lists' keys, `shopping-servings`), so ticked items and sign-ins survive the deploy. The `<details>` folds are `onToggle` handlers that skip a toggle that
  already matches the state.
- **Sign-in is a store**, `src/lib/auth.ts` (`createAuth()`; the site's one is `auth`): `@preact/signals` for the session, the sheet (`sheet`: email | code | password | null, the fields, `message`, `busy`, the copy) and the account menu; methods for everything the script did (`init`, `getSession`, `getAccessToken`, `refresh`, `onChange`, `openSignIn`, `openSetPassword`,
  `closeSheet`, `signOut`, `sessionExpired`, `sendCode`, `verifyCode`, `signInWithPassword`, `setPassword`, `setCopy`, ...). **Same calls and storage:** the Supabase endpoints (`token?grant_type=password|refresh_token`, `otp?redirect_to=`, `verify`, `user` GET and PUT, `logout`) with the same bodies and headers (compared old vs new in the browser: the request logs are equal),
  the session in `shopping-editor-session` (same shape: `access_token`, `refresh_token`, `expires_at`, `email`), `shopping-editor-email`, `shopping-editor-has-password`, `recipes-auth-link-pending` with its one-hour and session-fixation rules, the magic-link fragment handling, the refresh a minute before expiry (one in flight at a time), the `storage` event for other tabs and Escape
  (capture, `stopImmediatePropagation`, so the chat panel doesn't also close). It is safe to import at build time (nothing touches the browser until `init`). The components are in `src/islands/SignIn.tsx`: `AccountButton` (default export, the pill or the avatar and menu; an island on the shopping page; `compact` for the chat) and `SignInSheet`.
- **Not an island: the sheet is mounted by a module script.** `templates/chat.cjs` (unchanged) asks for `window.RecipeAuth` and the session as it loads, and an island hydrates later than a deferred script runs. So when the build has `SUPABASE_URL` + `SUPABASE_ANON_KEY`, `Layout.astro` writes `<script type="application/json" id="auth-config" data-supabase-url data-supabase-key>`
  (the chat finds the Supabase address for photos by `script[data-supabase-url]`, which is why the attributes are kept) and a processed `<script>` that Astro bundles (`src/lib/auth-boot.ts`); a module script runs in document order with the chat's `defer` script, before it. The boot script calls `auth.init`, installs the shim and mounts `SignInSheet` into `#auth-sheet-root` on `<body>`.
  Without the variables the layout writes neither (no script on the page).
- **The shim, for step 8:** `src/lib/recipe-auth.ts` (`installRecipeAuth(store)`) defines `window.RecipeAuth` with exactly the old script's ten methods (`getSession`, `getAccessToken`, `refresh`, `onChange`, `openSignIn`, `openSetPassword`, `signOut`, `sessionExpired`, `renderAccount(el, { compact })`, `setCopy`), each a thin call into the store; `renderAccount` renders `AccountButton` into `el` with Preact's `render`.
  `chat.cjs` still catches the Sign in click on its own header (`[data-auth="signin"]`, capture, `stopPropagation`) to give the sheet its own wording, which still works because the button's handler is on the button. **Step 8 removes the shim** (and `installRecipeAuth`'s call in the boot script and the `Window.RecipeAuth` type): the chat's components import `auth` and `AccountButton` directly, and the chat's `script[data-supabase-url]` lookup becomes the build's value passed as a prop.
- **Shopping page and sign-in, as before:** the account button (top right of the shopping page) and the stocktake exist only when the build also has `STOCKTAKE_API_URL` (and a list); `setCopy` gives the sheet the shopping page's words; a sign-in (this tab, another tab, a magic link) opens the At home tab, a sign-out goes back to the list; the stocktake POST (`{ items: [{ name, quantity?, have? }] }`, `Authorization: Bearer`, 401 signs out with the server's text and keeps the edits, any other refusal shows the server's text, a failed fetch says it
  couldn't reach the server) is unchanged.
- **Tests:** `src/lib/auth.test.ts` (the store: password / code / magic-link sign-in, session restore from the stored key, refresh, sign-out, expiry, the fixation guard, other tabs, Escape), `src/islands/signin.test.tsx` (the sheet and the button, and the shim: its ten methods, delegation, the chat's capture handler), `src/lib/shopping-state.test.ts`, `src/islands/shopping.test.tsx` (as the build writes it and hydrated; ticks, folding,
  recipe photos, servings, signed out / editor, fill rows by tap, slide and keyboard, Save with the exact request and every outcome), `src/lib/shopping.test.ts`, `shared/test/quantity.test.ts` (the new formatters). The backend had no test that loaded `auth.cjs`; `mcp-server/` tests only `require` `templates/chat.cjs`.
- **Checked against the HEAD build** (Chromium, iPhone emulation, 390x844 at 3x; Supabase Auth and `/stocktake` mocked with `page.route`, the same steps run on both builds and compared after every step: the app's DOM, the account button, the sheet, `localStorage` and the requests made): the shopping list's DOM after load is identical, signed out and signed in, with and without the variables and with the current list, an all-at-home list, a list
  with awkward characters and no list (6 builds; the only difference is the cart icon on the editor's tab). Signed-out scenario (servings 1/2/4/plan, per-recipe steps, ticks, reload, row photos, folds, clear): 29 steps, 0 differences. Editor scenario (tabs, house taps, tapping and sliding rows, keyboard slider, folds, discard, clear, reload, Save, save again with other servings, sign-out): 29 steps, 0 differences,
  with the same stocktake request. Sign-in scenario (wrong password, password, set a password, sign-out, the code route with a wrong and a right code, reload keeps the session, backdrop): 15 steps, 0 differences (the three sheet forms are keyed, or Preact reuses the email input for the code and leaves `type=""` on it; the links and the note stay outside the `<form>`, as the script wrote them). A magic-link return (tokens in the address) and an expiring token refreshed on Save before a 401: the same requests and the same
  page. The chat widget on a recipe page (signed out and with a session): the account button, the sheet with the chat's words, Escape closing the sheet and not the panel, and its requests to `/chat/me` with the token: the same. No console errors in any of them. `astro dev` serves the shopping page.
- **JS shipped** (iPhone emulation, scripts as served, gzipped in brackets, inline in the page as "+"): shopping page without the variables 33.0 KB (10.1) + 0.6 KB inline (0.3) before, 48.0 KB (19.8) + 5.5 KB inline (2.3) after (Preact and the island runtime, shared with the other islands, plus the 15.1 KB island and the 6.7 KB sign-in store); with the variables (`chat.js` is 150 KB of both) 198.2 KB (55.0) before, 194.1 KB (60.0) + 5.5 KB inline after.
  Next week, with the variables: 165.3 KB (44.9) before, 175.7 KB (52.4) after, because the sign-in boot script now brings Preact and the store (the old `auth.js` was 25 KB raw, no framework). Other pages: within 1 KB.
- **Not checked:** Safari/iOS itself; real Supabase Auth and a real `/stocktake` (mocked); the real email link; a page open across a deploy with the new island files (the guard of step 6 covers it).
- **Pre-existing, not from this step:** `cd mcp-server && npm test` fails one test, `chat-switch.test.js`'s "the build adds data-public...", when the whole suite runs (three test files run `astro build` in the same repo at once and Astro 7 writes `.astro/.prerender` in the project root, which they clobber: `Cannot find module .astro/.prerender/chunks/...`). It passes on its own and fails the same way on the HEAD checkout; 262 of 263 pass.


### Step 8 as built

- **Two commits.** First the parts of `templates/chat.cjs` that aren't the widget became typed modules with their tests (nothing used them yet); then the
  widget became the island and `chat.cjs` went. `templates/` is now empty and gone (the static-files integration copies the original photos only).
- **The logic** (`src/lib/chat/`, strict, no Preact but a signal; plain functions over one `ChatApp`, split along the script's seams): `app.ts` (the state; the
  conversation log as an ordered list of entries: messages, the one status line, questions, the review cards, chips, errors, "Opening your chat…"; what is kept
  between pages; the bubble, header, context chip; open / close / New chat; `lock`), `turn.ts` (a message and its streamed answer, the 409 retry, a dropped editor
  turn waited for on the server, a turn left on the last page, the page state sent), `session.ts` (requests with the token through `src/lib/auth.ts`, `/chat/me`,
  editor and visitor modes, loading a conversation, the chats list, thumbs, sign-in from the chat), `tray.ts` (loading, folding, Finalise, Save, Save now, clashes,
  "Publishing…"), `photos.ts` (pick, downscale, upload on pick, send by path, the reading poll and line, the enlarged photo), `start.ts` (start-up as the last page
  left it, Escape, the keyboard, the panel's height, the bubble's lift, page hide). Pure: `render.ts` (the safe renderer's parser, `safeHref`), `clean.ts` (what is kept
  of anything received, and the types), `tray-data.ts`, `labels.ts`, `stream.ts` (the SSE reader, typed by `shared/chat-events.ts` with `import type`), `storage.ts`
  (every key, unchanged: `recipes-chat`, `-editor`, `-signin`, `-seen` in localStorage; `-visit`, `-ui`, `-off`, `-tray-fold` in sessionStorage), `photo-files.ts`.
- **The components** (`src/islands/chat/`): `Chat.tsx` (the island: makes the app in the browser, renders nothing at build time), `Panel.tsx` (panel, bubble, the log's
  entries, the locked panel), `Message.tsx` (messages, cards, the nav button), `Chips.tsx` (replies, ask_user), `Review.tsx` (drafts review, optional items),
  `Feedback.tsx`, `Tray.tsx`, `ChatsList.tsx`, `Composer.tsx` (context chip, photos to send, the form), `RichText.tsx`, `icons.tsx` (the chat's own icon set as JSX).
- **How it draws.** The old script built DOM nodes at precise moments (a chip row appended, a card's class set, the tray rebuilt). To keep the page the same, the app
  keeps what each of those moments decided (the log's entries in order, the tray's "view" worked out by `renderTray`, the photos shelf by `paintShelf`) and the components
  draw only that; one signal (`rev`) redraws the island, and `after()` runs scrolling and focus once the DOM is in. The message box is uncontrolled (the app reads and
  sets it), so typing never redraws. Every class, id, `role`, `aria-*`, `data-*` and text is the script's. No `dangerouslySetInnerHTML` (or `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`) anywhere in the chat: a test scans the source.
- **The island**: `<Chat client:idle api publicOff supabaseUrl />`, the last thing in the body of every page of a build with `CHAT_API_URL` (`Layout.astro`); the props
  replace `data-api` / `data-public` and the `script[data-supabase-url]` lookup. It renders nothing at build time (whether there is a bubble depends on who is signed in
  and on a chat switched off earlier in the tab), so `client:idle` (not `client:visible`, which needs something visible) is right. It starts after the sign-in boot
  script, which is a module in the head, so the store is always ready (`auth.enabled`). **Gone:** `templates/chat.cjs`, `src/lib/recipe-auth.ts` (the shim), its
  call in `auth-boot.ts`, the `Window.RecipeAuth` type and its tests, the `data-supabase-*` attributes (`#auth-config` is JSON now, read by the boot script), the
  layout's `rootPrefix` (only the chat's script tag used it). The header's Sign in is still caught in the capture phase (`onClickCapture`, `stopPropagation`) to
  give the sheet the chat's words; the reload guard's `textarea.chat-input` is the composer's.
- **Photos on cards:** unchanged; the backend's card and review photos are `/images/recipes/<slug>.jpg` on the site's origin, which `static-files.ts` still publishes.
  Moving them to sized copies needs the backend to know Astro's hashed names, so it stays as decided in step 5.
- **Tests** (Vitest, happy-dom; 83 in the chat's files): `src/lib/chat/clean.test.ts` (every case of `mcp-server/test/chat-render.test.js` and the chat lines of
  `phase6.test.js`: history, cards, nav, action chips, starters, server messages, photos, labels, questions, reviews, optional items, the tray, the balance line),
  `stream.test.ts` (every event of `chatEventSchema`, chunks of 1/2/3/7/50 bytes incl. multi-byte characters, `\r\n`, bad JSON, the server's error, a cut stream,
  the browser's TypeError, a throwing handler), `storage.test.ts` (the keys, the new-visit rule incl. a sign-in from the chat, blocked storage),
  `src/islands/chat/render.test.tsx` (the renderer's cases against the component, plus the source scan), `chat.test.tsx` (the island against a mocked `/chat` and
  Supabase: panel and bubble, Escape vs the sheet, context chip and page state, a streamed answer with status / cards / chips / nav, every error path, the ring and
  the dot, restore across pages and New chat, the new-visit rule, links held while streaming, switched off / editors only / account can't edit / CHAT_PUBLIC=false,
  the header's Sign in wording, an editor's stored chat with thumbs and the feedback box, a new visit with and without an unseen reply, the chats list with delete,
  a dropped stream resumed, a turn left on the last page, the 409 retry, an expired token, ask_user multi, the tray's cards / detail / drop / fold with its dot,
  Finalise through both review cards to Save and "Publishing…", a clash, Save now, a failed Save, other people's photos being read, photos picked / uploaded /
  numbered / enlarged / failed / retried / too many / not photos, the reading line and the note). Backend: `chat-render.test.js` is gone (its one cross-check, the
  optional card's words against `lib/optional-review.ts`, is `test/chat-words.test.ts`, importing `src/lib/chat/clean.ts`); `phase6.test.js` is `.ts` now without the
  chat's lines; `chat-switch.test.ts` reads the island's props from the built page; `ingredients.test.ts` no longer copies `templates/`.
- **Checked against the build before this step** (Chromium, iPhone 390x844 at 3x and a 1280x860 desktop). The scenario was played once on the old build against the
  dev harness (`mcp-server/scripts/dev.ts`: the real `/chat` handlers, fake GitHub / OpenRouter / Supabase) with every `/chat` and Supabase response recorded via
  `page.route`, then replayed, response for response, to the old and the new build: a visitor (open, "chicken" with cards and chips, a chip, "rice" with its Open
  button, a 500, an error mid-stream, reload with a draft, a card tapped to its recipe page, "this recipe", context dismissed, New chat, close), a new visit in a new
  tab, the header's Sign in sheet, the editor (two staged recipes with photos, the tray's detail, folding by hand, thumbs down with reasons and a note, thumbs up,
  the chats list, two photos picked / uploaded / sent / read with the note, enlarged and closed with Escape, Finalise: the promote question, the drafts review,
  the optional items, Save, the publishing poll), reload as an editor, a new visit on the shopping page, the account menu, sign-out; plus three server and build
  switches (`CHAT_ENABLED=false`; `CHAT_PUBLIC_ENABLED=false` with its Sign in; `CHAT_PUBLIC=false` builds with a non-editor and an editor signing in on the shopping
  page). The chat's DOM (every element, attribute, text, `value`, `disabled`), `body`'s classes, the focused element, localStorage and sessionStorage (times and the
  visitor's random chat id normalised) and the requests made (method, URL, body, token) were compared after each of 105 steps: **the requests (79, 87, 1, 4, 9) and
  storage are the same everywhere; no console errors** (the browser logs the switched-off server's 503 / 403 for both). Differences:
  (1) after a tap on the tray's head, focus stays on it (the script redrew the head and focus fell to `<body>`); kept, it is better for a keyboard.
  (2) The hidden panel gets `--chat-h` / `--chat-top` from the start (the script set them on the page's first viewport resize when it caught one, which it did on some
  loads; the values are the same and both set them on opening). (3) Once on desktop, a new tray card still had its 4-second `is-new` highlight when the snapshot was
  taken (timing; a second run had none). Also on purpose: the "On:" chip's label is empty until the panel first opens, as before (a first version wrote "On: ").
- **Other differences:** the bubble appears when the page is idle, not as soon as it is parsed; the chat's elements sit in an `<astro-island>` (`display: contents`)
  before `#auth-sheet-root` instead of after it (the sheet is above the panel by z-index either way); a tray item whose kind is an `Object` prototype name was accepted
  by the script's `TRAY_KINDS[...]` lookup and isn't now; event data that isn't a JSON object reads as an empty one (the script threw on it, which looked like a
  dropped connection).
- **A bug found, fixed after the comparison:** opening a conversation straight from a page load while its photos were still being read (`GET /chat/conversations/:id`
  with `photos.active`) showed no "Reading photos…" line and didn't poll: `schedulePhotoPoll` compares with `photoChangedAt`, which was still 0, so it treated the
  reading as quiet for 10 minutes and dropped it (after a message of one's own it worked; the old script had the same bug). `loadConversation` now sets
  `photoChangedAt = Date.now()` before it schedules the poll; `chat.test.tsx` ("a conversation opened on page load while its photos are still being read") covers it.
- **JS shipped** (iPhone emulation, all four variables, scripts as served, gzipped in brackets, inline as "+"): home page 179.6 KB (54.4) + 5.5 inline before, 112.9 KB
  (39.4) + 5.8 after; next week 175.7 (52.4) + 0.6 → 112.0 (38.9) + 5.7; a recipe page 183.3 (56.4) + 5.7 → 116.6 (41.4) + 6.0; the shopping page 194.1 (60.0) + 5.5
  → 127.4 (44.9) + 5.8. The island is 75 KB minified (the script was 150 KB as written) and shares Preact, the signals and the store with the other islands; the
  inline part grows by Astro's island loader on pages that had no island before.
- **Not checked:** Safari / iOS itself; the Vercel preview backend (the harness ran the real handlers); a page open across a deploy with the new island file (the
  guard of step 6 covers it).

### Step 9 as built

- **Preview findings (Vercel project `favourite-recipes-mcp-server`, previews of the migration branch).** (1) **`.ts` imported with the `.ts` extension works, from `api/` into `lib/` and into `../shared/`, with no build step and no `rewriteRelativeImportExtensions`:** the function runs on Node 24, which strips the types, as in 4.2. (2) Vercel's file tracing does not follow those imports, so the `.ts` files are not shipped unless `vercel.json` says so: the first trial (`api/stocktake.ts` + `lib/config.ts` + `lib/auth.ts`, the rest `.js`) answered `FUNCTION_INVOCATION_FAILED` with `ERR_MODULE_NOT_FOUND: .../lib/config.ts`; with `lib/**` in `includeFiles` (`"{workflows/**,lib/**,../shared/**}"`) it answered. The whole backend as `.ts` on that setting: `/stocktake` 405 (GET), `/chat` 404 JSON, `/upload` 403 "Link expired" page, `/mcp` needs the bearer (the preview tool could only report "authentication required"); no runtime errors in the logs. `functions` globs `api/*.ts`. (3) **Vercel type-checks `.ts` in the build** (errors are printed, they don't fail the build): without a `typescript` devDependency it uses its built-in 5.9.3 and, with no `mcp-server/tsconfig.json`, found the root one (`File 'astro/tsconfigs/strict' not found`) and reported every `process` and `Buffer` as unknown. With `typescript` and `@types/node` in `devDependencies` and the backend's own `tsconfig.json` it logs `Using TypeScript 6.0.3 (local user-provided)`, and the build log has no TypeScript errors. (4) `installCommand` is still ignored by the project; the `postinstall` that installs `../shared` (step 3's finding) stays.
- **tsconfig** (`mcp-server/tsconfig.json`): strict, `noEmit`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `isolatedModules`, nodenext, includes `api/ lib/ scripts/ test/` and `../shared/**/*.ts`. `typescript ^6` and `@types/node ^24` are devDependencies. **`npm test` runs `tsc -p .` first** (`npm run typecheck` alone is the same check), then `node --test test/*.test.{js,ts}`; the two chat tests that are still `.js` are picked up by the glob until step 8 moves them.
- **What changed in the code:** the files are renamed (`git mv`, history kept) and every relative import says `.ts`; types were added where `strict` asked for them, nothing else (no logic, no messages). Fields that error subclasses and `ChangeSet` set in their constructors are `declare`d (erasable, no runtime field). `lib/tools.ts` has a `ToolDef` interface for the registry; `gh()` in `lib/github.ts` is overloaded (`allow404: true` may return null). Data from the outside (GitHub, OpenRouter, Supabase rows, the tray and the tool arguments) is still mostly typed `any`: about 1,600 explicit `any`s in `lib/` and `api/` (parameters, `catch (err: any)`, JSON rows), added mechanically by a codemod and then tightened only where the compiler forced a better type. **This is strict mode with `any` at the edges, not a typed domain model**: moving the rows and the tray to the zod types in `shared/` is the follow-up (the tray and chat-store rows are the biggest wins). Tests and `scripts/fakes.ts` are looser still.
- **Checked:** `tools/list`, `prompts/list`, the server instructions and the chat's `toolDefinitions("public" | "editor")` were dumped in-process (the way the tests start the server) before and after the rename: byte-identical (232 KB of JSON). `cd mcp-server && npm test` passes three times in a row (263 of 263), `tsc` clean, the root `npm run build` passes.
- **The parallel-build flake is fixed** (it was already worked around for the image cache in step 5, but not for the build folder): Astro 7 puts its `.prerender` folder inside the output folder when that is under the working directory, and in the project's shared `.astro/` when it isn't. The three test files that build the site wrote their output to a temp dir outside the project, so `chat-switch` and `phase6` shared `.astro/.prerender` with each other. `chat-switch.test.ts` now builds into `node_modules/.astro-test/` (inside the project); `ingredients.test.ts` already built inside its own project copy; `phase6.test.js` (untouched) is now the only build left using the shared `.astro/`. Keep an output folder under the working directory when a test builds in parallel. For the same reason the dev harness's `DEV_DIST` must sit under the repo root but not under `mcp-server/` (the build resolves its packages from where its output sits: `Named export 'parseCookie' not found` otherwise).
- **Dev harness:** `scripts/dev.ts` runs the Astro build (`node node_modules/astro/bin/astro.mjs build`, was `node build.js`) and serves the site under its base path (`http://localhost:4000/favourite-recipes/`; `/` redirects there), with `PUBLIC_SITE_URL` including the base so the chat's links resolve. `scripts/fakes.ts` no longer reads `build.js` into the fake repo (it reads `astro.config.ts`, so the "never touched" guard in the e2e test stays meaningful).
- **Not checked:** the full chat and tray flows against real services (the fakes cover them); `/mcp` with the real bearer on a preview (deployment protection stops the fetch tool); Node's "type stripping" experimental warning on Vercel (the runtime logs showed nothing); cold-start time against the `.js` backend (not measured).

### Step 10 as built

- **Docs only, no code.** Root `CLAUDE.md`: parts 1 and 2 (Astro, TypeScript, Node 24, islands), the directory layout (`astro.config.ts`, `src/`, `shared/`, `.nvmrc`, `tsconfig.json`, `vitest.config.ts`; `templates/` and `build.js` are not in it), the build section (`npm run dev`, `npm run build`, `npx astro preview`; `npx serve dist` and opening `dist/index.html` don't work under the base path) and the schema note. `.claude/rules/site.md` (title, the old script names), `chat.md` (`data-public` is the island's `publicOff` prop; `lib/scaling.js` is `shared/`), `shopping-list.md` (backend paths), `mcp-server/CLAUDE.md` and `README.md` (`build.js` and `templates` no longer named), `.claude/skills/debug` (`api/*.ts`), `docs/chatbot-design.md`, `docs/structured-ingredients.md` and `docs/parallel-photo-reading.md` (file references that a reader would follow now point at the new modules; the history around them is left as written; `docs/structured-ingredients.md` "Code changes" has a note that the files it names moved). Every backend `lib/x.js` / `api/x.js` named in the docs is `.ts` now. The hooks, fixed after step 10: `.claude/hooks/run-mcp-tests.sh` (the backend's tests) now triggers only on files the backend uses or its tests read (`mcp-server/**`, `shared/`, `src/lib/chat/clean.ts`, `data/ingredients.json`), and a new `.claude/hooks/run-site-tests.sh` runs the site's Vitest tests that cover an edited `src/`, `shared/` or `styles/` file (`vitest related`, a few seconds; all of them for `astro.config.ts`, `vitest.config.ts` or the catalogue). Before, no hook ran the site's tests, which since steps 6-8 hold the servings, shopping, sign-in and chat tests.
- **One source for the recipe format.** The root `CLAUDE.md` schema block and `.claude/skills/add-recipe/SKILL.md` now say that `shared/recipe.ts` and `shared/catalogue.ts` are the source of truth and the prose follows them (the root block stays a summary, not generated: generating it would need a build step for a file that agents read raw). Checked against the schema, the skill's differences were: `total_mins`, `serves` and `calories` are positive whole numbers (the skill said "a number"); `amount` is positive and a range's first number is below the second; a `unit` needs an `amount` except `pinch` and `handful`; a note saying "to taste" / "to serve" is needed when there's no amount (the skill said "the note must say so"); `name` has no asterisks and isn't empty, `note` has no bold; a `section` name is at most 40 characters and lines without one go before the sections; `item` is kebab-case; catalogue `skip: true` and lower-case `aliases` weren't mentioned; `course` may be empty in the schema (the skill keeps asking for one, for the filters); a `## Ingredients` heading left in the body fails the build (`src/lib/site-data.ts`). Its build step now says `npm run build` type-checks and tests too, and how to look at the page (`npm run dev` / `npx astro preview`, not `dist/` files).
- **Left as history on purpose:** the "Step N as built" sections and sections 1, 2 and 4 of this file (which describe `templates/`, `build.js`, `marked`, `window.RecipeAuth`, `kept-in-step.md` as they were), and the first-build text of the other design docs.
