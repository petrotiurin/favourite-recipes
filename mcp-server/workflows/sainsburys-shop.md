<!--
The sainsburys-shop workflow, served by the recipes MCP server as the `sainsburys-shop` prompt and by
the get_workflow_guide tool. This file is the single source of truth: the repo skill only points here, so
a server deploy updates the workflow everywhere. Keep it in step with get_shopping_list's output.
-->

# Sainsbury's shop: shopping list → Sainsbury's trolley

Browser flow with **Claude in Chrome** (`mcp__claude-in-chrome__*`; load the tools in one ToolSearch call incl. `javascript_tool`, `get_page_text`, `browser_batch`, `find`; call `tabs_context_mcp` first, work in your own new tab, close it at the end). The browser is already logged in to Sainsbury's with the Nectar card linked. **Never check out**: stop with the trolley filled and tell the user. Don't click "Checkout".

## Check the session

Open https://www.sainsburys.co.uk/gol-ui/groceries. The header shows "My Account" and the booked slot (e.g. "Tue 3rd, 7:00pm–11:00pm") when logged in. If it shows "Log in" / "Register", stop and ask the user to log in themselves (never enter credentials). No slot booked: carry on (prices and stock are still shown), and say so in the report; a reserved slot expires after about 2 hours, so mention the reservation time shown on the trolley page.

Then open https://www.sainsburys.co.uk/gol-ui/trolley, wait ~3s (it hydrates slowly; `get_page_text` right after navigating returns only the nav) and look for "Empty trolley" or "My trolley (N items)". If it isn't empty, ask the user whether to keep those items before adding anything (running unattended: stop and report what's in it).

<!-- include: shared/what-to-buy -->

**Cooked chicken at Sainsbury's:** there is no approved cooked chicken, so buy the raw breast from the two approved packs below without asking (e.g. 1060g cooked → ~1.41kg raw → 2 × 590g + 1 × 310g).

## Favourites

Skipped for now: the Sainsbury's favourites (https://www.sainsburys.co.uk/groceries/favourites) aren't curated yet. Go straight to search.

## Search and pick

Inject the helper (bottom of this guide, verbatim) with `javascript_tool` on any sainsburys.co.uk page. It searches Sainsbury's product API with `fetch` (same data as the site, priced for this account), so no page navigation is needed until adding. Navigation wipes it: do all searching on one page.

**Reading output:** the Chrome tool blocks long `javascript_tool` results (`[BLOCKED: Cookie/query string data]`). The helpers render into the page as plain text and return a short string; read it with `get_page_text`.

- Start `S.searchAll(queries)` **without awaiting it**, poll `S.progress()`, then `S.show(0, 12)` + `get_page_text`, `S.show(12, 12)`… and pick for every item in one pass. Re-search misfits with a better query via `S.one(query)`.
- **Queries**: one per item, including the form ("loose lemons", "red onions x3", "lactose free greek yoghurt", "tuna chunks in spring water", "brown rice 500g", "garlic bulb", "chickpeas in water 400g", "halloumi cheese", "flaked almonds 100g"). One-word queries pull in juice, washing-up liquid and ready meals ("pomegranate" works: the whole fruit comes first).
- Each row: `uid | name | price | unit price | ★ (reviews) | WEIGHED ranges | OFFER multibuy | UNAVAILABLE`. Pack size is in the name.
- **Prices are Nectar prices.** The card is linked, so the price shown is what we pay; "(Nectar, was £X)" marks a Nectar saving. Compare on these prices.
- `UNAVAILABLE` products are out for the booked slot.
- Pick with the picking rules below. Own-label ratings are shared across sizes.
- **WEIGHED (catchweight) products** ("Approx. 310g", mostly meat and fish): the price is for the smallest weight range (e.g. "200g - 340g £7.14"), you're charged by actual weight, and the product page adds that smallest range by default. Need more → add more packs (not a bigger range); say in the report that the price is approximate.

<!-- include: shared/picking-rules -->

<!-- include: shared/non-negotiables -->

### At Sainsbury's

