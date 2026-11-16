# The pantry: use-by dates for what's at home (design)

Status: **design, nothing built.** The data source is the Ocado reader on a Raspberry Pi (`docs/ocado-pi-setup.md`). The Pi's
setup and a first capture of a real order page come first. Section 4.2 can only be final once that capture shows how Ocado lays
out the dates. Decisions are marked **D1, D2…**; open questions are at the end.

## 1. The problem

The family shops once a week (mostly Ocado) for next week's recipes. Fresh things go off at different speeds: the salmon in two
days, the spinach in four, the feta in ten. Nothing in the app knows this today:

- The **stocktake** (`shopping-list.json`, `have` per item) says *whether* something is at home, never *until when*. It belongs to
  one shopping list and starts empty with every new list.
- **This week's recipes** are shown in a fixed order, so nothing suggests cooking the salmon dish before the one with feta.
- **`plan-recipes`** plans next week without knowing that half a bag of spinach and a tub of ricotta expire on Wednesday.

Ocado knows each item's use-by date, but only shows it on the signed-in order page after delivery. The emails list the products
and substitutions without dates.

### Goals

1. Know what's in the fridge from each delivery, with use-by dates, without anyone typing them in.
2. Use that knowledge where it helps: the order to cook this week's dinners, planning next week, and the "At home" stocktake.
3. Keep the household in charge: anything can be corrected, marked as used up or binned, from the phone.

### Non-goals (for now)

- Full inventory of the cupboards (tins, spices, dry goods). Staples are already assumed (`STAPLES` in `lib/recipes.js`).
- Tracking amounts used per cooked recipe. An item is in, used or binned.
- Shops other than Ocado as a date source. Sainsbury's could follow with the same design once it has a reader.
- Notifications outside the app (see open question Q3).

## 2. How it fits

```
            ┌───────────── Raspberry Pi (docs/ocado-pi-setup.md) ───────────────┐
            │ reader.mjs on a systemd timer, Chromium profile logged in to Ocado │
            └──────┬───────────────────────────────────────────┬────────────────┘
       POST /pantry/ingest (order + items + dates)    POST /pantry/heartbeat (ok | logged_out | error)
                   │        Pi token, write-only                  │
            ┌──────▼──────────────── mcp-server on Vercel ────────▼──────────────┐
            │ lib/pantry.js: validate, match products → ingredients, upsert       │
            │ lib/pantry-match.js: sameIngredient() first, then a cheap model     │
            └──────┬───────────────────────────────▲────────────────────────────┘
                   │ service-role key               │ editor token
            ┌──────▼────────── Supabase ──────┐   GET /pantry, PATCH /pantry/items/:id   ◀── site pages (signed-in editors)
            │ pantry_items, pantry_products,  │   tools: get_pantry (read), recipes_from_home  ◀── chat, /mcp agents
            │ pantry_runs                     │
            └─────────────────────────────────┘
```

**D1. The pantry lives in Supabase, not in git.** Every commit to `main` is a site deploy, and the pantry changes several times a
week (a delivery, "used it", "binned it"). It is also more private than recipes: the repo and the site are public. So like the
chats and the tray, it is a set of tables only the backend touches, with the service-role key, RLS on and no policies.

**D2. The backend is the only writer, and the Pi gets the narrowest possible key.** The Pi holds a `PANTRY_PI_TOKEN` that can do
exactly two things: send an order's items (`/pantry/ingest`) and report its health (`/pantry/heartbeat`). It can't read the
pantry, the chats or anything else. The backend stays the only place with real secrets.

## 3. Data model

One migration, `supabase/migrations/2026111x000000_pantry.sql`, in the same style as `photo_reads` (comment block per table, RLS
on, grants to `anon` / `authenticated` revoked).

