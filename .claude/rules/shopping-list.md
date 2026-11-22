---
paths:
  - "shopping-list.json"
  - "data/ingredients.json"
  - "src/islands/Shopping.tsx"
  - "src/lib/shopping-state.ts"
  - "src/lib/auth.ts"
  - "shared/shopping-quantity.ts"
  - "src/pages/shopping-list.astro"
  - "src/lib/shopping.ts"
  - "mcp-server/lib/shopping-list.ts"
  - "mcp-server/lib/catalogue.ts"
  - "mcp-server/api/stocktake.ts"
  - "mcp-server/workflows/**"
---

# The shopping list

`shopping-list.html` is a separate page (a "🛒 Shopping list" button in the index header links to it; the list itself is not on the main page). It covers **next week's recipes** (`next: true`) only, and is **not computed by the site** but by the MCP server: `update_shopping_list` with `build: true` (`buildShoppingList` in `mcp-server/lib/shopping-list.ts`) adds up next week's recipes from their structured ingredients and the catalogue (each amount converted to the item's shopping unit, scaled to 2 servings, totalled per item with each recipe's share) and commits `shopping-list.json`. The agent only reviews it, with patches on the same call (`edits`: `round_up`, `merge`, `note`, `move`, `rename`, `drop`, `scale`, by catalogue item id), after the server flags what needs judgement; items only optional ingredients need are marked `note: "optional"` and the user is asked once which to leave off. (`sections`, a list the agent combined itself, is also accepted.)

```json
{ "updated": "2026-10-03", "recipes": ["slug-a", "slug-b"], "servings": { "slug-a": 4, "slug-b": 1 },
  "sections": [{ "name": "Fresh produce", "items": [{ "name": "Red onions", "quantity": "3", "note": "optional", "recipes": ["slug-a", "slug-b"], "amounts": { "slug-a": 2, "slug-b": 1 } }] }] }
```

The list is always written for **2 servings of every recipe** (each scaled by 2 / `serves`), so `note` must never contain amounts. An item for several recipes also carries `amounts`: each recipe's share of that 2-serving `quantity` (same unit, adding up to it; the server refuses a multi-recipe item without it). Items for several recipes carry `amounts` for every recipe that measures them (one that only seasons it "to taste" has none). `servings` is the **plan**: how many people each recipe is cooked for this round, set by the agent (`update_shopping_list`'s `servings`, or `set_shopping_servings` to change only the plan, which keeps the items and the stocktake). A recipe the agent doesn't name keeps the previous list's plan, else 4. The page (`src/islands/Shopping.tsx`) opens on the plan and scales each recipe's share by its own servings / 2; the servings card offers "Plan" (shown only when the plan isn't the same 1/2/4 for every recipe) plus 1/2/4, which sets every recipe, and a "Per recipe" fold with a stepper per recipe. The browser keeps those changes per list (`localStorage`) until the agent changes the plan. Lists without `servings`/`amounts` open on 4 and scale multi-recipe items by their recipes' average. The page as the build writes it and `get_shopping_list`'s "To buy" are at the planned servings. The list is one homogenised list: no per-recipe notes, and each `quantity` is a single number in one metric unit (g, ml or a count; tbsp/tsp are converted and added up, and the server rejects kitchen measures). Recipes keep their own units. The top-level `recipes` is filled in by the server with the slugs the list was built from; the page links to those that still exist. Each item's `recipes` is written by the agent: the slugs of the next-week recipes that item is for (the server rejects a slug that isn't in next week, and a next-week recipe no item is for). Its row shows those recipes' photos, and tapping them names the recipes under the row, as links. The page keeps showing the saved list as-is until the agent saves a new one: changing the weeks, the switch included, never alters or deletes it, so after the switch it still shows the list made for what is now this week. It is blank only when there's no `shopping-list.json`. Never hand-edit `shopping-list.json`; go through the tool.

## Stocktake (what's already at home)

The shopping island (`src/islands/Shopping.tsx`) lets the signed-in editor save a stocktake. It signs in through the store in `src/lib/auth.ts` (Supabase Auth: email + password, or an email code as the fallback; the same email also carries a magic link; plain `fetch` to its REST API, no client library). The page is drawn once, at build time, from the saved list (the island's props), and the island takes that markup over in the browser; it never *loads* the list at runtime.

The editor taps **Sign in** (top right) or **Update** on the "Home checked" card. A sheet slides up: they enter their email and password. Without a password (or having forgotten it) they tap "No password? Email me a code", get a 6-digit code and type it in (the code works on any device; the same email's magic link still works on the device that opens it). After a code or link sign-in the sheet offers **Set a password** (also in the avatar menu), so later sign-ins send no email: Supabase's built-in mailer only allows a few emails an hour. Once signed in, the page shows two tabs: the list (cart icon, count left to buy) and **At home** (house icon, count at home). On the At home tab every row is a fill bar: sliding across it sets how much is at home, the house button toggles "have it all". Edits stay in the browser (`localStorage`, per list) until **Save**, which POSTs them in one go to the MCP server's `/stocktake` endpoint (`mcp-server/api/stocktake.ts`); undo drops the unsaved edits. The endpoint checks the Supabase token and that the email is in `EDITORS` (or its old name `SHOPPING_EDITORS`), then commits `shopping-list.json` (one commit, one deploy) with:

```json
{ "stocktake": "2026-10-18T10:00:00.000Z",
  "sections": [{ "name": "Fresh produce", "items": [{ "name": "Lemons", "quantity": "4", "have": 2 }, { "name": "Parsley", "have": true }] }] }
```

`have: true` means enough at home (sliding a row all the way saves `true`); a number is the amount at home in the item's own unit. It is an absolute amount, so it isn't rescaled by the servings picker (what's left to buy is the amount the chosen servings need, minus it). The endpoint refuses a stocktake whose items (name + quantity) don't match the stored list (409), so a page loaded before the agent replaced the list can't write onto the new one. A new list from `update_shopping_list` starts without a stocktake. `get_shopping_list` reports what's left to buy and what to skip, which is what the `ocado-shop` and `sainsburys-shop` workflows shop from.

For everyone, the list shows only what's left to buy: partly stocked items show the remaining amount with a half-filled house, and fully stocked items fold into "Already at home". Anyone can tick items while shopping; those ticks stay in their own browser (`localStorage`, per list). Until the site redeploys, the saving browser shows its own saved stocktake. The look and the icon language are described in `design.md`. Setting up sign-in (Supabase, the Actions variables) is in `mcp-server/README.md` → "Setup".
