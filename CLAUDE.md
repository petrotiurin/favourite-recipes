# Our Favourite Recipes

The family's cooking app: the recipe book, this week's and next week's plans, and the shopping list. (It started as a
migration of a Notion database; it has long outgrown that.) It has three parts:

1. **The site** (GitHub Pages): static HTML/CSS generated at build time from `recipes/*.md` and `shopping-list.json` by
   the Node build script (`build.js`). Every page is complete and readable with JS off. No framework runtime, no
   build-time CMS calls at request time, no client-side data fetching to *load* what a page shows.
2. **Enhancements** (`templates/*.js`): hand-written vanilla JS, copied verbatim into `dist/`. Rules:
   - No frameworks (React/Vue/etc.), no bundler, no npm packages shipped to `dist/`; hand-written vanilla JS only. Small,
     pinned CDN libraries are acceptable only if a future feature really needs one.
   - Optional enhancement: the page's core content (recipe list, recipe pages, shopping list) must already be fully present
     and readable with JS disabled; JS only adds interactivity on top.
   - Pages render from data already baked into the HTML at build time (the DOM, or a JSON literal the build script
     embedded). Runtime network calls are only for **actions**, never to load what the page shows, and only to **our own
     backend** (part 3) and Supabase Auth, never to third-party APIs directly: saving a stocktake, signing in, and (planned)
     chatting.
   - The scripts today: `templates/search.js` (client-side title filtering over the already-rendered recipe list),
     `templates/servings.js` (the 1/2/4-servings selector on recipe pages, rescaling ingredient quantities tagged at build time
     by `templates/quantities.js`), `templates/wakelock.js` (the "Keep screen on" toggle on recipe pages, using the Screen Wake
     Lock API while cooking) and `templates/shopping.js` (below).
   - `templates/shopping.js` on the shopping page lets the signed-in editor save a **stocktake** (what's already at home). It
     signs in with Supabase Auth: email + password, or an email code as the fallback (the same email also carries a magic link;
     plain `fetch` to its REST API, no client library) and POSTs the stocktake to the MCP server's `/stocktake` endpoint. It still
     never *loads* the list at runtime: it re-renders from the JSON literal the build embedded.
   - Every page embeds a page-context literal, `<script type="application/json" id="page-context">` (`{ "page": "recipe", "slug",
     "title" }`, `{ "page": "index" }`, `{ "page": "next-week" }`, `{ "page": "shopping" }`), written by `templates/layout.js`
     (every page gets it; `<` is escaped). The chat will use it to know which page the user is on. Nothing reads it yet.
3. **The backend** (`mcp-server/` on Vercel, **not part of the site**; see `mcp-server/README.md`): the only place with secrets
   and the only writer to the repo. It serves the MCP tools for agents (`/mcp`: add/edit recipes by committing `recipes/*.md` and
   `images/recipes/*` to `main`), `/stocktake` for the site and (planned) `/chat`, and holds the validation rules (its tools
   mirror the `add-recipe` skill rules in `mcp-server/lib/recipe-format.js`: keep the two in sync if the format changes). It
   never ships anything into `dist/`. Every write is a commit to `main` and every commit is a site deploy, so writes are batched.
   - **One tool registry, one dispatcher**: every tool is defined once in `mcp-server/lib/tools.js` (name, description, zod
     schema, `access: "read" | "stage" | "write"`, handler) and every call, MCP or chat, goes through `dispatch(name, args, caller)`,
     which checks `caller.role` (`public` may only run `read`; `editor` and `agent` run all; a tool with no `access` counts as
     `write`). `lib/server.js` registers the MCP tools from the registry with a frozen `{ role: "agent" }` caller. The functions
     that commit (`ChangeSet.commit` / `commitChanges` in `lib/github.js`, `saveStocktake`, the recipe and shopping-list writers)
     take the caller and assert the role themselves. A new tool goes in the registry with its access level, and the registry test
     (`mcp-server/test/tools.test.js`) covers it automatically.

The only allowed "moving part" in the build is the Node build script that runs before deploy.

## UI design

`design.md` is the UI reference: colour tokens (the orange accent for this week, purple only for drafts, teal only for next week, no other hues such as green), the house icon language, the shared components and the interaction rules. Read it before changing any page's look or behaviour, and update it in the same change when you add or alter a pattern.

## How new recipes get added

New recipes are added by asking Claude Code, in chat, to add one. **Always use the `add-recipe` skill** (`.claude/skills/add-recipe/SKILL.md`) for this — it has the exact Markdown formatting rules, the ingredient-bolding rule, and the image rules. Don't freehand a recipe file without it.

The other flow is the agent working through the recipes MCP server: **use the `plan-recipes` workflow** when the user hands over screenshots, links and/or names of recipes we already have. They are always for **next week**. If next week already has recipes, it first switches weeks (`start_next_week`), asking via `AskUserQuestion` about each of this week's drafts: liked → promoted, not liked → removed (unless it's planned for next week: kept, with a warning), not tried → carried over in this week or back to the book. Then it adds the new ones to next week as drafts (photos come from the source link, else the MCP server generates them with OpenRouter; upload links are only a fallback), adds existing ones to next week, always builds next week's shopping list and finishes with a summary. It uses the MCP tools only, never local files, and sends all its writes in one `batch_changes` call: every commit to `main` is a site deploy, so a call per change floods the Pages workflow. The workflow itself ships with the server: its source is `mcp-server/workflows/plan-recipes.md`, served as the `plan-recipes` MCP prompt and by the `get_workflow_guide` tool (the server's instructions tell agents to call it first). `.claude/skills/plan-recipes/SKILL.md` only points there, so change the flow in the server's file; a server deploy updates it for every client.

