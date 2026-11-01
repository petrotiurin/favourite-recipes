<!--
Shared by every shop workflow (ocado-shop, sainsburys-shop): included where a guide has an `include: shared/what-to-buy` marker.
Shop-specific product names go in the shop's own guide, not here.
-->

## What to buy

- Source: **`get_shopping_list` from the recipes MCP server, by default.** With a stocktake, its "To buy" section is the list: items marked at home are already taken off, and partly stocked items show only the amount left to buy (e.g. "Lemons: 2 [have 2 of 4]" means buy 2). Skip everything under "Already at home". If it says no stocktake is saved, everything on the list is to buy; mention that in the report in case the user forgot to do one.
- "To buy" amounts are already at the **planned servings** (each recipe's own number, listed under "Planned servings"; 4 unless the agent planned otherwise), minus the stocktake. Shop those amounts as they are. Only if the user asks for different servings ("just 2 of everything"), rescale: the stored list JSON is the 2-serving base, and an item's `amounts` split it per recipe. Stocktake "have" amounts are absolute, never rescaled.
- Use a screenshot/paste of `shopping-list.html` only if the user gives one instead: use the amounts it shows (at whatever servings the page was on) and **skip anything ticked / crossed out** (already at home). A cut-off line: look it up in `get_shopping_list` (ask if the screenshot clearly used other servings).
- Add the user's extras on top (e.g. "also 2 more avocados"); they go through the same rules.
- **Partly stocked pantry basics** (oils, vinegars, spices, dried herbs, honey, sauces and pastes, stock, flour, sugar, tinned tomatoes/purée) with a small shortfall left: skip them and list them in one line in the report ("check you have enough"). Fresh items with a shortfall: buy.
- Convert amounts to packs: round **up** to whole packs, the exact count for counted items (e.g. 6 limes = 3 twin packs, 24 gyoza = 2 packs of 12). Fractional packs ("Coriander: 0.5 pack") round up to 1.
- **Items without an amount** ("Pesto (to serve)", "Jalapeños (jar)"): one of the smallest normal pack. **Optional items** ("optional, to serve"): buy them, and list them in the report so the user can drop them.
- **Extracts and spices on the list as a full need** (not a partly stocked shortfall): the smallest bottle/jar.
- **Cooked chicken: ask before buying.** If "To buy" has cooked chicken, find which current recipes use it (`get_recipe` on the current recipes) and, with `AskUserQuestion`, list them with the total amount and ask: buy it cooked (the shop's higher-welfare cooked product, see the non-negotiables), or raw breast instead (cook it yourself; raw weight ≈ cooked weight ÷ 0.75, rounded up to whole packs)? Cooked is rarely economical in large amounts, so give the price of both. Do this before adding anything. If the shop has no higher-welfare cooked product, or you can't ask (running unattended), take the raw breast and say so in the report, with the recipes that need it cooked.
