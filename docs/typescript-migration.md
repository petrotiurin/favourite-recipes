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
- Pages are still rendered to HTML at build time from `recipes/*.md` (unless question 5.6 decides otherwise).

## 3. Proposed shape (updated as questions are decided)

```
src/build/          the build (today build.js) and the HTML renderers (today templates/{layout,index,...}.js), TypeScript, ESM
src/client/         browser entry points: search, servings, wakelock, cook-claude, shopping, auth, chat → bundled into dist/*.js
shared/             logic and types used by the build, the browser and the backend (where it lives: question 5.1)
tsconfig.json       one strict config, type-checked with tsc --noEmit in the Pages workflow
```

- **Running the build:** `node src/build/build.ts`. Node 24 runs TypeScript directly by stripping the types (section 4), so no
  `tsx` or compile step for the build itself.
- **Browser bundles:** a bundler (question 5.3) turns each `src/client/*.ts` entry into one `dist/<name>.js`. It still copies
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

## 5. Open questions

### 5.1 Where does `shared/` live?

The Vercel project's root directory is `mcp-server/` (confirmed from the build log). Whether its build can read files outside that
folder depends on the project setting Build and Deployment → Root Directory → "Include files outside the root directory in the
Build Step", which the tools available to Claude don't return.

- **A. Top level, `shared/`** (needs the setting on). Both sides import `../shared/…`. Also change the backend's
  `ignoreCommand` in `mcp-server/vercel.json` from `git diff --quiet HEAD^ HEAD -- .` to `… -- . ../shared`, or a change only in
  `shared/` never redeploys the backend.
- **B. Inside the backend, `mcp-server/shared/`.** Works whatever the setting. The site imports from there, and
  `deploy.yml` needs `!mcp-server/shared/**` next to its `paths-ignore: mcp-server/**`, or a shared change never rebuilds the site.

Either way, one shared change deploys both sides.

### 5.2 Does the backend move to TypeScript too, and when?

Vercel runs `.ts` functions in `api/` natively. Options: in this migration; later as a separate one; never (it stays JS and
imports the shared modules; with Node 24 it can import `.ts` directly).

### 5.3 Which bundler?

- **esbuild:** one dependency, very fast, bundles TypeScript, no config file needed. The build calls it from `build.ts`.
- **Vite:** dev server with hot reload; more setup, and it wants to own the HTML, which our build already writes.
- **No bundler, `tsc` per file + native `<script type="module">`:** no new dependency, but every import is a separate request
  and npm packages can't be used.

### 5.4 How strict, and how fast?

- Strict from the start for new and converted files, converting file by file (rename `.js` → `.ts` when its turn comes).
- Or a first pass with `allowJs` + `checkJs` over the untouched JS, then tightening.
The open part is `chat.js`: converting 3,200 lines in one go vs splitting it into modules first (render, stream, tray, panel).

### 5.5 Typed data contracts, and validated at runtime?

The shapes the build, the browser and the backend share: a recipe's frontmatter and ingredients, `shopping-list.json`, the
catalogue, the page-context JSON, the `/chat` events. Options: TypeScript types only; or zod schemas in `shared/` (the backend
already uses zod) with the types inferred from them, so the build also validates recipes with the same rules as the server.
Zod stays out of the browser bundles either way.

### 5.6 What replaces the JS-off rule?

- Keep rendering every page to HTML at build time, but JS-only features are allowed (recommended: free with the current build, fast first paint).
- Or let some pages render in the browser from data the build embeds.
Either way `design.md`, `docs/chatbot-design.md` §2, `.claude/rules/site.md` and `chat.md`, and the "works without JS" code
comments get rewritten.

### 5.7 A UI library for the browser code?

`chat.js` and `shopping.js` build a lot of DOM by hand. Options: none (plain DOM, now typed); a small one (Preact, Lit). This
can be decided separately and later.

### 5.8 Tests for the site

There are no tests at the root today: the backend's tests check the site's scripts. Proposed: `node --test` at the root over
`.ts` tests (no runner to install), run in the Pages workflow before the build, and the backend's tests over shared code
move with it.

### 5.9 File names and caching

Today `dist/` has fixed names (`chat.js`), so a phone may run yesterday's script against today's HTML. Bundling makes it easy to
emit hashed names (`chat-3f9a.js`) that `layout` writes into the page. Worth doing in this migration or not.

### 5.10 How it ships

Every merge to `main` deploys the site. Options: one PR per step in section 6, each deploying a working site; or one large PR.

## 6. Order (draft)

1. Node 24, `"type": "module"`, tsconfig, the bundler; the build switches from copying scripts to bundling them, no file converted yet.
2. The small scripts: `search`, `wakelock`, `servings`, `cook-claude`.
3. `shared/`: the five kept-in-step pieces, their tests; delete `.claude/rules/kept-in-step.md`.
4. `shopping` and `auth`: `window.RecipeAuth` becomes an import.
5. `chat`.
6. The build and its renderers.
7. The backend, if 5.2 says so.
8. Rewrite the rules and docs that say vanilla JS or JS-off (5.6).
