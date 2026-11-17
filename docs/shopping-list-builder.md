# Shopping list built by the server: design

Status: **proposed, not built** (phase 7 of `docs/chatbot-design.md`). Replaces step 2 of Finalise
(`docs/chatbot-design.md` 7.1) and step 3 of `mcp-server/workflows/plan-recipes.md`, for both the chat and `/mcp`. The list format (`shopping-list.json`), the site, `shopping.js`, the stocktake
and the shop workflows do not change.

## Why

Today the model writes the whole list in one `stage_update_shopping_list` call. For every one of ~50 lines it
has to (1) match the same ingredient across recipes, (2) scale each recipe to 2 servings, (3) convert
tbsp/tsp/cups to g or ml, (4) add up one quantity, (5) split it into `amounts` per recipe that add up within
1%, (6) name it and pick an aisle, then re-check all of it. Only 1 and 6 need judgement; the rest is
arithmetic and bookkeeping that code does exactly.

It fails in production. The Finalise turns of 16 Nov 2026 (13 recipes, `qwen/qwen3.5-397b-a17b`, Langfuse):

- **23:19:** the second model call spent its whole `max_tokens` (16,000) on reasoning in 188 s and wrote
  nothing (`finishReason: length`).
- **23:38:** the first list (110 s, 5,597 tokens) was rejected by the schema (an `amounts` share of 0); the
  second (71 s, 5,367 tokens) was staged with a problem on the card (several `"1 tbsp"` quantities); the
  third call was aborted at the 250 s deadline (`CHAT_TURN_DEADLINE_MS`). No list, so no Save.

Each attempt rewrites the full list (~5k output tokens, 1–3 minutes), so one mistake leaves no time to fix
it inside a turn. A stronger model or a bigger budget moves the limit; it doesn't remove the work.

What the book looks like (all 63 recipes, 16 Nov 2026): 795 ingredient lines, 322 distinct names.

| Quantity on the line | Lines | Handled by |
| --- | --- | --- |
| g / ml | 130 | code |
| plain count ("2") | 139 | code |
| tbsp / tsp / cup | 226 | code, with a per-item conversion |
| none ("to taste", "to serve") | 127 | code (listed without a quantity) |
| other ("2 cloves", "¾ can", "juice of 1", "heaped tbsp", "handful") | 173 | mostly code with a small unit vocabulary; the rest needs judgement |

So roughly 85–90% of lines can be resolved by code, and what's left is a judgement about *one* recipe at a
time, never arithmetic across thirteen.

## The idea: decide once, add up every week

Move the judgement to the moment a recipe is written (one recipe in context, done once), keep the facts
that don't change in a catalogue we maintain, and make the weekly list a sum the server computes. The
model keeps the parts that need thinking: mapping odd lines, proposing new catalogue entries, and
reviewing the finished list.

```
 recipe written ──▶ lines matched to the catalogue ──▶ `buy` stored on the recipe   (once per recipe)
                         │ unresolved lines → the model maps them (one recipe)
                         │ unknown item     → the model proposes a catalogue entry
 Finalise ──▶ buildShoppingList(next week) ──▶ list staged ──▶ model reviews: small patches
                                                               (pack sizes, merges, notes)
```

## 1. The ingredient catalogue: `data/ingredients.json` (repo)

One entry per thing we buy, keyed by a stable id:

```json
{
  "capers": { "name": "Capers", "section": "Tins & jars", "unit": "g", "per_tbsp": 10,
              "aliases": ["baby capers", "capers, drained"] },
  "lemon":  { "name": "Lemons", "section": "Fresh produce", "unit": "count",
              "forms": { "juice of": 1, "zest of": 1, "zest and juice of": 1 } },
  "garlic": { "name": "Garlic", "section": "Fresh produce", "unit": "clove", "per_unit": { "bulb": 10 } },
  "coconut-milk": { "name": "Coconut milk", "section": "Tins & jars", "unit": "ml", "per_unit": { "can": 400, "tin": 400 } },
  "salt":   { "name": "Salt", "section": "Pantry", "staple": true }
}
```