### 3.1 `pantry_items`: what's in the fridge

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | uuid pk | |
| `ingredient` | text | Our ingredient name ("Baby spinach"), from the matching step (4.3). Null while unmatched or not food. |
| `product` | text not null | The shop's product name as read ("Ocado Washed Baby Spinach 200g"). |
| `quantity` | numeric | How much, in `unit`. Optional: from the pack size in the product name times the number of packs (4.3). |
| `unit` | text | `g`, `ml` or `count`: the same metric units as the shopping list. |
| `use_by` | date | The date. Null for things without one (for example a whole melon, if Ocado shows none). |
| `date_kind` | text | `use_by` \| `best_before` \| `estimated`. A best-before date is a quality date, not a safety one, and is shown more softly (5.4). |
| `source` | text not null | `ocado_order` \| `photo` \| `manual` \| `estimate`. |
| `source_ref` | text | The order number for `ocado_order`, the photo number for `photo`. |
| `delivered_on` | date | Delivery day (from the order page). |
| `status` | text not null | `in` \| `used` \| `binned`. Default `in`. |
| `opened_on` | date | Optional: "opened" shortens some lives (Q5). |
| `edited` | boolean | True once a person changed the row. A re-read of the same order never overwrites an edited row (4.2). |
| `created_at`, `updated_at` | timestamptz | |
| `updated_by` | text | The editor's email, `pi`, or `agent`. |

Unique on `(source, source_ref, product, use_by)`, so reading the same order twice changes nothing. Rows that are `used` or
`binned` are deleted 30 days after `updated_at` (`purge_old_pantry()`, run the same way as `purge_old_chats()`).

### 3.2 `pantry_products`: what each product is

A cache from shop product names to our ingredient names, so each product is matched once:

| Column | Type | Meaning |
| --- | --- | --- |
| `product` | text pk | The product name with the pack size stripped ("Ocado Washed Baby Spinach"). |
| `ingredient` | text | Our name, or null for non-food (bin bags, washing-up liquid). |
| `food` | boolean | False for non-food: those are never stored as pantry items. |
| `pack` | jsonb | Parsed pack size, `{ "quantity": 200, "unit": "g" }` or `{ "quantity": 2, "unit": "count" }`. |
| `shelf_days` | integer | Typical life in days for estimates (4.4). |
| `matched_by` | text | `rule` \| `model` \| `editor`. An editor's correction always wins and is never re-matched. |

The shop workflows could use the same table later ("which product did we buy for *cooked chicken*?").

### 3.3 `pantry_runs`: is the Pi reader working

One row per heartbeat: `at`, `status` (`ok` \| `logged_out` \| `error`), `message`, `orders_seen`. The latest row is enough to tell
editors "The Ocado reader is logged out" (5.3). Rows older than 30 days are purged.

## 4. Getting the data in

### 4.1 Sources, in order of trust

**D3. A person beats the order page, which beats a screenshot, which beats an estimate.**

