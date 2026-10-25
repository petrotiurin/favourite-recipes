# Our Favourite Recipes

Static GitHub Pages site for the family's favourite recipes. Originally migrated from a Notion database.

## Hard constraint: static first

This site has **no framework, no bundler, and no client-side data fetching** by design — no framework runtime, no build-time CMS calls at request time. Everything is plain HTML/CSS generated at build time from Markdown files checked into this repo. Do not add React/Vue/etc., a bundler, or any JS *dependency* to `dist/` output.

One exception: small, dependency-free vanilla JS is allowed for progressive-enhancement UI (e.g. `templates/search.js`, which does client-side title filtering over the already-rendered recipe list, and `templates/servings.js`, the 1/2/4-servings selector on recipe pages that rescales ingredient quantities tagged at build time by `templates/quantities.js`, and `templates/wakelock.js`, the "Keep screen on" toggle on recipe pages that uses the Screen Wake Lock API while cooking). Rules for that JS:
- No frameworks, no bundler, no npm packages shipped to `dist/` — hand-written vanilla JS only.
- No fetching/loading data at runtime — it must only operate on data already baked into the rendered HTML at build time (DOM already in the page, or a JSON literal the build script embedded).
- It must be optional enhancement: the page's core content (recipe list, recipe pages) must already be fully present and readable with JS disabled: JS only adds interactivity (filtering, search) on top.

One deliberate exception to "no network at runtime": `templates/shopping.js` on the shopping page lets the signed-in editor save a **stocktake** (what's already at home). It signs in with Supabase Auth: email + password, or an email code as the fallback (the same email also carries a magic link; plain `fetch` to its REST API, no client library) and POSTs the stocktake to the MCP server's `/stocktake` endpoint. It still never *loads* the list at runtime: it re-renders from the JSON literal the build embedded. Small, pinned CDN libraries are acceptable if a future feature really needs one, but still no bundler or npm packages in `dist/`.

The only allowed "moving part" beyond that is the Node build script that runs before deploy.

The `mcp-server/` folder is **not part of the site**: it's a separate MCP server deployed to Vercel (see `mcp-server/README.md`) that lets an agent add/edit recipes by committing `recipes/*.md` and `images/recipes/*` to `main`. It never ships anything into `dist/`, and its tools mirror the `add-recipe` skill rules (`mcp-server/lib/recipe-format.js` — keep the two in sync if the format changes).

## UI design

`design.md` is the UI reference: colour tokens (the orange accent, purple only for drafts, no other hues such as green), the house icon language, the shared components and the interaction rules. Read it before changing any page's look or behaviour, and update it in the same change when you add or alter a pattern.

## How new recipes get added

New recipes are added by asking Claude Code, in chat, to add one. **Always use the `add-recipe` skill** (`.claude/skills/add-recipe/SKILL.md`) for this — it has the exact Markdown formatting rules, the ingredient-bolding rule, and the image rules. Don't freehand a recipe file without it.

The other flow is the agent working through the recipes MCP server: **use the `plan-recipes` skill** (`.claude/skills/plan-recipes/SKILL.md`) when the user hands over screenshots, links and/or names of recipes we already have. It first closes out last round (regular current recipes are unmarked; for each leftover draft it asks via `AskUserQuestion` whether it was liked: liked → promoted and unmarked, not liked → removed), then adds the new ones as drafts (photos come from the source link, else the MCP server generates them with OpenRouter; upload links are only a fallback), marks existing ones current, then always builds the shopping list and finishes with a summary. It uses the MCP tools only, never local files, and sends all its writes in one `batch_changes` call: every commit to `main` is a site deploy, so a call per change floods the Pages workflow.

## Directory layout

```
recipes/            source of truth: one .md file per recipe (frontmatter + body)
images/recipes/     source of truth: one hero image per recipe
templates/          JS functions that render HTML strings (layout.js, index.js, recipe.js)
templates/search.js client-side search script, copied verbatim into dist/ (see "Hard constraint" above)
templates/servings.js client-side servings selector, copied verbatim into dist/; quantities.js tags scalable numbers at build time
styles/style.css    the one stylesheet, copied verbatim into dist/
shopping-list.json  combined shopping list for the current recipes, written by the agent via the MCP server (see "Shopping list")
templates/wakelock.js client-side "Keep screen on" toggle (Screen Wake Lock API), copied verbatim into dist/
templates/shopping-list.js  renders shopping-list.html (the list, or a blank page) + the JSON shopping.js works from
templates/shopping.js       shopping page: servings, local ticks, editor sign-in sheet + "At home" tab (stocktake)
design.md           UI design notes: palette tokens, the house icon language, components and interaction rules
build.js            reads recipes/*.md (+ shopping-list.json) -> writes dist/ (index.html, recipes/<slug>.html, shopping-list.html)
dist/               build output — gitignored, never hand-edit, regenerated every build
.github/workflows/deploy.yml   GitHub Actions: builds and deploys dist/ to GitHub Pages on push to main (ignores mcp-server/ changes)
mcp-server/         separate MCP server on Vercel for adding/editing recipes (not part of the site)
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
current: true                      # optional: a regular recipe in the current rotation. Highlighted, sorted after drafts, "Current" badge + filter tab, on the shopping list. Drafts are always current and don't need it.
draft: true                        # optional: not tried yet. Highlighted, sorted first, "Draft" badge + filter tab. Promoting swaps this line for `current: true`.
---
```

New recipes start as drafts (`draft: true`); once the family has cooked one and wants to keep it, it's promoted to a regular recipe (the MCP server's `promote_recipe` tool replaces `draft: true` with `current: true`, so promoting does not change whether the recipe is current). A draft the family didn't like is deleted with the MCP server's `remove_draft` tool (recipe file + photo); it refuses anything that isn't a draft, so regular recipes can't be removed through the server.

