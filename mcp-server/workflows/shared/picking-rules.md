<!--
Shared by every shop workflow (ocado-shop, sainsburys-shop): included where a guide has an `include: shared/picking-rules` marker.
-->

## Picking rules

For every item not covered by a favourite or a non-negotiable:
- **Cheapest per quantity** (per kg / per litre / per item, the unit price the shop shows), not the lowest sticker price.
- **Rated above 3.0★**: skip anything rated 3.0★ or less and take the next cheapest (3.1★+ is fine). Unrated products (0 reviews) only when nothing else fits.
- **No bulk: stick to the quantity needed.** Look only at pack sizes close to the need (need 250g chicken → 250-400g packs, not the 1kg one), then take the best unit price among those. If a much bigger pack is far cheaper per unit, still add the small pack, and flag it in the report.
- **The right form**: what the recipe means, not a lookalike (raw rice for "brown rice", not microwave pouches). Whole vs sliced is fine when it's the cheapest well-rated option; say so in the report.
- **Multibuy offers** ("3 for £5"): only when you'd buy that many anyway; never buy extra to hit one. Mention any you used.
- **Loose produce** priced per kg: prefer packs or items priced "each". Per-kg only with an estimated weight, and say so.
- **Unavailable / out of stock** for the delivery slot: take the next-best pick by these rules, and flag it in the report.
