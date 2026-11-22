---
paths:
  - "src/**"
  - "templates/**"
  - "astro.config.ts"
  - "styles/**"
  - "design.md"
---

# The site's pages and browser scripts

`design.md` holds the UI principles: colour tokens (the orange accent for this week, purple only for drafts, teal only for next
week, no other hues such as green), the house icon language and the shared components. Read it before changing any page's look or
behaviour. Update it only when a principle, a token or a shared component changes; page-specific details (copy, sizes, flows,
states) belong in the code, not there.

The site is built by Astro (`astro build`, in the Pages workflow) and every page is written to HTML at build time; JS may add features
that only exist with JS. The build-time parts are `.astro` and `.ts` files in `src/`, with no browser JS:

- `src/pages/`: one file per URL (`index.astro`, `next-week.astro`, `shopping-list.astro`, `recipes/[slug].astro`; the recipe's Markdown
  body is rendered by Astro's Markdown from the `recipes` collection, `src/content.config.ts`).
- `src/components/`: `Layout.astro` (the shell and the `#page-context` JSON), `SiteBar`, `Tile`, `WeekHead`, `IngredientList` (the
  ingredient lines from `shared/ingredient-line.ts`, with their `data-qty`), `ServingsPicker`, `ShopItem`, `Icon`. Their tests
  (`components.test.ts`) use Astro's Container API and run in the node environment.
- `src/lib/`: site-only helpers (`status.ts` for the week and draft rules, `week.ts` for the home page's order, `shopping.ts` for the
  shopping page's numbers and data, `recipe-text.ts` for the "Cook with Claude" text, `env.ts` for the build's public variables,
  `json.ts`, `site-data.ts` for the recipes and the shopping list), each with a Vitest test.

`templates/` holds the browser scripts, copied verbatim into `dist/` (they become islands in steps 6-8 of
`docs/typescript-migration.md`), and the HTML they hook into (ids, classes, `data-*`, `#shopping-data`, `#cook-recipe`,
`#page-context`) is written by the components, so change both together:

- `search.js`: client-side title filtering over the already-rendered recipe list.
- `servings.js`: the 1/2/4-servings selector on recipe pages (opens on 4), rescaling the amounts `IngredientList.astro` writes as
  `data-qty` from the recipe's structured ingredients.
- `wakelock.js`: the "Keep screen on" toggle on recipe pages (Screen Wake Lock API).
- `cook-claude.js`: the "Cook with Claude" link in the cook bar: a plain link to a new claude.ai chat whose prompt carries the whole
  recipe at the servings picked (`recipePlainText` in `src/lib/recipe-text.ts`, from the `#cook-recipe` JSON the build writes); a link the user
  taps, not a network call.
- `shopping.js`: the shopping page (`.claude/rules/shopping-list.md`).
- `auth.js` and `chat.js`: sign-in and the chat (`.claude/rules/chat.md`). `auth.js` is copied only when the build has
  `SUPABASE_URL` + `SUPABASE_ANON_KEY`, `chat.js` only when it has `CHAT_API_URL`.

Every page embeds a page-context literal, `<script type="application/json" id="page-context">` (`{ "page": "recipe", "slug",
"title" }`, `{ "page": "index" }`, `{ "page": "next-week" }`, `{ "page": "shopping" }`), written by `src/components/Layout.astro` (every page
gets it; `<` is escaped). `templates/chat.js` reads it to tell `/chat` which page the user is on.

`styles/style.css` is the one stylesheet, copied verbatim into `dist/`. The build (`astro build`) runs in GitHub Actions before deploy;
whatever it adds must still produce static files for Pages.

**Photos.** Pages never point at `images/recipes/` directly: `Photo.astro` (`src/lib/photos.ts` finds the file from `image:`) makes sized WebP copies with `srcset`
(docs/typescript-migration.md 4.13); a missing photo fails the build. The originals are still published for the chat's cards and outside links.
The CI image cache is `node_modules/.astro/assets` (`ASTRO_CACHE_DIR` moves it; tests that build the site set it).