## Chat

A recipe chat assistant (a bubble on every page: read-only for visitors, the full MCP toolset through a plan tray for signed-in
editors) is designed in `docs/chatbot-design.md` and built in phases. Phase 0 (groundwork) is in: this CLAUDE.md framing, the tool
registry and dispatcher (`mcp-server/lib/tools.js`), the `search_recipes` read tool and the catalogue helper
(`mcp-server/lib/recipes.js`, `catalogue()`), and the page-context JSON in every page. **Phase 1 (read-only, anonymous chat) is in:**
`POST /chat` (`mcp-server/api/chat.js`, agent loop in `lib/chat.js`, prompt in `lib/chat-prompt.js`) streams Server-Sent Events from
an OpenRouter model (`OPENROUTER_CHAT_PUBLIC_KEY`, `CHAT_PUBLIC_MODEL`) that may only call read tools plus the UI tool `suggest_replies`;
the caller is always a frozen `{ role: "public", ip }` (a bad token is a 401, a valid one is still public until phase 3; a role is never
read from the body), client history is reduced to plain user/assistant text, the page is re-resolved server-side, and per-IP rate limits
(hashed IP, counters in Supabase: `supabase/migrations/`, needs `SUPABASE_SERVICE_ROLE_KEY`) and optional Langfuse tracing
(`lib/langfuse.js`) apply. The widget is `templates/chat.js` (safe renderer, history in `localStorage`); it only exists on builds that
set the build env var `CHAT_API_URL` (a repo Actions variable, like `STOCKTAKE_API_URL`), otherwise no bubble and no script.
**Phase 3 (sign-in + per-user chats) is in:** `templates/auth.js` is the one sign-in (sheet, session in `localStorage`, token refresh,
`window.RecipeAuth`) for the shopping page and the chat; it is added to every page (head, deferred) only when the build has `SUPABASE_URL` +
`SUPABASE_ANON_KEY`, and the magic link returns to the page it was sent from. `/chat` decides the caller from a verified token: none =
`public`; valid and in `EDITORS` = `editor` (editor key `OPENROUTER_CHAT_EDITOR_KEY`, model `CHAT_EDITOR_MODEL`, 200/hour per user id);
valid but not an editor = `public` (the panel says the account can't edit); bad or expired = 401. Editors' chats are server-owned
(`conversations` / `messages` tables, service-role key only, RLS with no policies; `lib/chat-store.js`): the client sends
`{ conversation_id?, message, page }`, never history; another user's conversation is a 404; chats are deleted 2 weeks after the last
message (`purge_old_chats()`, run when the chats list is opened, plus pg_cron where available). Editor-only routes under `/chat`:
`GET /chat/me`, `GET /chat/conversations`, `GET|DELETE /chat/conversations/:id`, `POST /chat/feedback` (thumbs up / down become the
Langfuse score `user-feedback`). In this phase editors are still offered only read + UI tools (TODO in `offeredTools`: phase 4 adds the
stage tools; the write tools never go into chat). Try it all locally with `cd mcp-server && npm run dev` (fake GitHub/OpenRouter/Supabase
with sign-in accounts, site on :4000; test accounts and ports are at the top of `mcp-server/scripts/dev.js`). Read the design doc before working on any of it; update it (and this file) in the same change when the design moves. The chat must respect the rules above: `templates/chat.js`
is vanilla JS that talks only to `/chat` (and Supabase Auth through the shared `auth.js`), with JS off nothing changes, and auth is
enforced on the server by the dispatcher, never by the prompt.

## Directory layout

```
recipes/            source of truth: one .md file per recipe (frontmatter + body)
images/recipes/     source of truth: one hero image per recipe
templates/          JS functions that render HTML strings (layout.js, index.js, next-week.js, tiles.js, recipe.js)
templates/search.js client-side search script, copied verbatim into dist/ (see "Hard constraint" above)
templates/servings.js client-side servings selector, copied verbatim into dist/; quantities.js tags scalable numbers at build time
styles/style.css    the one stylesheet, copied verbatim into dist/
shopping-list.json  combined shopping list for next week's recipes, written by the agent via the MCP server (see "Shopping list")
templates/wakelock.js client-side "Keep screen on" toggle (Screen Wake Lock API), copied verbatim into dist/
templates/shopping-list.js  renders shopping-list.html (the list, or a blank page) + the JSON shopping.js works from
templates/shopping.js       shopping page: planned/per-recipe servings, local ticks, editor sign-in sheet + "At home" tab (stocktake)
design.md           UI design notes: palette tokens, the house icon language, components and interaction rules
build.js            reads recipes/*.md (+ shopping-list.json) -> writes dist/ (index.html, next-week.html, recipes/<slug>.html, shopping-list.html)
dist/               build output — gitignored, never hand-edit, regenerated every build
.github/workflows/deploy.yml   GitHub Actions: builds and deploys dist/ to GitHub Pages on push to main (ignores mcp-server/ changes)
mcp-server/         separate backend on Vercel: MCP server for adding/editing recipes, /stocktake, /chat (not part of the site)
mcp-server/lib/tools.js  the tool registry (access levels) + dispatch() + toolDefinitions(role) (OpenAI-style function tools from the zod schemas)
mcp-server/lib/cache.js  short in-memory cache (60s, cleared on commit) behind search_recipes and the chat catalogue
docs/chatbot-design.md  design of the recipe chat assistant (phased; see "Chat")
templates/chat.js        the chat bubble + panel, vanilla JS, talks only to /chat; included on every page only when CHAT_API_URL is set at build time
templates/auth.js        the sign-in sheet and session handling (window.RecipeAuth) shared by the shopping page and the chat; copied to dist/ only when SUPABASE_URL + SUPABASE_ANON_KEY are set at build time
mcp-server/api/chat.js   the /chat endpoint: streams a model through OpenRouter, runs tools via dispatch(); lib/chat.js (agent loop), lib/chat-prompt.js, lib/rate-limit.js, lib/langfuse.js
mcp-server/scripts/dev.js  local harness: backend :8787 + built site :4000 with fake GitHub / OpenRouter / Supabase (scripts/fakes.js); `npm run dev` in mcp-server/
supabase/           `supabase init` layout: migrations/ (rate_limits table + rate_limit_hit function; conversations + messages tables + purge_old_chats; later phases add the tray), config.toml for `supabase start`
mcp-server/workflows/  agent workflows the server serves (plan-recipes.md, ocado-shop.md, sainsburys-shop.md), as MCP prompts + get_workflow_guide; shared/ holds the rules every shop flow includes
```

## Build / preview locally

```
npm install
npm run build        # writes dist/
npx serve dist        # or just open dist/index.html directly in a browser
```

Run `npm run build` after adding or editing any recipe and sanity-check the new page before committing.

## Recipe frontmatter schema

```yaml
---
title: Ultimate Chicken Salad
slug: ultimate-chicken-salad       # kebab-case of title
image: /images/recipes/ultimate-chicken-salad.jpg
course: [Lunch]                    # any of: Breakfast, Lunch, Dinner, Snack, Drink
tags: [High Protein]               # optional, free text list
total_mins: 15
serves: 2                          # number of people the recipe serves, required
calories: 195                      # kcal per serving, required (source's figure, else estimated from ingredients)
scalable: false                    # optional: hides the servings selector (only when the ingredient list already gives per-person amounts)
current: true                      # optional: in THIS week (being cooked now). Top of the home page, under a "This week" heading; "This week" kicker.
next: true                         # optional: in NEXT week (being planned). Listed on next-week.html (linked from the home page); the shopping list is built from these.
draft: true                        # optional: not tried yet. Marked only by a line on its recipe page (tiles show the week). Says nothing about the week. Promoting just drops this line.
---
```

New recipes start as drafts (`draft: true`); once the family has cooked one and wants to keep it, it's promoted to a regular recipe (the MCP server's `promote_recipe` tool drops `draft: true`; its weeks don't change). A draft the family didn't like is deleted with the MCP server's `remove_draft` tool (recipe file + photo); it refuses anything that isn't a draft, so regular recipes can't be removed through the server, and it refuses a draft planned for next week (the family keeps those).

**This week and next week.** Two independent flags, neither implied by `draft`: `current: true` is this week (what's being cooked now), `next: true` is next week (what's being planned and shopped for). A recipe can be in this week, next week, both, or neither. The index shows this week at the top (drafts first), then "The rest of the book" (alphabetical); the filters are courses only. A heading above the grid says "This week" with a teal "Next week · n →" link to `next-week.html` (or "Next week: not planned"). Next week's recipes are unmarked in the book and listed together only on `next-week.html` (`templates/next-week.js`); a draft that's only in next week isn't on the home page at all (search included) until the switch. The MCP's `list_recipes` orders this week, next week, the rest. `set_week_recipes` adds/removes recipes from a week; `start_next_week` is the switch (next week becomes this week, next week is emptied, `carry_over` keeps chosen this-week recipes); both are agent-driven.

Followed by a Markdown body with `## Ingredients` (bulleted, quantities bolded) and `## Instructions` (numbered). See the `add-recipe` skill for the exact rules.

## Shopping list

`shopping-list.html` is a separate page (a "🛒 Shopping list" button in the index header links to it; the list itself is not on the main page). It covers **next week's recipes** (`next: true`) only, and is **not computed by the site**: the agent combines the ingredients of all next-week recipes and saves the result with the MCP server's `update_shopping_list` tool, which commits `shopping-list.json`:

```json
{ "updated": "2026-10-03", "recipes": ["slug-a", "slug-b"], "servings": { "slug-a": 4, "slug-b": 1 },
  "sections": [{ "name": "Fresh produce", "items": [{ "name": "Red onions", "quantity": "3", "note": "optional", "recipes": ["slug-a", "slug-b"], "amounts": { "slug-a": 2, "slug-b": 1 } }] }] }
```

The list is always written for **2 servings of every recipe** (each scaled by 2 / `serves`), so `note` must never contain amounts. An item for several recipes also carries `amounts`: each recipe's share of that 2-serving `quantity` (same unit, adding up to it; the server refuses a multi-recipe item without it). `servings` is the **plan**: how many people each recipe is cooked for this round, set by the agent (`update_shopping_list`'s `servings`, or `set_shopping_servings` to change only the plan, which keeps the items and the stocktake). A recipe the agent doesn't name keeps the previous list's plan, else 4. The page (`templates/shopping.js`) opens on the plan and scales each recipe's share by its own servings / 2; the servings card offers "Plan" (shown only when the plan isn't the same 1/2/4 for every recipe) plus 1/2/4, which sets every recipe, and a "Per recipe" fold with a stepper per recipe. The browser keeps those changes per list (`localStorage`) until the agent changes the plan. Older lists without `servings`/`amounts` open on 4 and scale multi-recipe items by their recipes' average. The no-JS page and `get_shopping_list`'s "To buy" are at the planned servings. Recipe pages keep their own 1/2/4 selector (`templates/servings.js`, opens on 4). The list is one homogenised list: no per-recipe notes, and each `quantity` is a single number in one metric unit (g, ml or a count; tbsp/tsp are converted and added up, and the server rejects kitchen measures). Recipes keep their own units. The top-level `recipes` is filled in by the server with the slugs the list was built from; the page links to those that still exist. Each item's `recipes` is written by the agent: the slugs of the next-week recipes that item is for (the server rejects a slug that isn't in next week, and a next-week recipe no item is for). Its row shows those recipes' photos, and tapping them names the recipes under the row, as links. The page keeps showing the saved list as-is until the agent saves a new one: changing the weeks, the switch included, never alters or deletes it, so after the switch it still shows the list made for what is now this week. It is blank only when there's no `shopping-list.json`. Never hand-edit `shopping-list.json`; go through the tool. Keep `loadShoppingList` in `build.js` and `mcp-server/lib/shopping-list.js` in sync if the format changes (and `parseQuantity` and `neededAmount`, duplicated in `templates/shopping-list.js`, with `need()` in `templates/shopping.js`).