1. **Manual** (an editor adds or edits a row): always wins and marks the row `edited`.
2. **`ocado_order`** (the Pi reader): the real dates.
3. **`photo`** (a screenshot of the app's order page in the editor chat, phase 4): the same dates, but read by a vision model, so
   it shows a confirmation card first.
4. **`estimate`**: delivery day plus a shelf life (4.4). Replaced as soon as a real date for the same product arrives.

### 4.2 `POST /pantry/ingest` (the Pi)

```json
{ "order": "1103…", "delivered_on": "2026-11-13", "reader": "pi-1",
  "items": [ { "product": "Ocado Washed Baby Spinach 200g", "packs": 1, "use_by": "2026-11-17", "date_kind": "use_by" },
             { "product": "Ocado Greek Feta 200g", "packs": 2, "use_by": "2026-11-28", "date_kind": "use_by" } ] }
```

- Auth: `Authorization: Bearer <PANTRY_PI_TOKEN>`, compared in constant time. No CORS: browsers never call it.
- Validation: at most 200 items; product names up to 200 characters; dates `YYYY-MM-DD` within −7…+400 days of delivery;
  `packs` 1…50. A bad item is dropped and listed in the reply, the rest are stored.
- **Idempotent by order.** The Pi sends an order again whenever it isn't sure it got through. For that order, the backend
  replaces rows that are untouched (`edited = false`, `status = in`), leaves edited ones alone and adds new ones. Substitutions
  need nothing special: the order page shows what was actually delivered.
- Matching runs in the request (4.3). If the model is slow or down, rows are stored unmatched and matched on the next read.
- Reply: `{ "stored": 23, "skipped_non_food": 2, "dropped": [] }`. The Pi notes the order as sent only on a 2xx.

The exact item fields depend on the capture. If the order page groups items by date ("Use by Tue 17 Nov: …"), the Pi still sends
one entry per product.

`POST /pantry/heartbeat` takes `{ "status": "ok" | "logged_out" | "error", "message": "…", "orders_seen": 3 }`, with the same
token, and appends to `pantry_runs`.

### 4.3 Matching products to ingredients (`lib/pantry-match.js`)

1. Strip the pack size and brand words to get the cache key ("Ocado Washed Baby Spinach 200g" → product "Ocado Washed Baby Spinach",
   pack 200 g). Pack sizes like "200g", "1kg", "500ml", "2 per pack", "x6" are parsed. Anything else leaves `quantity` null.
2. **Rule:** look the product up in `pantry_products`. Otherwise try `sameIngredient()` (`lib/ingredient-match.js`) against the
   current shopping list's item names and then the book's ingredient names. One clear hit is stored as `matched_by: rule`.
3. **Model:** otherwise ask a cheap text model (`PANTRY_MATCH_MODEL`, OpenRouter, its own key `OPENROUTER_PANTRY_KEY`) with the
   unmatched products of the order and the candidate names, in one call per order: "for each product, the candidate it is, or
   `none`, or `not food`, plus a typical life in days". The answer is validated against the candidates, never trusted as free text.
4. An editor can correct a match from the pantry view (5.1). That updates `pantry_products` with `matched_by: editor` and
   re-labels that product's open rows.

**D4. No model sees anything but product names.** No prices, address or order history leave the backend.

### 4.4 Estimates

When there's no date yet (an `ocado-shop` basket just filled, or a manual add without a date), the row gets `use_by` = delivery
(or today) + `shelf_days`, with `date_kind: estimated`. `shelf_days` comes from `pantry_products` (the model's guess, or an
editor's), else a small category table in `lib/pantry.js` (fresh fish 2, mince 2, leafy herbs and salad 4, berries 4, soft
cheese 7, hard cheese 21, yoghurt 10, eggs 21, root vegetables 14…). Later (phase 4) `ocado-shop` can record Ocado's own life
guarantee per product while filling the basket, which is better than the table.

## 5. Using the data

### 5.1 The pantry view (site, editors only)

**D5. Reading the pantry needs an editor sign-in.** `GET /pantry` checks the Supabase token and `EDITORS`, like `/stocktake`. The
site is public and visitors don't need to see the family's fridge. Pages fetch it at runtime (allowed since the JS rules were
relaxed); nothing about the pantry is baked into the build.

The view is a third tab on the shopping page for signed-in editors, next to the list and **At home**: **Fridge**, with the count
of items in. It shows rows sorted by `use_by`, grouped "Use today / tomorrow", "This week", "Later", "No date". Each row: the
product's ingredient name (the shop's product name small and muted under it), the date ("use by Tue"), and two actions, **Used**
and **Binned**, plus a tap on the row to fix the date, the match or the amount (`PATCH /pantry/items/:id`). An **Add** button
covers things bought elsewhere. Marking is immediate and undoable for a few seconds, like ticks on the list. No Save step: unlike
the stocktake, a pantry change is not a commit (D1).

Pages read, the backend writes: `templates/pantry.js` (vanilla, signs in through the shared `auth.js`, talks only to the backend),
added to the shopping page.

### 5.2 This week: what to cook first

On the home page, for signed-in editors, each of this week's tiles gets a small line when one of its ingredients is in the pantry
with a date in the next three days: "Salmon · use by Sun". The build writes `dist/recipe-ingredients.json` (slug → ingredient
names, from the same `recipeIngredients()` the at-home ranking uses) so the page can match pantry rows to recipes without the
backend knowing about tiles. Tiles keep their order; the line is the hint.

In the chat, `recipes_from_home` gains the pantry: recipes are ranked by what's at home (stocktake or pantry), and among those,
by the earliest `use_by` they would use up. A new read tool **`get_pantry`** (editor-only, like `fetch_url`; also on `/mcp` for
agents) returns the items in, soonest first, so "what should we cook tonight?" and "what's going off?" have an answer.

### 5.3 The Pi's health

When the latest heartbeat is `logged_out` (or no heartbeat for 48 hours), the Fridge tab and the editor chat show a calm notice:
"The Ocado reader on the Pi is logged out. Log in again through Raspberry Pi Connect (see the setup guide)." It disappears with the next `ok`. That is
the only way the Pi talks to people.

### 5.4 Look (to be added to `design.md` when built)

