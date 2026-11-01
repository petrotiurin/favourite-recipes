<!--
The ocado-shop workflow, served by the recipes MCP server as the `ocado-shop` prompt and by
the get_workflow_guide tool. This file is the single source of truth: the repo skill only points here, so
a server deploy updates the workflow everywhere. Rules shared with the other shops live in workflows/shared/.
-->

# Ocado shop: shopping list → Ocado basket

Browser flow with **Claude in Chrome** (`mcp__claude-in-chrome__*`; load the tools in one ToolSearch call, call `tabs_context_mcp` first, work in your own new tab). The browser is already logged in to Ocado. **Never check out**: stop with the basket filled and tell the user. Don't click "Go to checkout".

<!-- include: shared/what-to-buy -->

**Cooked chicken at Ocado:** the cooked option is the favourites *Ocado British Flame-grilled Chicken Breast Pieces* / *M&S Plain Roasted Chicken Breast Slices*; the raw option is *M&S British Chicken Breast Fillets* (favourites).

## Favourites first (always start here)

Navigate **straight to https://www.ocado.com/favorites** (not search) and match list items against the favourites before searching anything. A favourite that fits the item is bought as-is (no price/rating comparison), unless it breaks a non-negotiable below.

The favourites page is a long virtualised list: scroll it in steps (`window.scrollBy`) to load everything, and collect names, pack sizes and prices as you go. Add items there with the Add button, then the "+" stepper for quantities.

**Unavailable favourites:** a favourite can be out of stock or unavailable for the selected delivery date (the card shows "Out of stock" / "Show alternatives" instead of Add). Then the item falls back to search and the picking rules, and it **must be highlighted in the report** as "favourite unavailable, replaced by X". The non-negotiables still apply: if one of those favourites is unavailable, don't substitute, ask the user.

## Search for the rest

- Use the header search box (type + Enter). Don't navigate by URL query string: `/search?entry=` redirects to a category page; the working URL is `/search?q=...` but it's quicker to type in the box (keeps the SPA, and any JS helpers you injected).
- You don't need to scroll the whole results page: the first two rows of results are enough (scroll down just far enough to see them).
- Pick with the picking rules below.

<!-- include: shared/picking-rules -->

<!-- include: shared/non-negotiables -->

### At Ocado

- **Greek yoghurt**: the favourite *M&S Lactose Free Greek Style Natural Yogurt*.
- **Avocados**: *M&S Collection Perfect Pick Ripe Avocado* (2 per pack, from favourites), not the cheaper loose ones.
- **Chicken**: from favourites only (RSPCA-approved): *M&S British Chicken Breast Fillets* for raw, *Ocado British Flame-grilled Chicken Breast Pieces* or *M&S Plain Roasted Chicken Breast Slices* for cooked. Never swap in a cheaper search result.
- **Pomegranate**: a favourite first, else the cheapest rated whole fruit.
- **Cherry / baby plum tomatoes**: treat either as a match when checking favourites, and take a favourite of either kind before searching.

## Tips that save time (Chrome tool quirks)

- Use `browser_batch` to chain search → wait → read → add for several items in one call.
- Product cards are `[data-test^="fop-wrapper"]`; the title link is `[data-test="fop-product-link"]`; the "Add" button becomes a stepper with `button[data-test="counter:increment"]` / `counter:decrement`. Ratings are in the card text as `Rating, 3.6 out of 5 from 490 reviews`. A small injected JS helper that lists name | pack size | price | rating for the first ~10 cards, and one that adds N of a named product, makes this fast.
- Favourites cards show no star rating: that's fine, favourites skip the cutoff.
- Long `javascript_tool` loops time out (~45s) but keep running in the page: run long loops un-awaited, store results on `window`, and poll. Don't re-run a loop that may still be running, or you'll double-add (check quantities and decrement if so).
- The basket page is https://www.ocado.com/basket ("View trolley" button in the trolley drawer, not "Go to checkout").

<!-- include: shared/report-back -->

At Ocado, close with the trolley item count and total.
