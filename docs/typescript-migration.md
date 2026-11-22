# TypeScript and modules for the site: design

Status: **decided, not started** (2026-11-22). The decisions are in section 4 and the order of work in section 6. When a new
question comes up, add it to section 5; once decided, move it to section 4 with its consequences and update sections 3 and 6.

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
3. **Scripts linked through globals and hacks.** `chat.js` and `shopping.js` find sign-in through `window.RecipeAuth`;
   `chat.js` and `auth.js` end with `if (typeof module !== "undefined") module.exports = …` so the backend's tests can load
   them; `mcp-server/test/phase6.test.js` reads `templates/servings.js` as text.
4. **Two module systems.** `build.js` and the renderers in `templates/` use CommonJS, while `mcp-server/` is ESM.

Note: TypeScript gives the types. The modules come from ES `import` plus a bundler, and work just as well in plain JS. This doc does
both.

## 2. What stays the same

- The one hard requirement (`CLAUDE.md`): the site is built in the Pages workflow and served as static files from GitHub Pages.
  No server-side rendering, no other hosting.
- The browser only calls our backend, Supabase Auth and the site's own files. No secrets in the browser.
- The backend stays the only writer to the repo. Recipes, `shopping-list.json` and `data/ingredients.json` keep their formats.
- Pages are still rendered to HTML at build time from `recipes/*.md` (section 4.5: build-time HTML, taken over in the browser).

## 3. Proposed shape

```
src/pages/          one component per page (index, next-week, recipe, shopping) and the layout, .tsx: rendered to HTML at build time
src/islands/        the interactive parts (servings, search, wakelock, cook-claude, shopping list, chat, sign-in), .tsx: rendered
                    into the page's HTML and hydrated in the browser, each a Vite browser entry
src/build/          the build: reads recipes/*.md, shopping-list.json, the catalogue; validates them (shared schemas); renders the pages
shared/             logic, zod schemas and types used by the build, the browser and the backend; own package.json, "type": "module"
vite.config.ts      one config for the browser build, the render build, the dev server and Vitest
tsconfig.json       strict; tsc --noEmit runs in the Pages workflow
```

**The build, in the Pages workflow:** `tsc --noEmit`, `vitest run`, then `vite build` (the islands → `dist/assets/<name>-<hash>.js`
and the manifest), `vite build --ssr src/build/render.tsx`, and `node` runs that render output, which writes every page's HTML into
`dist/` with the manifest's hashed script names. `npm run build` does all of it. Images and the stylesheet are copied as today
(the stylesheet may go through Vite too, for a hashed name).

**The backend** stays a separate Vercel project, converted to `.ts` (4.3), importing `shared/`. `.claude/rules/kept-in-step.md` is
deleted once its five pieces are in `shared/`.

## 4. Decided

### 4.1 Node 24 everywhere

- `.github/workflows/deploy.yml`: `node-version: 24` (today 20).
- `mcp-server/package.json`: `"engines": { "node": "24.x" }` (today 22.x). The Vercel project is already set to 24.x but
  `engines` overrides it: every build logs that warning, three times. That warning goes away.
- Root `package.json`: add `"engines": { "node": ">=24" }` and `"type": "module"`.
- **Native type stripping.** Node 24 runs `.ts` files directly, including `node --test` on `.ts` tests. The backend and `shared/`
  rely on this; the site's build goes through Vite because of JSX (4.6, 4.9). It only strips type
  annotations; it doesn't compile. That rules out TypeScript syntax that generates code (`enum`, `namespace`, constructor parameter
  properties, `import x = require()`). The tsconfig sets `"erasableSyntaxOnly": true` so `tsc` flags them. Relative imports keep their
  `.ts` extension (`import { x } from "./status.ts"`; tsconfig `allowImportingTsExtensions`).
- Local development needs Node 24 too: add an `.nvmrc` with `24`.

### 4.2 Shared code lives in a top-level `shared/`

Tested on a preview deploy of the backend (2026-11-22): a function in `mcp-server/api/` importing `../../shared/x.js` builds and
runs, so the Vercel project ships files outside its root directory. The first try failed with "Named export not found… is a
CommonJS module": Node reads a file's module type from the nearest `package.json`, and the root one has no `"type": "module"`.
With `shared/package.json` saying `{ "type": "module" }` it returned 200, so Vercel also ships that `package.json`.

