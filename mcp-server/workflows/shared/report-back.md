<!--
Shared by every shop workflow (ocado-shop, sainsburys-shop): included where a guide has an `include: shared/report-back` marker.
Each shop guide adds its own closing line (totals, slot) after it.
-->

## Report back

First read the basket/trolley page (`get_page_text`): check quantities, no duplicates, nothing missing.

Keep it short. **Don't list the items added**: the user checks the basket themselves. Only what needs their attention:
- **Judgment calls and deviations**: substitutions, whole-vs-sliced, unverified pack counts, tiny packs, items assumed from a cut-off line, per-kg estimates, optional / "to serve" items bought, multibuys used, non-negotiables bought below the star cutoff, anything skipped or out of stock.
- **Unavailable picks** (favourites included) and what replaced them, flagged separately so the user can decide.
- **Small overages that forced an extra pack**: the need was only slightly over a whole number of packs (e.g. Greek yoghurt: 470g needed vs a 450g pack, so 2 packs). Fine to add; list item, need, pack size and count so the user can drop it.
- **"Bulk was much cheaper"**: items where a bigger pack had a much better unit price than the one added (item, pack added + price, bigger pack + price).
- Skipped pantry shortfalls (one line), the cooked-chicken decision, and "no stocktake saved" if so.

End with the item count and total, and that nothing was checked out.