- **Greek yoghurt**: Sainsbury's Lactose Free Greek Style Yogurt 450g, or Arla Lacto Free Greek Style if cheaper per kg.
- **Avocados**: Sainsbury's "Ripe & Ready" or "Perfectly Ripe, Taste the Difference", not "ripen at home" ones.
- **Chicken**: only these two RSPCA-approved products, nothing else (not other Taste the Difference chicken, not cooked or ready-made chicken): *Sainsbury's 2 British Free Range Chicken Breast Fillets, Taste the Difference (Approx. 310g)* (uid 17091, slug `sainsburys-2-british-free-range-chicken-breast-fillets-taste-the-difference-approx-310g`) and *Sainsbury's (Approx. 590g) British Free Range Chicken Breast Fillets, Taste the Difference* (uid 6317536, slug `sainsburys-approx-590g-british-free-range-chicken-breast-fillets-taste-the-difference`); both £21/kg, so mix them to get closest to the need (e.g. ~900g = 590g + 310g, ~1.2kg = 2 × 590g). There is no 1kg pack. Sainsbury's standard chicken (the "British Fresh Skinless & Boneless" packs) is not higher welfare: never buy it. These packs are rated ~2.6★: the usual pick, don't flag the rating.
- **Pomegranate**: "Sainsbury's Pomegranate Single".
- **Halloumi** (not a non-negotiable, but Sainsbury's has no standard own-label plain halloumi): *Sainsbury's Lighter Cypriot Cheese 225g*, or *Taste the Difference Cypriot Halloumi 250g* if that's unavailable; say which in the report.
- **Cherry / baby plum tomatoes**: the cheaper well-rated of either.

## Add to the trolley

Adding goes through the page's own Add button (it's a Next.js server action, not a REST call), one product page per product.

