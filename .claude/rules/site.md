---
paths:
  - "src/**"
  - "astro.config.ts"
  - "styles/**"
  - "design.md"
---

# The site's pages and islands

`design.md` holds the UI principles: colour tokens (the orange accent for this week, purple only for drafts, teal only for next
week, no other hues such as green), the house icon language and the shared components. Read it before changing any page's look or
behaviour. Update it only when a principle, a token or a shared component changes; page-specific details (copy, sizes, flows,
states) belong in the code, not there.

The site is built by Astro (`astro build`, in the Pages workflow) and every page is written to HTML at build time; JS may add features
that only exist with JS. The build-time parts are `.astro` and `.ts` files in `src/`, with no browser JS; the interactive parts are Preact islands
(`src/islands/`, below):

- `src/pages/`: one file per URL (`index.astro`, `next-week.astro`, `shopping-list.astro`, `recipes/[slug].astro`; the recipe's Markdown
  body is rendered by Astro's Markdown from the `recipes` collection, `src/content.config.ts`).
- `src/components/`: `Layout.astro` (the shell, the `#page-context` JSON, the bundled stylesheet and the reload-once guard), `SiteBar`, `Tile`,
  `WeekHead`, `IngredientList` (the ingredient lines from `shared/ingredient-line.ts`, with their `data-qty`), `Icon`. Their tests
  (`components.test.ts`) use Astro's Container API and run in the node environment.
- `src/lib/`: site-only helpers (`status.ts` for the week and draft rules, `week.ts` for the home page's order, `shopping.ts` for the
  shopping page's numbers and data, `recipe-text.ts` for the "Cook with Claude" text, `env.ts` for the build's public variables,
  `json.ts`, `site-data.ts` for the recipes and the shopping list, and what the islands use: `icons.ts`, `servings.ts` (the store), `rescale.ts`,
  `tile-filter.ts`, `cook-prompt.ts`, `reload-guard.ts`, `shopping-state.ts` (the shopping list's numbers and what the browser keeps for it), `auth.ts`
  (the sign-in store), `hydrated.ts`), each with a Vitest test.
- `src/islands/`: Preact (`.tsx`, strict). The page is written to HTML with the island's markup in it at build time and the island takes it over in the
  browser (`<astro-island>`; data comes in as props). Each has a test in `islands.test.tsx`, `shopping.test.tsx`, `signin.test.tsx` or `chat/*.test.tsx` (happy-dom). An island that only fills in the page's own
  markup (servings rescales the `.qty` amounts, search hides tiles) does it with the same ids and classes as before, which the chat reads too.
  - `Search.tsx` (`client:load`): title filtering over the home page's tiles.
  - `Servings.tsx` (`client:visible`): the 1/2/4-servings selector on recipe pages. Written with the recipe's own number pressed; opens at 4 once
    loaded, rescaling the amounts `IngredientList.astro` writes as `data-qty` (`src/lib/rescale.ts`, `formatQuantity` from `shared/quantity.ts`).
    The recipe's "Serves n" chip is only written when there is no selector.
  - `CookActions.tsx` (`client:visible`): "Keep screen on" (`WakeLock.tsx`, Screen Wake Lock API; no button without the API) and "Cook with Claude"
    (`CookClaude.tsx`): a plain link to a new claude.ai chat whose prompt carries the whole recipe at the servings picked (`recipePlainText` in
    `src/lib/recipe-text.ts`, passed as props; `cook-prompt.ts`); a link the user taps, not a network call. It follows the picker through the
    store `src/lib/servings.ts` (`@preact/signals`).
  - `Shopping.tsx` (`client:load`, shopping page): the whole list, drawn once at build time and taken over in the browser (no separate static markup or script); data comes in as props (`shoppingProps` in `src/lib/shopping.ts`, no `#shopping-data`). Servings card, ticks, recipe photos,
    the editor's "At home" tab and the stocktake `fetch` to `/stocktake` (`.claude/rules/shopping-list.md`). What this browser kept (`localStorage` keys
    unchanged, `shopping-state.ts`) and who is signed in are read in a layout effect after the first render (`useHydrated` in `src/lib/hydrated.ts`), so
    hydration starts from what the build wrote. Its quantity maths is `shared/shopping-quantity.ts` and `formatAmount` in `shared/quantity.ts`, which
    the build-time page uses too (one render); they have no zod, which a browser module must not import.
  - `SignIn.tsx`: `AccountButton` (the default export; an island on the shopping page, and drawn in the chat's header) and `SignInSheet` (one per page,
    mounted by `src/lib/auth-boot.ts`, a module script in the head that also starts the store before any island wakes). The store is `src/lib/auth.ts`
    (`@preact/signals`, plain `fetch` to Supabase Auth, the same `localStorage` keys as always, so people stay signed in). Sign-in exists only on builds with
    `SUPABASE_URL` + `SUPABASE_ANON_KEY` (`#auth-config`, JSON, read by the boot script); the shopping page's account button and stocktake need `STOCKTAKE_API_URL` too.
  - `chat/` (`Chat.tsx`, `client:idle`, the last thing in every page's body, only on builds with `CHAT_API_URL`; `.claude/rules/chat.md`): the chat's bubble and
    panel. The build writes nothing for it (the bubble depends on who is signed in); it draws once awake. Its state and logic are `src/lib/chat/`.
  - Shared state between islands goes in a small store in `src/lib/` with `@preact/signals` (as `servings.ts` and `auth.ts`), not in globals or the DOM.
- **Hashed files and the reload guard.** Astro names the stylesheet (imported by `Layout.astro`) and every island's script after their contents, and each
  page links the files it was built with. A page left open across a deploy asks for an island script that is gone; `src/lib/reload-guard.ts`
  (written into every page's head by the Layout) reloads once on Vite's `vite:preloadError` or Astro's `astro:hydration-error`, at most once a minute
  per page, and not while the chat's message box (`.chat-input`) has unsent text.

The chat reads parts of the page the other components and islands write (`#page-context`, the picker's `.servings-picker [aria-pressed]` and `data-serves`,
`#recipe-search`, `.filter-input:checked` and its label, `.cook-bar`, `.save-bar`, `body.sheet-open`), so change both together.

Every page embeds a page-context literal, `<script type="application/json" id="page-context">` (`{ "page": "recipe", "slug",
"title" }`, `{ "page": "index" }`, `{ "page": "next-week" }`, `{ "page": "shopping" }`), written by `src/components/Layout.astro` (every page
gets it; `<` is escaped). The chat (`src/lib/chat/app.ts`) reads it to tell `/chat` which page the user is on.

`styles/style.css` is the one stylesheet, imported by `Layout.astro` so Astro bundles it (minified, hashed name, in the same order). Nothing may link
it by name. The build (`astro build`) runs in GitHub Actions before deploy; whatever it adds must still produce static files for Pages.

**Photos.** Pages never point at `images/recipes/` directly: `Photo.astro` (`src/lib/photos.ts` finds the file from `image:`) makes sized WebP copies with `srcset`
(docs/typescript-migration.md 4.13); a missing photo fails the build. The originals are still published for the chat's cards and outside links.
The CI image cache is `node_modules/.astro/assets` (`ASTRO_CACHE_DIR` moves it; tests that build the site set it).