- `unit` is the shopping unit (`g`, `ml`, `count`, or a named count like `clove`); `per_tbsp` / `per_tsp` /
  `per_cup` convert kitchen measures (ml for liquids by default: 15 / 5 / 240); `per_unit` converts named
  units; `forms` maps phrasings to counts; `aliases` are the other names recipes use; `staple` items go in
  Pantry without a quantity (salt, pepper, oil), like today.
- **In the repo, not Supabase.** It is source data like `recipes/`: changes are reviewable git diffs, it is
  committed in the same commit as the recipe that needed a new entry (one deploy), and the server reads it
  through the cached recipe index. It is not copied to `dist/`. Supabase stays for chat state.
- Only the MCP server writes it, through the same validation path as recipes (a new entry is staged with
  the recipe that introduced it and shows on that recipe's tray card; section 5).
- Other users of ingredient matching get it for free: `sameIngredient` (`lib/ingredient-match.js`, used by
  `recipes_from_home` and the stocktake by chat) can match by catalogue id first and fall back to words.
  The shop workflows' product preferences could live on the same entries later.

## 2. `buy` on each recipe, computed when it's written

`create_recipe` / `update_recipe` (and their `stage_*` twins) already receive structured ingredients
(`quantity`, `name`, `note`); today that structure is lost when they're rendered to Markdown. The server
resolves each line against the catalogue and stores the result in the frontmatter, **per serving**:

```yaml
buy:
  - { item: capers, amount: 5 }       # "1 tbsp capers", serves 2 → 10 g / 2
  - { item: lemon, amount: 0.5 }      # "juice of 1 lemon", serves 2
  - { item: salt }                    # "salt, to taste": no amount
  - {}                                # "water, to loosen": nothing to buy
buy_checked: 7c41e2                   # hash of the Ingredients section buy was computed from
```

- **One entry per ingredient line, in the same order**, so an entry needs no key: entry *n* is line *n*.
  A line with nothing to buy gets an empty entry, so the positions stay aligned.
- `amount` is in the item's shopping unit. The block is **server-owned**: never written by hand or by the
  model directly.
- **Recomputed from scratch on every write** that touches ingredients. The server has the old version of the
  file at that point, so an answer the model gave earlier for a line (below) is kept when that line's text is
  unchanged: the match happens at write time and nothing about it is stored in the recipe.
- **Stale data is caught with one hash per recipe.** `buy_checked` is a short hash of the Ingredients section
  the block was computed from. A recipe edited outside the server (by hand, or locally with the `add-recipe`
  skill) no longer matches its hash, and `buildShoppingList` re-resolves that recipe instead of trusting its
  `buy`; the build can warn about it too.
- **Lines the server can't resolve** (unknown phrasing, an item not in the catalogue) are reported in the
  write's result the way problems are today (`PROBLEM on the card`): *"say what to buy for: '¾ can coconut
  milk', 'a few sprigs of thyme'"*. The model answers with a small mapping for that recipe (a new tool
  argument, e.g. `buy_hints: [{ line: "¾ can coconut milk", item: "coconut-milk", amount: 300 }]`, keyed by
  the line's text since that is what the model sees) and, for a
  new item, a proposed catalogue entry (section 5). In chat this happens on the recipe's card while the tray collects, so
  Finalise starts with every recipe resolved.
- A recipe with no ingredients yet (e.g. "Ingredients not yet recorded") gets `buy: []` and a note; it
  doesn't block the list (today it fails the "no item is for X" check).
- `build.js` ignores the field (it reads only the frontmatter it needs). The `add-recipe` skill and
  `lib/recipe-format.js` describe it as server-owned; a recipe added locally without it is resolved on its
  next write through the server (or by the backfill script).
- **Backfill:** a one-off script resolves the 63 existing recipes, drafts the catalogue from their names
  (322 names → fewer items after aliases), lists what it couldn't resolve for one model pass, and lands as
  one reviewed PR.

## 3. `buildShoppingList(nextSlugs)`: the list as a sum

A pure function in `lib/shopping-list.js`: for each next-week recipe take its `buy` entries × 2 (the list is
always for 2 servings), group by `item`, add up, and emit today's format: `name` and `section` from the
catalogue, `quantity` as the total in the item's unit, `recipes` = the slugs that contributed, `amounts` = each
one's share. Staples go to Pantry without a quantity. It is deterministic and unit-tested; the existing
validation (no kitchen measures, shares adding up, every recipe covered) holds by construction and stays as a
safety net. It needs no model and runs in milliseconds, so it also works over `/mcp`
(`update_shopping_list` with `build: true`) and in the local dev harness without a fake model.

## 4. Finalise becomes "build, then review"

1. The promote question (`docs/chatbot-design.md` 7.1, step 1) is unchanged.
2. The server runs `buildShoppingList` over what next week will be after Save, stages the list itself (no model
   call), and the List card appears straight away.
3. The model gets a short review turn: the staged list summarised (items, totals) plus what deserves a look:
   items with a fractional count ("2.5 lemons"), anything unresolved, close names that weren't merged
   ("cherry tomatoes" / "tomatoes"), very large totals. It answers with **patches**, not a list:
   `stage_shopping_list_edits({ edits: [{ round_up: "lemon" }, { merge: ["cherry-tomatoes", "tomatoes"] },
   { note: { item: "chicken-thighs", text: "skinless" } }, { move: { item: "tahini", section: "Tins & jars" } }] })`,
   applied and re-validated by the server. A few hundred tokens instead of ~5k per attempt; a bad patch is
   refused on its own without losing the list.
4. A patch that is generally true (an alias: "scallion" is "spring onion"; a section move) can be marked
   `remember: true` and becomes a catalogue change on the tray (section 5), so the question isn't asked again
   next week.

The user's own asks still go through the model ("skip the fancy salt this week", "double the rice"), as patches.

## 5. How the catalogue is updated

The model never edits `data/ingredients.json` itself. It suggests catalogue changes as part of the work it is
already doing, and the server checks and stages them like any other change.

### When

**1. While writing a recipe (most changes).** An unresolved line's `buy_hints` answer (section 2) can point at
an existing item, add the line's wording as an alias, or create a new item:

```json
buy_hints: [
  { "line": "¾ can coconut milk", "item": "coconut-milk", "amount": 300 },
  { "line": "2 tbsp baby capers", "alias_of": "capers" },
  { "line": "1 tbsp gochujang", "new_item": { "id": "gochujang", "name": "Gochujang",
      "section": "Tins & jars", "unit": "g", "per_tbsp": 18 } }
]
```

The catalogue change is part of the recipe's own operation: it shows on that recipe's tray card ("New in the
catalogue: Gochujang · Tins & jars") and lands in the same commit (S4).

**2. At Finalise review.** A review patch (section 4) changes only this week's list by default. With
`remember: true` the model marks it as generally true, and it becomes a catalogue change too:

| Review patch | Catalogue change |
| --- | --- |
| `merge: ["scallion", "spring-onion"]` | `scallion`'s wording becomes an alias of `spring-onion` |
| `move: { item, section }` | the item's `section` |
| `round_up: "lemon"` with a pack size | a pack size on the item |

These have no recipe to ride on, so they go on one **Catalogue** card in the tray. The staged list is rebuilt
from the catalogue as the tray's replay leaves it (`lib/tray.js` `replay`), so the list and the catalogue never
disagree.

### What the model may change

- **Additions go through freely:** new items, new aliases, new conversions. They only affect lines that weren't
  resolved before.
- **Edits to an existing item** (its section, name or a conversion rate) are allowed. The server works out which
  recipes they affect and says so on the card ("changes the amount for 4 recipes"); Save recomputes those
  recipes' `buy` in the same commit.
- **Not by the model:**
  - changing an item's `unit`, since every `buy` amount for that item would have to be converted: that's a script;
  - deleting an item, since one in use would break recipes: unused items are cleaned up by a script.

### How the server checks it

One function, `applyCatalogueChange(catalogue, change)` in a new `lib/catalogue.js`, used everywhere: `/mcp`
`batch_changes`, the tray dry run and Save. It refuses:

- an id that already exists (for `new_item`), or one that isn't kebab-case;
- an alias that already belongs to another item (the refusal names that item, so the model picks one);
- a section that isn't one of the list's fixed aisles;
- a unit that isn't g, ml, count or a named count;
- a conversion that is zero, negative or far outside a sane range (e.g. 1 tbsp = 500 g).

Like every write it is for editors and agents only, checked by `dispatch()` and by the commit path
(`assertCanCommit`); public callers never see it.

### At Save

Save checks the catalogue changes again against the catalogue on `main` (fresh, not the snapshot). If another
save meanwhile added the same item or alias, that is a **clash**, resolved through the bot like recipe clashes
(`docs/chatbot-design.md` 7.1); usually the answer is "use the existing item", which re-points this recipe's
`buy` at it.

### Over `/mcp`

The same shapes: `buy_hints` on `create_recipe` / `update_recipe`, and an `update_catalogue` operation in
`batch_changes` (`{ action: "update_catalogue", changes: [...] }`) for review fixes, all going through
`applyCatalogueChange`. The `plan-recipes` workflow describes both.

## What stays the model's job, what moves to code

| Step | Today | Proposed |
| --- | --- | --- |
| Match the same ingredient across recipes | model, every week | catalogue ids (model only for new items / aliases) |
| Scale to 2 servings | model | code |
| Convert tbsp / tsp / cups | model | code (catalogue conversions) |
| Add up | model | code |
| `amounts` per recipe | model | code |
| Name, aisle | model, every week | catalogue (model proposes new entries) |
| Pack sizes, merges, notes, the user's asks | model | model, as review patches |
| Check every recipe is covered | model | code |

## Costs and risks

- **Catalogue upkeep:** a few entries a week, proposed by the model, reviewed on the tray card / in the commit.
- **Conversions are approximate** (1 tbsp flour ≈ 10 g), the same guesses the model makes today, written down
  once and correctable in one place.
- **Two representations of a recipe's ingredients** (the Markdown lines and `buy`): kept honest by
  recomputing on every write, by the entry count matching the line count, and by the one `buy_checked` hash,
  which catches an edit made outside the server.
- **Migration:** the backfill PR; until a recipe has `buy`, Finalise falls back to today's model-written list for
  the whole week (no mixed lists).

## Rollout

1. **Catalogue + parser + `buildShoppingList` at Finalise, computed on the fly** (no `buy` stored yet): measure
   coverage on the real book and the live tray; the model still reviews. Already removes the arithmetic.
2. **Store `buy` on write + backfill**; unresolved-line hints on recipe cards; Finalise reads `buy`.
3. **Review patches + catalogue write-back** (aliases, sections).

Meanwhile, two small server changes unblock today's flow: drop `amounts` shares of 0 (and their slugs) instead
of rejecting, and convert tbsp/tsp quantities to ml instead of rejecting (`validateSections` /
`amountErrors` in `lib/shopping-list.js`).

## Open questions

- **S1.** Go ahead with the rollout? (Q20 in `docs/chatbot-design.md`.)
- **S2.** The catalogue in the repo (proposed) or in Supabase.
- **S3.** `buy` in the recipe frontmatter (proposed) or a sidecar file.
- **S4.** *Decided:* catalogue changes made while writing a recipe ride on that recipe's tray card; those from the
  Finalise review go on one Catalogue card (section 5).