1. Record the picks: `S.plan([{ item: 'Red onions', need: '6', uid: '438506', qty: 2 }, …])`. It renders the plan with an estimated total and, at the bottom, every product URL to open (read it all with `get_page_text`; check every to-buy item is there once, no "NOT CACHED" lines). It saves the plan to `localStorage` for the add snippet.
2. **Once**, store the add snippet (below) in `localStorage`: paste it as `javascript_tool` text with the leading `await ` and the trailing `()` removed, wrapped as `localStorage.Ssnip = '(' + (<snippet's async arrow function>).toString() + ')()'; 'stored'` (the snippet has backticks, so don't wrap it in a template string). From then on each product page only needs `await eval(localStorage.Ssnip)` (keep the `await`, or the tool returns `{}`).
3. For each product, chain in **one `browser_batch`** (12-14 products per batch): `navigate` to the product URL from the plan, then `javascript_tool` with `await eval(localStorage.Ssnip)`. The snippet finds the page's product in the plan, clicks Add and steps the quantity up to the planned count. It **sets** the quantity, so re-running it on a page never double-adds.
4. Read the log: `localStorage.Slog` (one line per product: `OK 2/2 …`, `SHORT`, `NO ADD BUTTON (unavailable?)`, `ADD FAILED`). Re-run the snippet for any failures; an unavailable product falls back to the next-best pick. Long `javascript_tool` results get truncated after ~24 lines: read long logs in slices (`JSON.parse(localStorage.Slog).slice(0, 20)`, then `.slice(20)`).
5. The trolley subtotal should equal the `S.plan` estimate exactly (weighed items are charged at the smallest-range price until picking). A mismatch means a wrong or duplicate add: find it on the trolley page.

Add snippet (the code to store as `Ssnip`; it is also valid pasted directly as `javascript_tool` text):

```js
await (async () => {
  const plan = JSON.parse(localStorage.getItem('Splan') || '[]'), log = JSON.parse(localStorage.getItem('Slog') || '[]');
  const slug = location.pathname.split('/product/')[1], entry = plan.find(p => p[0] === slug);
  const done = msg => { log.push(msg); localStorage.setItem('Slog', JSON.stringify(log)); return msg; };
  if (!entry) return done(`NOT IN PLAN: ${slug}`);
  const [, qty, name] = entry, wait = ms => new Promise(r => setTimeout(r, ms));
  const mine = b => !b.closest('[data-testid="gw-product-card"]') && b.offsetParent; // main product, not the carousels
  const inc = () => [...document.querySelectorAll('button')].filter(mine).find(b => /^Increase Value By 1/.test(b.textContent.trim()));
  const now = () => +(inc()?.textContent.match(/(\d+)\s*$/)?.[1] || 0);
  for (let i = 0; i < 10 && !document.querySelector('[data-testid="gw-add-to-basket"]') && !inc(); i++) await wait(500);
  if (!inc()) {
    const add = [...document.querySelectorAll('[data-testid="gw-add-to-basket"]')].find(mine);
    if (!add) return done(`NO ADD BUTTON (unavailable?): ${name}`);
    add.click();
    for (let i = 0; i < 12 && !inc(); i++) await wait(500);
    if (!inc()) return done(`ADD FAILED: ${name}`);
  }
  while (now() < qty) { // sets the quantity, so re-running never double-adds
    const q = now(); inc().click();
    for (let i = 0; i < 12 && now() === q; i++) await wait(400);
    if (now() === q) break;
  }
  return done(`${now() === qty ? 'OK' : now() > qty ? 'MORE THAN PLANNED' : 'SHORT'} ${now()}/${qty} ${name}`);
})()
```

## Tips (site and tool quirks)

- `/gol-ui/...` URLs redirect to `/groceries/...`; both work. Search page: `/gol-ui/SearchResults/<query>`. Trolley: https://www.sainsburys.co.uk/gol-ui/trolley.
- Header trolley button: `[data-testid="gw-trolley-button"]` (on product pages; not always present on the home page), its `aria-label` reads "Trolley, 3 items, £9.24", total incl. delivery. The delivery fee depends on the slot and the basket size (£7.50 under the £25 minimum, e.g. £1.00 on a full shop).
- Product cards: `[data-testid="gw-product-card"]`, name `gw-product-name`, rating `gw-product-rating` ("4.6/5(409)"), Add `gw-add-to-basket`. After Add, the button becomes a stepper whose buttons read "Decrease Value By 1, <qty>" / "Increase Value By 1, <qty>".
- **Don't decrement the last item in the trolley to 0**: it opens an "empty your trolley?" dialog. To fix a quantity, use the trolley page's stepper / "Remove" on that line, and never confirm "Empty trolley" unless the trolley holds only items you added this run.
- Every line has "Allow substitute" ticked by default; leave it.
- `S.search` uses `sort_order=FAVOURITES_FIRST`: once the favourites are curated, they'll come first in results (a favourites-first step can then be added before search).

<!-- include: shared/report-back -->

At Sainsbury's, also report weighed (approximate) prices, and close with the trolley item count, the subtotal and Nectar savings ("You're saving £X"), whether it's above the £25 minimum, the slot and its reservation expiry.

## Helper (paste verbatim into `javascript_tool` on any sainsburys.co.uk page)

```js
window.S = {
  cache: {}, // product_uid -> row
  api: '/groceries-api/gol-services/product/v1/product',
  render(text) { document.body.innerHTML = ''; const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = text; document.body.appendChild(pre); },
  row(p) {
    // catchweight (weighed, "Approx. 310g") products price per weight range instead of per pack
    const cw = p.catchweight?.[0], u = p.unit_price || cw?.unit_price || {}, ou = p.original_unit_price, promos = p.promotions || [];
    const n = promos.find(x => x.is_nectar), price = p.retail_price?.price ?? cw?.retail_price?.price;
    const nectar = !!n && n.original_price > price; // a Nectar badge with no saving is ignored
    return S.cache[p.product_uid] = {
      uid: p.product_uid, name: p.name, slug: (p.full_url || '').split('/product/')[1] || '',
      price, // what you pay with the linked Nectar card
      nectar, was: nectar ? n.original_price : null,
      unit: u.price != null ? `£${u.price.toFixed(2)}/${u.measure_amount > 1 ? u.measure_amount : ''}${u.measure}` : '',
      wasUnit: nectar && ou ? `£${ou.price.toFixed(2)}/${ou.measure}` : '',
      cw: cw ? p.catchweight.map(c => `${c.range} £${c.retail_price.price.toFixed(2)}`).join(' / ') : '',
      stars: p.reviews?.average_rating ?? null, reviews: p.reviews?.total || 0,
      offers: promos.filter(x => !x.is_nectar).map(x => x.strap_line).join('; '),
      available: p.is_available,
    };
  },
  async search(q, n = 10) {
    const j = await (await fetch(`${S.api}?filter[keyword]=${encodeURIComponent(q)}&page_number=1&page_size=${n}&sort_order=FAVOURITES_FIRST`)).json();
    return (j.products || []).slice(0, n).map(S.row);
  },
  fmt: rows => rows.map(r => `${r.uid} | ${r.name} | £${r.price?.toFixed(2)}${r.nectar ? ` (Nectar, was £${r.was})` : ''} | ${r.unit}${r.wasUnit ? ' (was ' + r.wasUnit + ')' : ''} | ${r.stars != null ? r.stars.toFixed(1) : '-'}★ (${r.reviews})${r.cw ? ' | WEIGHED ' + r.cw : ''}${r.offers ? ' | OFFER ' + r.offers : ''}${r.available ? '' : ' | UNAVAILABLE'}`).join('\n'),
  async one(q, n = 10) { S.render(`## ${q}\n` + S.fmt(await S.search(q, n))); return 'rendered'; },
  // every query, 6 at a time. Run UN-AWAITED, poll S.progress(), then S.show(start, count)
  async searchAll(queries, n = 10) {
    window.Ssearch = { done: 0, total: queries.length, out: new Array(queries.length) };
    let next = 0;
    const worker = async () => { while (next < queries.length) { const i = next++;
      try { Ssearch.out[i] = `## ${i + 1}. ${queries[i]}\n` + S.fmt(await S.search(queries[i], n)); }
      catch (e) { Ssearch.out[i] = `## ${i + 1}. ${queries[i]}\nERROR ${e.message}`; }
      Ssearch.done++; } };
    await Promise.all(Array.from({ length: 6 }, worker));
  },
  progress: () => `${Ssearch.done}/${Ssearch.total}`,
  show(start = 0, count = 12) { S.render(Ssearch.out.slice(start, start + count).join('\n\n')); return `rendered ${start}..${Math.min(start + count, Ssearch.total) - 1}`; },
  // picks: [{ item, need, uid, qty, note }] -> renders the add plan and the estimated total, saves the plan for the add snippet
  plan(picks) {
    let tot = 0; const bad = [];
    const lines = picks.map(p => { const r = S.cache[p.uid]; if (!r) { bad.push(p.item); return `?? ${p.item}: ${p.uid} not in cache`; }
      tot += r.price * p.qty; return `${p.item} (need ${p.need}) -> ${p.qty} x ${r.name} @ £${r.price.toFixed(2)}${p.note ? ' [' + p.note + ']' : ''}`; });
    window.Splan = picks.filter(p => S.cache[p.uid]).map(p => [S.cache[p.uid].slug, p.qty, S.cache[p.uid].name]);
    // the add snippet runs on product pages (navigation wipes S), so the plan lives in localStorage
    localStorage.setItem('Splan', JSON.stringify(Splan)); localStorage.removeItem('Slog');
    S.render(`ESTIMATED £${tot.toFixed(2)}${bad.length ? ' | NOT CACHED: ' + bad.join(', ') : ''}\n\n` + lines.join('\n') +
      '\n\nPRODUCT URLS\n' + Splan.map(p => `https://www.sainsburys.co.uk/gol-ui/product/${p[0]}`).join('\n'));
    return `£${tot.toFixed(2)}, ${Splan.length} products${bad.length ? ', ' + bad.length + ' not cached' : ''}`;
  },
};
'ready'
```
