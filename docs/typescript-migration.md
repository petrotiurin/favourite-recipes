# TypeScript, modules and Astro for the site: design

Status: **decided, steps 1 (groundwork), 2 (`shared/`), 3 (schemas) and 4 (pages and components) done**; rewritten around Astro (2026-11-22). The decisions are in section 4, new questions in
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

```
astro.config.ts       output "static", site + base, build.format "file", the Preact integration
src/content.config.ts the recipes collection: recipes/*.md, validated by the recipe schema from shared/
src/pages/            index.astro, next-week.astro, shopping-list.astro, recipes/[slug].astro: one file per page (URL), plain HTML out
src/components/       the static pieces, .astro: layout, site bar, tile, ingredient list, week headings. No JS in the browser
src/islands/          the interactive pieces, Preact .tsx: servings, search, wake-lock, cook with Claude, shopping list, sign-in, chat
src/lib/              site-only helpers (week rules and sorting, today templates/status.js)
shared/               logic, zod schemas and types used by the site and the backend; own package.json, "type": "module"
styles/style.css      still the one stylesheet, imported by the layout (Astro bundles it with a hashed name)
recipes/, images/, data/, shopping-list.json   unchanged: the backend's files
mcp-server/           the backend, unchanged in role; converted to TypeScript (4.10), imports shared/
```

`build.js` and `templates/` are gone at the end: Astro's pages, components and islands replace them.

**The Pages workflow** runs `npm ci` then `npm run build`, which is `astro check` (types, including `.astro` files) + `vitest run` +
`astro build`, and uploads `dist/` as today. **Locally:** `npm run dev` is `astro dev` (live reload on a change to a recipe, a page
or an island); `npm run build` + `npx astro preview` to see the real output.

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
- `.claude/rules/kept-in-step.md` is deleted once its pieces are single-sourced: step 2 left it with the two browser scripts and the recipe-format prose (see "Step 2 as built").

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
| Sign-in | where the shopping list or chat needs it | with them |
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
  not again.

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
- The originals aren't published any more, only the sized copies. Anything outside the site that links straight to
  `/images/recipes/<slug>.jpg` (the chat's cards, the backend's tool results) is checked in step 5 and either moved to the sized
  copies or keeps a copied original.
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
   gets `../shared`; `.claude/rules/kept-in-step.md` shrunk (deleted at steps 6, 7 and 10).
3. **Schemas** (done): the zod schemas in `shared/`; the recipes collection validates with them, and the catalogue check; the backend's
   recipe format uses them.
4. **Pages and components** (done): layout, site bar, tile, ingredient list, index, next week, recipe and the static parts of the
   shopping page, as `.astro`; `templates/` renderers and `build.js` go. Compare the pages' text with `main`. Rewrite the JS-off
   rules (4.5).
5. **Photos** sized by Astro (4.13), the image cache in the workflow, and the check of who links to the originals.
6. **Small islands:** search, servings, wake-lock, cook with Claude; the reload-once guard for scripts gone after a deploy (4.11).
7. **Shopping and sign-in islands:** one render for the shopping list; the sign-in store replaces `window.RecipeAuth`.
8. **Chat:** split `chat.js` into modules, then convert each into components; the safe-render test moves with it.
9. **The backend to `.ts`:** first a preview test of `.ts` imports on Vercel (4.10), then `lib/`, `api/` and the tests.
10. **Docs and skills:** the root `CLAUDE.md` (directory layout, build and preview commands), `.claude/rules/site.md` and
    `shopping-list.md`, the `add-recipe` skill (its build step), `mcp-server/CLAUDE.md` where it names site files.

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
