<!--
The ocado-shop workflow, served by the recipes MCP server as the `ocado-shop` prompt and by
the get_workflow_guide tool. This file is the single source of truth: the repo skill only points here, so
a server deploy updates the workflow everywhere. Rules shared with the other shops live in workflows/shared/.
-->

# Ocado shop: shopping list → Ocado basket

Browser flow with **Claude in Chrome** (`mcp__claude-in-chrome__*`; load the tools in one ToolSearch call, call `tabs_context_mcp` first, work in your own new tab). The browser is already logged in to Ocado. **Never check out**: stop with the basket filled and tell the user. Don't click "Go to checkout".

<!-- include: shared/what-to-buy -->

**Cooked chicken at Ocado:** the cooked option is the favourites *Ocado British Flame-grilled Chicken Breast Pieces* / *M&S Plain Roasted Chicken Breast Slices*; the raw option is *M&S British Chicken Breast Fillets* (favourites).

## Favourites first (always start here, and it is enforced)

Navigate **straight to https://www.ocado.com/favorites** (not search) and match list items against the favourites before searching anything. A favourite that fits the item is bought as-is (no price/rating comparison), unless it breaks a non-negotiable below. Past mistake: picks made from a half-read favourites list (cod, strawberries, panko were favourites but got bought from search). So the inventory below is a hard gate, not a tip.

**Before step 1: close any popup.** The favourites page can open with a modal/popup over it (it throws the scrape off: the list behind it may not load or scroll). Take a screenshot first; if there is a popup, click its close button (X / "Close" / "No thanks"), then confirm it is gone and the product cards are visible before scraping. Same for the trolley and search pages. Choose the least-committal option on cookie/consent banners (decline non-essential).

**Step 1: load the whole favourites list into `window.favs`.** The page is a long virtualised list, so scroll it in steps and collect every card's name until the count stops growing for several steps (this helper runs un-awaited; poll `window.favDone`):

```js
window.favs = {}; window.favDone = false;
(async () => { let last = -1, same = 0;
  for (let i = 0; i < 150 && same < 5; i++) {
    document.querySelectorAll('[data-test^="fop-wrapper"]').forEach(c => {
      const n = c.querySelector('[data-test="fop-product-link"]')?.innerText.trim();
      if (n) window.favs[n] = 1; });
    const k = Object.keys(window.favs).length; same = k === last ? same + 1 : 0; last = k;
    window.scrollBy(0, 900); await new Promise(r => setTimeout(r, 500)); }
  window.favDone = true; })();
```

Scroll back to the top and run it a second time: the two counts must match. Tool output is cut at ~800 characters and the page may block some strings, so never print the whole list: read it back in slices (`Object.keys(window.favs).slice(0, 40).join(' ; ')`, then 40-80, ...) until you have seen **every** name, and say the count (e.g. "188 favourites loaded").

**Step 2: a decision table before anything is added.** For EVERY "To buy" item, search the full inventory by keyword (e.g. `Object.keys(window.favs).filter(n => /cod|haddock|fish/i.test(n))`, with the item's synonyms: strawberr, panko|breadcrumb, chia, cheddar...) and write down one line per item: `item → favourite "X"` or `item → no favourite (keywords tried: ...)`. Only items with "no favourite" may go to search. Do the table in your reply to yourself before the first Add; never decide a favourite doesn't exist from a truncated or partly seen list.

**Step 3: favourites cards win on search too.** If a search result card carries "In your Favourites", it is a favourite: buy it as-is, as above.

**Step 4: the report must show the gate was passed**: first line "Favourites checked: N loaded, every list item matched against them", and name which items came from favourites vs search only when the user needs to know (unavailable favourites, as below).

Add items on the favourites page with the Add button, then the "+" stepper for quantities.

**Unavailable favourites:** a favourite can be out of stock or unavailable for the selected delivery date (the card shows "Out of stock" / "Show alternatives" instead of Add). Then the item falls back to search and the picking rules, and it **must be highlighted in the report** as "favourite unavailable, replaced by X". The non-negotiables still apply: if one of those favourites is unavailable, don't substitute, ask the user.

## Search for the rest

- Use the header search box (type + Enter). Don't navigate by URL query string: `/search?entry=` redirects to a category page; the working URL is `/search?q=...` but it's quicker to type in the box (keeps the SPA, and any JS helpers you injected).
- You don't need to scroll the whole results page, but you MUST read the first **two full rows** (at least 8-10 cards) and compare every one of them: the cheaper rated option is often in the second row (e.g. chia seeds), so never stop at the first acceptable card. A helper that fetches `/search?q=...` (server-rendered), parses the cards with `DOMParser` and lists name | unit price | price | rating | pack size for the first ~10 distinct cards makes this quick; an iframe on the same origin lets you click Add without navigating.
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