**Current recipes** are the ones the family is cooking right now: every draft, plus any regular recipe marked `current: true`. The index (and the MCP's `list_recipes`) orders recipes in three tiers: 1. drafts, 2. other current recipes, 3. everything else (alphabetical within each tier). Promoting a draft keeps it current until it's explicitly unmarked. The MCP server's `set_current_recipes` tool adds/removes `current: true` for existing recipes (agent-driven; drafts can't be toggled, promote first).

Followed by a Markdown body with `## Ingredients` (bulleted, quantities bolded) and `## Instructions` (numbered). See the `add-recipe` skill for the exact rules.

## Shopping list

`shopping-list.html` is a separate page (a "🛒 Shopping list" button in the index header links to it; the list itself is not on the main page). It covers the **current recipes** (drafts and recipes marked `current: true`), and is **not computed by the site**: the agent combines the ingredients of all current recipes and saves the result with the MCP server's `update_shopping_list` tool, which commits `shopping-list.json`:

```json
{ "updated": "2026-10-03", "recipes": ["slug-a", "slug-b"],
  "sections": [{ "name": "Fresh produce", "items": [{ "name": "Red onions", "quantity": "3", "note": "optional", "recipes": ["slug-a", "slug-b"] }] }] }
```

The list is always written for **2 servings of every recipe** (each scaled by 2 / `serves`), and the page has a 1/2/4 servings selector (in `templates/shopping.js`, same scaling as `templates/servings.js` on recipe pages; both open on 4 servings, the shopping page unless the browser remembers another pick) that rescales every `quantity` from that base, so `note` must never contain amounts. The list is one homogenised list: no per-recipe notes, and each `quantity` is a single number in one metric unit (g, ml or a count; tbsp/tsp are converted and added up, and the server rejects kitchen measures). Recipes keep their own units. The top-level `recipes` is filled in by the server with the slugs the list was built from; the page links to those that still exist. Each item's `recipes` is written by the agent: the slugs of the current recipes that item is for (the server rejects a slug that isn't current, and a current recipe no item is for). Its row shows those recipes' photos, and tapping them names the recipes under the row, as links. The page keeps showing the saved list as-is until the agent saves a new one (changing which recipes are current does not alter it), and is blank only when no recipe is current. `set_current_recipes` deletes `shopping-list.json` in the same commit when it unmarks the last current recipe, so an old list can't resurface. Never hand-edit `shopping-list.json`; go through the tool. Keep `loadShoppingList` in `build.js` and `mcp-server/lib/shopping-list.js` in sync if the format changes (and `parseQuantity`, duplicated in `templates/shopping-list.js`).

### Stocktake (what's already at home)

The editor taps **Sign in** (top right) or **Update** on the "Home checked" card. A sheet slides up: they enter their email and password. Without a password (or having forgotten it) they tap "No password? Email me a code", get a 6-digit code and type it in (the code works on any device; the same email's magic link still works on the device that opens it). After a code or link sign-in the sheet offers **Set a password** (also in the avatar menu), so later sign-ins send no email: Supabase's built-in mailer only allows a few emails an hour. Once signed in, the page shows two tabs: the list (cart icon, count left to buy) and **At home** (house icon, count at home). On the At home tab every row is a fill bar: sliding across it sets how much is at home, the house button toggles "have it all". Edits stay in the browser (`localStorage`, per list) until **Save**, which POSTs them in one go to the MCP server's `/stocktake` endpoint (`mcp-server/api/stocktake.js`); undo drops the unsaved edits. The endpoint checks the Supabase token and that the email is in `SHOPPING_EDITORS`, then commits `shopping-list.json` (one commit, one deploy) with:

```json
{ "stocktake": "2026-10-18T10:00:00.000Z",
  "sections": [{ "name": "Fresh produce", "items": [{ "name": "Lemons", "quantity": "4", "have": 2 }, { "name": "Parsley", "have": true }] }] }
```

`have: true` means enough at home (sliding a row all the way saves `true`); a number is the amount at home in the item's own unit. It is an absolute amount, so it isn't rescaled by the servings picker. The endpoint refuses a stocktake whose items (name + quantity) don't match the stored list (409), so a page loaded before the agent replaced the list can't write onto the new one. A new list from `update_shopping_list` starts without a stocktake. `get_shopping_list` reports what's left to buy and what to skip, which is what the `ocado-shop` skill shops from.

For everyone, the list shows only what's left to buy: partly stocked items show the remaining amount with a half-filled house, and fully stocked items fold into "Already at home". Anyone can tick items while shopping; those ticks stay in their own browser (`localStorage`, per list). Until the site redeploys, the saving browser shows its own saved stocktake. The look and the icon language are described in `design.md`.

Setup: Supabase project with email sign-in, sign-ups off, the editor invited as a user, and the shopping page URL in Auth → URL Configuration → Redirect URLs. Password sign-in needs the Email provider's password option on (the default); the editor sets their password from the page after a first code sign-in. For the code, the Magic Link email template (Auth → Email Templates) must include `{{ .Token }}` (keep `{{ .ConfirmationURL }}` for the link). The Pages build gets `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `STOCKTAKE_API_URL` from the repo's Actions **variables**; without them the page has no sign-in and is read-only. The Vercel project needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SHOPPING_EDITORS` (see `mcp-server/README.md`).

## Deployment

GitHub Actions deploys `dist/` to Pages on every push to `main` (`.github/workflows/deploy.yml`). One-time manual step: in the repo's Settings → Pages, set the source to "GitHub Actions".