- `shared/` has its own `package.json` (`"type": "module"`, no dependencies of its own unless needed by both sides).
- `mcp-server/vercel.json`: `ignoreCommand` becomes `git diff --quiet HEAD^ HEAD -- . ../shared`, or a change only in `shared/`
  never redeploys the backend.
- `deploy.yml` needs nothing: it only ignores `mcp-server/**`, so a `shared/` change rebuilds the site.
- One shared change deploys both sides. It must therefore keep both working in the same commit.

### 4.3 The backend moves to TypeScript in this migration

After the site, as its own steps (section 6). Vercel builds `.ts` functions in `api/`, and the tests run on `.ts` with Node 24.
**To test on a preview first:** that Vercel's build accepts relative imports written with the `.ts` extension (the form Node's type
stripping needs), from `api/` into `lib/` and into `../shared/`. If it doesn't, tsconfig's `rewriteRelativeImportExtensions` or
a build step for the backend is needed. Checked the same way as 4.2, before the backend's first converted file.

### 4.4 Vite bundles the browser code

- `vite build` with one input per island (`src/islands/*.tsx`, `build.rollupOptions.input`), output into `dist/`
  without emptying it (`emptyOutDir: false`: the HTML comes from our build). `auth` and `chat` are left out of the inputs when their
  env vars aren't set, as today.
- Our build writes the HTML, not Vite: Vite's `index.html` entry model isn't used for the pages.
- `build.manifest: true` gives the output file names, so `layout` can link hashed names (`chat-3f9a.js`, 4.12).
- **Dev server (to design):** `vite` serves the pages our build writes, and in dev `layout` links `/src/islands/<name>.tsx` so Vite
  can hot-reload them; the build re-runs on a change to a recipe or a renderer. To work out in step 1.

### 4.5 Pages are rendered at build time and taken over in the browser, from one code

The JS-off rule goes. Every page is still written to HTML by the build (fast first view on a weak signal, a readable page if a script
fails, link previews), and the interactive parts are the same components, taken over in the browser (hydration). Replaces the
double rendering of the shopping page (`templates/shopping-list.js` at build time, `shopping.js` in the browser) and the
equivalent pairs elsewhere.

- Rewritten in the same change as the first component: `design.md` ("Every page must read fine with JS off"),
  `docs/chatbot-design.md` §2, `.claude/rules/site.md` and `chat.md`, the root `CLAUDE.md` part 2, and the "works without JS" code
  comments. New rule: a page's content is in its HTML; JS may add features that only exist with JS.

### 4.6 Preact for the components

Small (≈4 KB), JSX, renders to a string at build time (`preact-render-to-string`) and hydrates in the browser; first-class Vite
support (`@preact/preset-vite`).

- **The chat's safety rule stays:** model text becomes DOM nodes, never HTML (`chat-render.test.js` today). In Preact: never
  `dangerouslySetInnerHTML` for anything from the model or a user; the test moves to the component.
- **JSX isn't erasable syntax**, so Node 24 can't run `.tsx` directly. So the site's build goes through Vite
  (4.9).

### 4.7 Strict TypeScript; `chat.js` is split before it's converted

- `"strict": true` for every converted file, from the start. Files are renamed `.js` → `.ts`/`.tsx` one at a time; a file
  isn't checked until it's converted.
- `chat.js` is first split into plain-JS modules along its existing seams (rendering, the `/chat` stream, the tray, the panel and
  its sheets), each deployable, then each is converted.

### 4.8 Data shapes are zod schemas in `shared/`

Recipe frontmatter and ingredients, `shopping-list.json`, the catalogue, the page-context JSON and the `/chat` events are defined
once as zod schemas in `shared/`, with their TypeScript types inferred (`z.infer`).

- The site's build validates every recipe with the same schema the server writes with, replacing `checkIngredients` and the
  frontmatter check in `build.js`.
