---
paths:
  - "templates/**"
  - "styles/**"
  - "build.js"
  - "design.md"
---

# The site's templates and browser scripts

`design.md` is the UI reference: colour tokens (the orange accent for this week, purple only for drafts, teal only for next week,
no other hues such as green), the house icon language, the shared components and the interaction rules. Read it before changing any
page's look or behaviour, and update it in the same change when you add or alter a pattern.

`templates/` holds two kinds of file. Build-time renderers, JS functions that return HTML strings (`layout.js`, `index.js`,
`next-week.js`, `tiles.js`, `recipe.js`, `ingredients.js` for the ingredient lines and their `data-qty`, `shopping-list.js`,
`status.js` for the week and draft rules), and browser scripts, copied verbatim into `dist/`:

- `search.js`: client-side title filtering over the already-rendered recipe list.
- `servings.js`: the 1/2/4-servings selector on recipe pages (opens on 4), rescaling the amounts `ingredients.js` writes as
  `data-qty` from the recipe's structured ingredients.
- `wakelock.js`: the "Keep screen on" toggle on recipe pages (Screen Wake Lock API).
- `cook-claude.js`: the "Cook with Claude" link in the cook bar: a plain link to a new claude.ai chat whose prompt carries the whole
  recipe at the servings picked (`recipePlainText` in `recipe.js`, from the `#cook-recipe` JSON the build writes); a link the user
  taps, not a network call.
- `shopping.js`: the shopping page (`.claude/rules/shopping-list.md`).
- `auth.js` and `chat.js`: sign-in and the chat (`.claude/rules/chat.md`). `auth.js` is copied only when the build has
  `SUPABASE_URL` + `SUPABASE_ANON_KEY`, `chat.js` only when it has `CHAT_API_URL`.

Every page embeds a page-context literal, `<script type="application/json" id="page-context">` (`{ "page": "recipe", "slug",
"title" }`, `{ "page": "index" }`, `{ "page": "next-week" }`, `{ "page": "shopping" }`), written by `templates/layout.js` (every page
gets it; `<` is escaped). `templates/chat.js` reads it to tell `/chat` which page the user is on.

`styles/style.css` is the one stylesheet, copied verbatim into `dist/`. The build (`build.js`) runs in GitHub Actions before deploy;
whatever it adds must still produce static files for Pages.