### Stocktake (what's already at home)

The editor taps **Sign in** (top right) or **Update** on the "Home checked" card. A sheet slides up: they enter their email and password. Without a password (or having forgotten it) they tap "No password? Email me a code", get a 6-digit code and type it in (the code works on any device; the same email's magic link still works on the device that opens it). After a code or link sign-in the sheet offers **Set a password** (also in the avatar menu), so later sign-ins send no email: Supabase's built-in mailer only allows a few emails an hour. Once signed in, the page shows two tabs: the list (cart icon, count left to buy) and **At home** (house icon, count at home). On the At home tab every row is a fill bar: sliding across it sets how much is at home, the house button toggles "have it all". Edits stay in the browser (`localStorage`, per list) until **Save**, which POSTs them in one go to the MCP server's `/stocktake` endpoint (`mcp-server/api/stocktake.js`); undo drops the unsaved edits. The endpoint checks the Supabase token and that the email is in `EDITORS` (old name `SHOPPING_EDITORS`, still read), then commits `shopping-list.json` (one commit, one deploy) with:

```json
{ "stocktake": "2026-10-18T10:00:00.000Z",
  "sections": [{ "name": "Fresh produce", "items": [{ "name": "Lemons", "quantity": "4", "have": 2 }, { "name": "Parsley", "have": true }] }] }
```

`have: true` means enough at home (sliding a row all the way saves `true`); a number is the amount at home in the item's own unit. It is an absolute amount, so it isn't rescaled by the servings picker (what's left to buy is the amount the chosen servings need, minus it). The endpoint refuses a stocktake whose items (name + quantity) don't match the stored list (409), so a page loaded before the agent replaced the list can't write onto the new one. A new list from `update_shopping_list` starts without a stocktake. `get_shopping_list` reports what's left to buy and what to skip, which is what the `ocado-shop` and `sainsburys-shop` workflows shop from. Like `plan-recipes`, they're served by the MCP server (sources `mcp-server/workflows/ocado-shop.md` and `sainsburys-shop.md`; the skills only point there). Rules both shops share (what to buy, picking rules, non-negotiables, report back) live once in `mcp-server/workflows/shared/` and are included into each guide, so change a shared rule there, and shop-specific products in the shop's own guide.

For everyone, the list shows only what's left to buy: partly stocked items show the remaining amount with a half-filled house, and fully stocked items fold into "Already at home". Anyone can tick items while shopping; those ticks stay in their own browser (`localStorage`, per list). Until the site redeploys, the saving browser shows its own saved stocktake. The look and the icon language are described in `design.md`.

Setup: Supabase project with email sign-in, sign-ups off, the editor invited as a user, and the whole site (`https://<user>.github.io/<repo>/**`, since the chat signs in from any page and the magic link returns to the page it was sent from) in Auth → URL Configuration → Redirect URLs. Password sign-in needs the Email provider's password option on (the default); the editor sets their password from the page after a first code sign-in. For the code, the Magic Link email template (Auth → Email Templates) must include `{{ .Token }}` (keep `{{ .ConfirmationURL }}` for the link). The Pages build gets `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `STOCKTAKE_API_URL` from the repo's Actions **variables**; without them the page has no sign-in and is read-only. The Vercel project needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `EDITORS` (see `mcp-server/README.md`).

## Deployment

GitHub Actions deploys `dist/` to Pages on every push to `main` (`.github/workflows/deploy.yml`). One-time manual step: in the repo's Settings → Pages, set the source to "GitHub Actions".