- The browser imports only the types (`import type`), so zod isn't in any bundle.
- One zod version for both sides: `zod` becomes a dependency of `shared/package.json`. The backend is on zod 3 with
  `zod-to-json-schema` (for the MCP tools' JSON Schema); zod 4 has `z.toJSONSchema` built in. Moving to 4 is a step of its own.

### 4.9 Vite runs both builds

`vite build` bundles the islands for the browser; `vite build --ssr` builds the render entry, which Node runs to write the pages.
One tool and one config for the browser code, the pages, the dev server and the tests (4.11).

### 4.10 Islands: only the interactive parts are hydrated

The servings selector, search, the wake-lock and "Cook with Claude" buttons, the shopping list, sign-in and the chat. Everything
else (the book, a recipe's text and photo, next week) is plain HTML and ships no JS. Each island's data is embedded next to it as
JSON (as `#shopping-data` and `#cook-recipe` are today) and validated by its `shared/` type. A page loads only its islands' scripts.

### 4.11 Vitest for the site and `shared/`

It reads `vite.config.ts`, so JSX and imports work as in the build, and it renders components in a fake DOM (`happy-dom`). The
backend keeps `node --test` on plain `.ts`. The backend's tests of site code (`phase6.test.js` reading `servings.js`,
`ingredients.test.js`, `chat-render.test.js`) move to `shared/` or to the island they test.

### 4.12 Hashed script names

Each build names a script after its contents (`chat-3f9a.js`), and each page links the exact file it was built with (from Vite's
manifest). With fixed names a phone can run yesterday's cached `chat.js` against today's page; with hashed names a page always gets
the script that matches it.

### 4.13 It ships as one PR

The steps in section 6 are commits on one long-lived branch, merged to `main` once at the end. That means one site deploy and
one backend deploy, at the same time.

- **Checking it before the merge:** Pages doesn't deploy branches, so the site is checked locally: `npm run build` on the branch,
  compared with `dist/` built from `main` (the pages' text should only change where a step meant it to), and clicked through in a
  browser (servings, search, the shopping list and stocktake, sign-in, the chat against the preview backend). The backend gets a
  Vercel preview per push, as in 4.2.
- **`main` keeps moving:** the MCP server commits recipes, photos, the catalogue and the shopping list to `main` every week. Those
  files keep their formats, so merging `main` into the branch regularly is cheap. Changes to `templates/`, `build.js`,
  `styles/` or `mcp-server/` on `main` while the branch is open conflict with the migration: hold them, or port them to the branch
  in the same week.
- **`/chat` and `/stocktake` keep their request and response shapes** through the migration, so the old site works with the new
  backend and the reverse, whichever deploy finishes first.
- **Rollback:** revert the merge commit; both sides redeploy as they were.

## 5. Open questions

None at the moment. New ones go here as the work turns them up.

## 6. Order

Commits on the one branch (4.13), in this order. Each still leaves a working site and backend, so the branch can be checked
at every step.

1. **Groundwork:** Node 24 in the workflow and the backend, `.nvmrc`, root `"type": "module"`, `tsconfig.json`, `vite.config.ts`,
   Vitest, `tsc --noEmit` in the workflow. `build.js` becomes ESM and gets the scripts from `vite build` (still plain JS, now with
   hashed names) instead of copying them. Dev server working.
2. **`shared/`:** the five kept-in-step pieces as `.ts`, with their tests; the site and the backend import them; `ignoreCommand`
   gets `../shared`; delete `.claude/rules/kept-in-step.md`.
3. **Schemas:** the zod schemas in `shared/` (recipe, ingredients, shopping list, catalogue, page context); the build validates with
   them; the backend's recipe format uses them.
4. **Pages as components:** layout, tiles, index, next-week, recipe; the render build replaces `templates/*.js` renderers. Same HTML
   out (compare `dist/` before and after). Rewrite the JS-off rules (4.5).
5. **Small islands:** servings, search, wakelock, cook-claude.
6. **Shopping and sign-in islands:** one render for the shopping list; `window.RecipeAuth` becomes an import.
7. **Chat:** split `chat.js` into modules, then convert each into components; the safe-render test moves with it.
8. **The backend to `.ts`:** first a preview test of `.ts` imports on Vercel (4.3), then `lib/`, `api/` and the tests.
