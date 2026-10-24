---
name: ocado-shop
description: Fill the Ocado basket from the site's shopping list (or a list the user pastes/screenshots) using Claude in Chrome. Uses the Ocado favourites page first, then search, applies the family's star-rating cutoff and non-negotiable product preferences, and never checks out. Use whenever the user asks to "shop at Ocado", "order the shopping list" or "add the list to the basket".
---

# Ocado shop: shopping list → Ocado basket

Browser flow with **Claude in Chrome** (`mcp__claude-in-chrome__*`; load the tools in one ToolSearch call, call `tabs_context_mcp` first, work in your own new tab). The browser is already logged in to Ocado. **Never check out**: stop with the basket filled and tell the user. Don't click "Go to checkout".

## 1. Work out what to buy

- Source: **`get_shopping_list` from the recipes MCP server, by default.** When a stocktake is saved, its "To buy" section is the list: items marked at home are already taken off, and partly stocked items show only the amount left to buy (e.g. "Lemons: 2 [have 2 of 4]" means buy 2). Skip everything under "Already at home". If it says no stocktake is saved, everything on the list is to buy; mention that in the summary in case the user forgot to do one.
- Use a screenshot/paste of `shopping-list.html` only if the user gives one instead. Then **skip anything crossed out / ticked** in it: those are already at home.
- `get_shopping_list` amounts are the 2-serving base, but the site and the user shop for **4 servings by default**: double every amount (to-buy and counts, e.g. 4 eggs + 1 yolk → 8 + 2) before converting to packs, unless the user asks for 2. Stocktake "have" amounts are absolute, not doubled.
- Quantities on the user's screenshot may be at 4 servings (the page's selector); use the amounts they show, not the stored 2-serving base.
- If a line is cut off in a screenshot, look it up in `get_shopping_list` (the quantities there are the 2-serving base, so double it if the screenshot is at 4).
- Add the user's extra items on top (e.g. "also 2 more avocados"). Extras go through the same rules.
- Convert amounts to packs: round **up** to whole packs, buy the exact count for counted items (e.g. 6 limes = 3 twin packs, 24 gyoza = 2 packs of 12).
- **Cooked chicken: ask before buying.** If the to-buy list has cooked chicken (e.g. "Cooked chicken breast"), find which current recipes use it (`get_recipe` on each current recipe from `get_shopping_list`) and, with `AskUserQuestion`, list those recipes with the total amount (at the servings being shopped) and ask: buy it cooked (favourites: Ocado Flame-grilled Chicken Breast Pieces / M&S Plain Roasted Chicken Breast Slices), or buy raw chicken breast instead (M&S British Chicken Breast Fillets, favourites; cook it yourself, raw weight ≈ cooked weight ÷ 0.75, rounded up to whole packs)? Cooked is rarely economical in large quantities, so mention the price of both options when you ask. Do this before adding anything to the basket, and carry the answer into the summary.

## 2. Favourites first (always start here)

Navigate **straight to https://www.ocado.com/favorites** (not search) and match list items against the favourites before searching anything. A favourite that fits the item is bought as-is (no price/rating comparison), unless it breaks a non-negotiable below.

The favourites page is a long virtualised list: scroll it in steps (`window.scrollBy`) to load everything, and collect names, pack sizes and prices as you go. Add items there with the Add button, then the "+" stepper for quantities.

**Unavailable favourites:** a favourite can be out of stock or unavailable for the selected delivery date (the card shows "Out of stock" / "Show alternatives" instead of Add). Then the item falls back to the regular search flow below (cheapest per quantity, 3★ cutoff), and it **must be highlighted in the final summary** as "favourite unavailable, replaced by X". The non-negotiables in section 4 still apply: if one of those favourites is unavailable, don't substitute, ask the user.

## 3. Search for the rest

- Use the header search box (type + Enter). Don't navigate by URL query string: `/search?entry=` redirects to a category page; the working URL is `/search?q=...` but it's quicker to type in the box (keeps the SPA, and any JS helpers you injected).
- **Pick the cheapest suitable option, unless it is rated 3 stars or less** (3.0★ counts as "3 or less"; 3.1★+ is fine). Then take the next cheapest above 3★. Unrated products (0 reviews) are not "cheap and fine": avoid unless nothing else fits.
- **"Cheapest" = cheapest per quantity** (per kg / per litre / per item, as shown on the card), not the lowest sticker price. Compare on the unit price, and the right form (raw rice for "brown rice", not microwave pouches).
- You don't need to scroll the whole results page: the first two rows of results are enough (scroll down just far enough to see them).
- **Stick to the required quantity, don't buy in bulk.** Among the options, restrict to pack sizes close to what the list needs (e.g. need 250g chicken → look at 250-400g packs, not the 1kg one), then take the best unit price among those. If the cheapest unit price is a much bigger pack and the saving is large, still add the small pack, but **flag it in the final summary** (item, pack size, price, bigger option and its price) so the user can reconsider.
- Prefer the item the recipe means over a lookalike (whole vs sliced is acceptable when it is the cheapest well-rated jar; say so in the summary).

## 4. Non-negotiable preferences (override cheapest/favourite rules)

- **Greek yoghurt: lactose-free only** (the favourite *M&S Lactose Free Greek Style Natural Yogurt*).
- **Avocados: M&S Collection avocados** (*M&S Collection Perfect Pick Ripe Avocado*, 2 per pack, from favourites), not the cheaper loose ones.
- **Chicken: from favourites only** (RSPCA-approved): *M&S British Chicken Breast Fillets* for raw, *Ocado British Flame-grilled Chicken Breast Pieces* or *M&S Plain Roasted Chicken Breast Slices* for cooked. Never swap in a cheaper search result.

If a non-negotiable is out of stock, don't substitute: tell the user.

## 5. Tips that save time (Chrome tool quirks)

- Use `browser_batch` to chain search → wait → read → add for several items in one call.
- Product cards are `[data-test^="fop-wrapper"]`; the title link is `[data-test="fop-product-link"]`; the "Add" button becomes a stepper with `button[data-test="counter:increment"]` / `counter:decrement`. Ratings are in the card text as `Rating, 3.6 out of 5 from 490 reviews`. A small injected JS helper that lists name | pack size | price | rating for the first ~10 cards, and one that adds N of a named product, makes this fast.
- Favourites cards show no star rating: that's fine, favourites skip the cutoff.
- Long `javascript_tool` loops time out (~45s) but keep running in the page: run long loops un-awaited, store results on `window`, and poll. Don't re-run a loop that may still be running, or you'll double-add (check quantities and decrement if so).
- Read the result with `get_page_text` on https://www.ocado.com/basket ("View trolley" button in the trolley drawer, not "Go to checkout"). Check quantities, no duplicates, nothing missing.

## 6. Report back

Keep it short. **Do not list the items added**: the user checks the basket themselves. Only list what needs their attention:
- Judgment calls and deviations from the list: unverified pack counts (e.g. taco count), tiny packs, whole-vs-sliced, substitutions, items assumed from a cut-off line, anything skipped or out of stock.
- Small overages that forced an extra pack: items where the need was only slightly over a whole number of packs, so rounding up added a whole extra pack (e.g. Greek yoghurt: 470g needed vs a 450g pack, so 2 packs). Adding the extra pack is fine, but list item, need, pack size and count so the user can decide to drop it.
- Favourites that were unavailable and what replaced them (flagged separately, so the user can decide whether they're happy with the replacement).
- A "bulk was much cheaper" list: items where a bigger pack had a much better unit price than the small one you added (item, pack added + price, bigger pack + price).

End with the trolley item count and total, and that nothing was checked out.
