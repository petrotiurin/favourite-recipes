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
- Pages are still rendered to HTML at build time from `recipes/*.md` (section 4.5: build-time HTML, taken over in the browser).

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
- `build.manifest: true` gives the output file names, so `layout` can link hashed names (`chat-3f9a.js`). That makes 5.4 nearly
  free.
- **Dev server (to design):** `vite` serves the pages our build writes, and in dev `layout` links `/src/client/<name>.ts` so Vite
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
- **JSX isn't erasable syntax**, so Node 24 can't run `.tsx` directly. That changes 4.1's "the build runs with `node build.ts`":
  see question 5.1.

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

## 5. Open questions

### 5.1 How does the build run the components?

The build has to render `.tsx` components to HTML, which Node can't run on its own (4.6).

- **A. Vite does both builds:** `vite build` for the browser bundles, then `vite build --ssr` for a render entry
  (`src/build/render.tsx`) that Node runs to write the pages. The standard pattern for a static site with Vite; one tool, one config,
  and the dev server reuses it.
- **B. `htm` instead of JSX:** tagged templates (`` html`<p>${x}</p>` ``) are plain JS, so `node build.ts` still works with no
  build step. Less familiar, weaker type checking of the markup.
- **C. `tsx` (the runner) for the build:** `tsx build.ts` handles JSX. One more tool, and Vite still bundles the browser side.

### 5.2 Which parts are taken over in the browser?

- **Islands:** only the interactive parts hydrate (the servings selector, search, the shopping list, the chat). The rest of a page
  stays plain HTML and ships no JS. Each island's data is embedded next to it.
- **Whole pages:** every page hydrates. Simpler to reason about, but each page ships its whole content twice (HTML and the data to
  rebuild it), the recipe page included.

### 5.3 Tests for the site

There are no tests at the root today: the backend's tests (`node --test`) check the site's scripts. With `.tsx` components,
`node --test` can't load them on its own (4.6).

- **Vitest** for the site and `shared/`: it uses the Vite config, so JSX and imports work as in the build, and it can render
  components in a fake DOM. The backend keeps `node --test` (plain `.ts`, no JSX).
- **`node --test` everywhere**, with the components tested only through the built output.

Either way the site's tests run in the Pages workflow before the build, and the backend's tests of shared code move to `shared/`.

### 5.4 File names and caching

Today `dist/` has fixed names (`chat.js`), so a phone may run yesterday's script against today's HTML. Bundling makes it easy to
emit hashed names (`chat-3f9a.js`) that `layout` writes into the page. Worth doing in this migration or not.

### 5.5 How it ships

Every merge to `main` deploys the site. Options: one PR per step in section 6, each deploying a working site; or one large PR.

## 6. Order (draft)

1. Node 24, `"type": "module"`, tsconfig, the bundler; the build switches from copying scripts to bundling them, no file converted yet.
2. The small scripts: `search`, `wakelock`, `servings`, `cook-claude`.
3. `shared/`: the five kept-in-step pieces, their tests; delete `.claude/rules/kept-in-step.md`.
4. `shopping` and `auth`: `window.RecipeAuth` becomes an import.
5. `chat`.
6. The build and its renderers.
7. The backend (section 4.3), after a preview test of `.ts` imports on Vercel.
8. Rewrite the rules and docs that say vanilla JS or JS-off (4.5).
