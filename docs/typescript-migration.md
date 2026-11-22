# TypeScript and modules for the site: design

Status: **being decided**. Nothing is built yet. Decided questions are in section 4; open ones are in section 5, in the order we're
going through them. When a question is decided, move it from section 5 to section 4 with its consequences, and update section 3.

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
- Pages are still rendered to HTML at build time from `recipes/*.md` (unless question 5.3 decides otherwise).

## 3. Proposed shape (updated as questions are decided)

```
src/build/          the build (today build.js) and the HTML renderers (today templates/{layout,index,...}.js), TypeScript, ESM
src/client/         browser entry points: search, servings, wakelock, cook-claude, shopping, auth, chat → bundled into dist/*.js
shared/             logic and types used by the build, the browser and the backend (section 4.2), own package.json "type": "module"
tsconfig.json       one strict config, type-checked with tsc --noEmit in the Pages workflow
```

- **Running the build:** `node src/build/build.ts`. Node 24 runs TypeScript directly by stripping the types (section 4), so no
  `tsx` or compile step for the build itself.
- **Browser bundles:** a bundler (Vite, section 4.4) turns each `src/client/*.ts` entry into one `dist/<name>.js`. It still copies
  `auth.js` only when `SUPABASE_URL` + `SUPABASE_ANON_KEY` are set and `chat.js` only when `CHAT_API_URL` is set, as today.
- **Shared code** replaces the `kept-in-step.md` table, and that file is deleted. The backend's tests import the shared modules
  instead of reading `templates/` files.

## 4. Decided

### 4.1 Node 24 everywhere

- `.github/workflows/deploy.yml`: `node-version: 24` (today 20).
- `mcp-server/package.json`: `"engines": { "node": "24.x" }` (today 22.x). The Vercel project is already set to 24.x but
  `engines` overrides it: every build logs that warning, three times. That warning goes away.
- Root `package.json`: add `"engines": { "node": ">=24" }` and `"type": "module"`.
- **Native type stripping.** Node 24 runs `.ts` files directly, including `node --test` on `.ts` tests. It only strips type
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

- `vite build` with one input per browser entry (`src/client/*.ts`, `build.rollupOptions.input`), output into `dist/`
  without emptying it (`emptyOutDir: false`: the HTML comes from our build). `auth` and `chat` are left out of the inputs when their
  env vars aren't set, as today.
- Our build writes the HTML, not Vite: Vite's `index.html` entry model isn't used for the pages.
- `build.manifest: true` gives the output file names, so `layout` can link hashed names (`chat-3f9a.js`). That makes 5.6 nearly
  free.
- **Dev server (to design):** `vite` serves the pages our build writes, and in dev `layout` links `/src/client/<name>.ts` so Vite
  can hot-reload them; the build re-runs on a change to a recipe or a renderer. To work out in step 1.

## 5. Open questions

### 5.1 How strict, and how fast?

- Strict from the start for new and converted files, converting file by file (rename `.js` → `.ts` when its turn comes).
- Or a first pass with `allowJs` + `checkJs` over the untouched JS, then tightening.
The open part is `chat.js`: converting 3,200 lines in one go vs splitting it into modules first (render, stream, tray, panel).

### 5.2 Typed data contracts, and validated at runtime?

The shapes the build, the browser and the backend share: a recipe's frontmatter and ingredients, `shopping-list.json`, the
catalogue, the page-context JSON, the `/chat` events. Options: TypeScript types only; or zod schemas in `shared/` (the backend
already uses zod) with the types inferred from them, so the build also validates recipes with the same rules as the server.
Zod stays out of the browser bundles either way.

### 5.3 What replaces the JS-off rule? Where are pages rendered?

- **A. At build time, as today**, with JS-only features allowed on top.
- **B. In the browser**, from data the build embeds (or fetches).
- **C. Both, from one code:** pages are components, rendered to HTML by the build and taken over in the browser by the same code
  (pre-rendering + hydration). Needs a UI library (5.4).

What B costs, for this site:
- **First view on a weak signal.** An empty page until the script downloads and runs. Most use is on a phone, and the shopping
  list is opened in the shop.
- **One script error blanks the page.** Today a broken `shopping.js` still leaves a readable list.
- **Shared links.** WhatsApp/iMessage previews and search engines read the HTML: `<head>` tags can still be written at build time,
  the body can't.

What A costs: the pages that are interactive anyway are rendered twice, once at build time and once in the browser. The shopping
page today: `templates/shopping-list.js` writes the no-JS list, `shopping.js` redraws it. C removes that without B's costs.

Either way `design.md`, `docs/chatbot-design.md` §2, `.claude/rules/site.md` and `chat.md`, and the "works without JS" code
comments get rewritten.

### 5.4 A UI library for the browser code?

`chat.js` and `shopping.js` build a lot of DOM by hand. Options: none (plain DOM, now typed); a small one (Preact, Lit). Needed if 5.3 picks C (Preact
is the usual fit: small, and Vite pre-renders it).

### 5.5 Tests for the site

There are no tests at the root today: the backend's tests check the site's scripts. Proposed: `node --test` at the root over
`.ts` tests (no runner to install), run in the Pages workflow before the build, and the backend's tests over shared code
move with it.

### 5.6 File names and caching

Today `dist/` has fixed names (`chat.js`), so a phone may run yesterday's script against today's HTML. Bundling makes it easy to
emit hashed names (`chat-3f9a.js`) that `layout` writes into the page. Worth doing in this migration or not.

### 5.7 How it ships

Every merge to `main` deploys the site. Options: one PR per step in section 6, each deploying a working site; or one large PR.

## 6. Order (draft)

1. Node 24, `"type": "module"`, tsconfig, the bundler; the build switches from copying scripts to bundling them, no file converted yet.
2. The small scripts: `search`, `wakelock`, `servings`, `cook-claude`.
3. `shared/`: the five kept-in-step pieces, their tests; delete `.claude/rules/kept-in-step.md`.
4. `shopping` and `auth`: `window.RecipeAuth` becomes an import.
5. `chat`.
6. The build and its renderers.
7. The backend (section 4.3), after a preview test of `.ts` imports on Vercel.
8. Rewrite the rules and docs that say vanilla JS or JS-off (5.3).