`design.md` allows no new hues, so urgency is shown with the existing tokens and an icon:

- A small stroke **clock** icon, new to the icon language, means "has a date".
- Use today / tomorrow (and past use-by): the date in `--accent-ink`, the clock in `--accent`.
- Later: `--text-muted`, clock in `--icon-muted`.
- Past use-by: "past use-by" in `--accent-ink` on the row, with Binned as the first action.
- `estimated` and `best_before` dates read "about Tue" / "best before Tue", in `--text-muted`, never in the accent.

### 5.5 Planning next week (`plan-recipes`)

The workflow (`mcp-server/workflows/plan-recipes.md`) gets one step before adding recipes: call `get_pantry`, and if something
expires before or early in next week, mention it and prefer (or suggest) recipes that use it. The summary says which recipes use
up what. This is advice, never a reason to skip what the user asked for.

### 5.6 The stocktake (phase 5)

When the agent builds next week's shopping list, items in the pantry that will still be in date a few days into next week
pre-fill the **At home** tab as suggestions (a dotted house, not saved). The editor confirms them with the usual Save. The pantry
never writes the stocktake by itself (Q2): the stocktake is a commit and a deploy, and "will it last until we cook it?" depends on
the cooking day, which the app doesn't know.

## 6. Security and privacy

- The Pi token is separate from every other secret, can only write ingest and heartbeat rows, and can be rotated on its own
  (change it on Vercel and in `/etc/ocado-reader.env` on the Pi).
- Ingest is rate-limited per token (for example 60 requests an hour) with the existing limiter, and the body is capped at 256 KB.
- All pantry tables: RLS on, no policies, grants to `anon` / `authenticated` revoked, service-role key only. Reads go through
  `GET /pantry` with an editor token.
- What's stored is product names, amounts and dates. No prices, addresses or order totals. The Pi keeps the order pages it reads
  only in memory; captures for debugging are deleted after a week.
- A model only ever sees product names and our ingredient names (D4).
- Pantry tools go through the registry and `dispatch()`: `get_pantry` is `access: "read"` with `editorOnly: true`. **The model
  never writes the pantry** (D6): there is no pantry write tool in chat. When the user says "we used the spinach", the bot answers
  with a pantry card whose **Used** chip calls `PATCH /pantry/items/:id` from the panel, the same way Save to site is never a model
  tool.

## 7. Phases

1. **Backend groundwork:** the migration, `lib/pantry.js` and `lib/pantry-match.js`, `POST /pantry/ingest`, `POST /pantry/heartbeat`,
   `GET /pantry`, `PATCH /pantry/items/:id`, fakes in `scripts/dev.js` and tests. A small script posts a sample order so it can be
   tried without the Pi.
2. **The Pi reader** (`reader.mjs` and its systemd timer, setup guide section 10), written against the real captured page.
3. **Showing it:** the Fridge tab, the tile lines on the home page, `get_pantry` and the pantry-aware `recipes_from_home`, the
   `plan-recipes` step, the logged-out notice, and the `design.md` additions.
4. **More sources:** screenshots of the app's order page in the editor chat (a `receipt` mode for the photo reader in
   `lib/photo-reader.js`, with a confirmation card), Ocado's life guarantee recorded by `ocado-shop`, and the shelf-life table.
5. **Closing the loop:** pre-filling the stocktake (5.6), and reminders if Q3 is answered with a channel.

## 8. Open questions

- **Q1. What the order page shows.** Per-item dates, dates grouped by day, or only in the app? Settled by the Pi capture. If only
  the app has them, phase 4's screenshot path becomes the main source.
- **Q2. Should the pantry change the shopping list by itself?** The design says no (suggestions only, 5.6). Revisit after a few weeks
  of real use.
- **Q3. Reminders.** "Salmon use by tomorrow" in the evening: as a dot on the chat bubble, a daily email (Supabase's built-in mailer
  is limited to a few emails an hour, so it would need another mail service), or not at all?
- **Q4. Who marks things as used?** If nobody does, the Fridge fills up with things long eaten. An option: rows past their use-by for
  three days drop out of the "in" list (shown as "probably gone") unless someone keeps them.
- **Q5. Opened jars.** Some lives change once opened (passata, cream). Track `opened_on` (it's in the schema) or leave it out of v1?
