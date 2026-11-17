# Structured ingredients and the server-built shopping list: design

Status: **built on the server and the site** (phase 7 of `docs/chatbot-design.md`): all three rollout steps (catalogue, schema,
renderer and migration; `buildShoppingList`, the rebuild on every tray change and Finalise as review; catalogue write-back
from `remember: true` patches). The chat panel's side (the optional items card, the live List card, the button states) is in
review before it is built; until then the server sends the `optional` event the panel doesn't draw yet. Each recipe's ingredients become structured
data in its frontmatter, the only place a recipe's ingredients live; the page's ingredient list, the servings
selector, `scale_recipe`, the "Cook with Claude" prompt and the shopping list are all generated from it. The
shopping list becomes a sum the server computes with an ingredient catalogue, and the model only reviews it.
The tray keeps the list current on every change, so Finalise list becomes a short review (section 6). Replaces the
list-building step of Finalise and the "out of date" rule (`docs/chatbot-design.md` 7.1) and step 3 of
`mcp-server/workflows/plan-recipes.md`, for both the chat and `/mcp`. The list format (`shopping-list.json`), `shopping.js`, the stocktake and the shop
workflows do not change.

The goal is the simplest, least error-prone design for both the model and the server code: nothing parses free
text after the one-off migration, every rule is checked by a schema when a recipe is written, and the model
only does the parts that need judgement.

## Why

Today the model writes the whole shopping list in one `stage_update_shopping_list` call. For every one of ~50
lines it has to (1) match the same ingredient across recipes, (2) scale each recipe to 2 servings, (3) convert
tbsp/tsp/cups to g or ml, (4) add up one quantity, (5) split it into `amounts` per recipe that add up within 1%,
(6) name it and pick an aisle, then re-check all of it. Only 1 and 6 need judgement; the rest is arithmetic and
bookkeeping that code does exactly.

It fails in production. The Finalise turns of 16 Nov 2026 (13 recipes, `qwen/qwen3.5-397b-a17b`, Langfuse):

- **23:19:** the second model call spent its whole `max_tokens` (16,000) on reasoning in 188 s and wrote
  nothing (`finishReason: length`).
- **23:38:** the first list (110 s, 5,597 tokens) was rejected by the schema (an `amounts` share of 0); the
  second (71 s, 5,367 tokens) was staged with a problem on the card (several `"1 tbsp"` quantities); the
  third call was aborted at the 250 s deadline (`CHAT_TURN_DEADLINE_MS`). No list, so no Save.

Each attempt rewrites the full list (~5k output tokens, 1–3 minutes), so one mistake leaves no time to fix it
inside a turn. A stronger model or a bigger budget moves the limit; it doesn't remove the work.

The underlying problem is that a recipe's ingredients are **free text** ("1 cup (200g) **jasmine rice**",
"2–3 tbsp", "4 salmon fillets, 5oz each", "2 tbsp olive oil, split: 1½ tbsp for the salmon + ½ tbsp for the
pan"). Anything that computes with them has to parse that text: the model every week for the list, and the site
with a list of regex exceptions for the servings selector (`templates/quantities.js`, duplicated in
`mcp-server/lib/scaling.js`: numbers after an "x", inside a bracket with "each", percentages). Earlier drafts of
this design kept the text and stored computed shopping data next to it; that needed hashes and alignment rules
to stop the two drifting apart. Storing the ingredients as data removes both the parsing and the second copy.

## The design in one picture

```
 recipe written (model, once) ──▶ schema check + catalogue check ──▶ frontmatter `ingredients`
        │ unknown item / no conversion → the model answers on that recipe's card     (the only source)
        ▼
 generated from it:  the page's ingredient list · servings selector · scale_recipe · Cook with Claude
                     · duplicate check · buildShoppingList (sum over next week)
                                                     │
 every tray change ──▶ list rebuilt and staged (no model) ──▶ List card always current
 Finalise list ──▶ promote question? ──▶ model review (patches) ──▶ optional items card ──▶ Save to site
```

## 1. Ingredients as data

Each recipe's frontmatter gets an `ingredients` list, in the order they're used. The Markdown body keeps
`## Instructions` (and an optional `## Notes`); it no longer has an `## Ingredients` section, which the build
renders from the data.

```yaml
---
title: Coconut Curry Salmon
slug: coconut-curry-salmon
# … the other fields as today …
ingredients:
  - { amount: 200, unit: g, name: jasmine rice, item: jasmine-rice }
  - { amount: 4, name: salmon fillets, note: "about 140g each", item: salmon-fillet }
  - { amount: 2, unit: tbsp, name: olive oil, note: "1½ for the salmon, ½ for the pan", item: olive-oil }
  - { amount: [2, 3], unit: tbsp, name: red curry paste, item: curry-paste }
  - { amount: 0.75, unit: can, name: coconut milk, item: coconut-milk }
  - { amount: 1, unit: juice, name: lime, item: lime }
  - { name: salt, note: to taste, item: salt }
  - { name: sesame seeds, note: to serve, optional: true, item: sesame-seeds }
---

## Instructions

1. Rinse the **jasmine rice** …
```

The fields:

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | What the recipe calls it, plain text ("jasmine rice"). Rendered bold. |
| `amount` | unless "to taste" / "to serve" | A positive number, or a range `[min, max]`. Decimals in the data (`0.75`); the page shows `¾`. |
| `unit` | no | One of a fixed list (below). None means a count ("4 salmon fillets"). |
| `note` | no | Prep or buying detail after the name ("finely diced", "about 140g each", "to taste"). |
| `optional` | no | `true` for garnishes and extras; rendered ", optional". |
| `item` | yes (filled by the server) | The catalogue item it's bought as (section 2). |

**Units** (one fixed list, shared by the schema and the renderer): `g`, `kg`, `ml`, `l`, `tsp`, `tbsp`, `cup`,
`clove`, `can`, `slice`, `bunch`, `sprig`, `piece`, `pinch`, `handful`, `juice`, `zest`. Each has a fixed way to
render: `200g`, `2 tbsp`, `1 clove` / `2 cloves`, `¾ can`, `Pinch of`, `Juice of 1`, `Zest of 1`. A unit
not on the list is refused by the schema; adding one is a code change, on purpose.

**One measure per ingredient.** "1 cup (200g)" becomes `200 g`; metric wherever the source gives it, which suits
UK shopping. If the second measure is worth showing, it goes in the `note`.

**Rules that disappear** from the `add-recipe` skill and `lib/recipe-format.js`, because the renderer does them:
bolding the name, quantities outside the bold, numerals instead of words, unicode fractions. Rules that stay:
every ingredient has an amount unless it's "to taste" / "to serve"; a split goes in the `note`; the
instructions bold every ingredient mention and never repeat an amount.

**What is generated from it:**

- **The recipe page** (`build.js`, `templates/recipe.js`): the ingredient list, rendered from the data.
- **The servings selector** (`templates/servings.js`): the build writes each `amount` (and range) as `data-qty`
  directly, so `templates/quantities.js`'s tagging and its exceptions go away. `scalable: false` stays as is.
- **`scale_recipe`** (`mcp-server/lib/scaling.js`): multiplies `amount`, formats with the same rounding as the page
  (`formatQuantity`, kept in step with `servings.js` by `test/phase6.test.js` as today).
- **"Cook with Claude"** (`recipePlainText` in `templates/recipe.js`, the `#cook-recipe` JSON) and the tray card's
  ingredient lines (`lib/tray.js`): the same rendered lines.
- **The duplicate check** and search (`recipeIngredients()` / `recipeIndex()` in `lib/recipes.js`): the `name`s.
- **The shopping list** (section 3).

The line renderer exists twice, in the site build and in the server (deployed on its own, so it can't import the
site's templates), like `formatQuantity` today; a test checks both render the same lines.

**`renderFrontmatter`** (`lib/recipe-format.js`) learns to write a list of objects, one flow mapping per line as
above (today it writes only scalars and lists of scalars, so a list of objects would come out as
`[object Object]`). `ingredients` goes last in `KEY_ORDER`.

**`get_recipe`** still returns the whole file, so the model sees one list of ingredients, as data.

## 2. The ingredient catalogue: `data/ingredients.json` (repo, decided)

One entry per thing we buy, keyed by a stable id. It holds the facts that are the same in every recipe: what the
item is called on the list, its aisle, the unit it's bought in, how recipe units convert to it, and the other
names recipes use.

```json
{
  "capers":       { "name": "Capers", "section": "Tins & jars", "unit": "g", "per": { "tbsp": 10, "tsp": 3 },
                    "aliases": ["baby capers"] },
  "coconut-milk": { "name": "Coconut milk", "section": "Tins & jars", "unit": "ml", "per": { "can": 400 } },
  "lime":         { "name": "Limes", "section": "Fresh produce", "unit": "count", "per": { "juice": 1, "zest": 1 } },
  "garlic":       { "name": "Garlic", "section": "Fresh produce", "unit": "clove" },
  "salt":         { "name": "Salt", "section": "Pantry", "staple": true },
  "water":        { "name": "Water", "skip": true }
}
```

- `unit` is the shopping unit: `g`, `ml`, `count`, or one of the named units (`clove`).
- **Conversions:** a recipe unit converts to the shopping unit by fixed rules where they exist (g ↔ kg, ml ↔ l,
  and tsp / tbsp / cup to ml at 5 / 15 / 240 for an `ml` item), otherwise by the item's `per` (grams per tbsp for
  a `g` item, ml per can, limes per "juice of"). A recipe unit with no rule and no `per` for that item is refused
  when the recipe is written (section 4), so every stored ingredient converts.
- `aliases`: other names recipes use, so the server can fill `item` from `name`.
- `staple: true`: listed in Pantry without a quantity (salt, pepper, oil), as today. `skip: true`: never on the list
  (water, ice).
- **In the repo, not Supabase (S2, decided).** It is source data like `recipes/`: changes are reviewable git diffs,
  committed with the recipe that needed them (one deploy), read through the cached recipe index. The build reads it
  too, to check that every recipe's `item` exists (a build that fails beats a wrong list).
- Only the MCP server writes it (section 5).
- Other users of ingredient matching get it for free: `sameIngredient` (`lib/ingredient-match.js`, used by
  `recipes_from_home` and the stocktake by chat) can match by `item` first and fall back to words. The shop
  workflows' product preferences could live on the same entries later.

## 3. `buildShoppingList(nextSlugs)`: the list as a sum

A pure function in `lib/shopping-list.js`. For each next-week recipe and each ingredient whose item isn't
`skip`:

1. take `amount` (the top of a range: buy enough),
2. convert it to the item's shopping unit (section 2),
3. multiply by 2 / `serves` (the list is always for 2 servings),
4. add it to that item's total and to that recipe's share of it.

Then emit today's format: `name` and `section` from the catalogue, `quantity` as the total in the item's unit,
`recipes` = the slugs that contributed, `amounts` = each one's share. Staples and amount-less ingredients go on
without a quantity, merged per item. **Optional ingredients are on the list by default**: an item that only
optional ingredients need is marked optional (shown as "optional" on the row), and the user decides at the end of
Finalise whether to keep it (section 6). The existing
validation (no kitchen measures, shares adding up, every recipe covered) holds by construction and stays as a
safety net. A recipe with no ingredients yet contributes nothing and is named in the review instead of failing
the list (today it fails the "no item is for X" check).

It is deterministic, unit-tested and runs in milliseconds with no model, so it also works over `/mcp`
(`update_shopping_list` with `build: true`) and in the local dev harness.

## 4. Writing a recipe: what the model does, what the server checks

The model writes ingredients as objects, as it already does (`create_recipe` takes `{ quantity, name, note }`
today; it takes the fields of section 1 instead). It doesn't need to know catalogue ids. On every write that
touches ingredients (`create_recipe`, `update_recipe`, their `stage_*` twins, the photo reader's recipes), the
server:

1. **checks the schema**: units from the list, positive amounts, ranges in order, an amount unless "to taste" /
   "to serve";
2. **fills `item`** from `name` by the catalogue's names and aliases (a given `item` is kept, so the model can
   always say exactly which one);
3. **checks it converts**: the unit has a rule or a `per` for that item.

Anything that fails comes back as a precise problem on the write, the way staging problems do today
(`PROBLEM on the card`), with what would fix it:

- *"No catalogue item for 'gochujang'. Closest: curry-paste, miso. Set `item`, or add it to the catalogue."*
- *"capers has no conversion from tbsp. Add `per: { tbsp: … }` for capers."*

The model answers once, for that one recipe: it sets `item` on the ingredient, and/or sends a catalogue change in
the same operation (section 5). In chat this happens on the recipe's card while the tray collects, so Finalise
starts with every recipe complete. Over `/mcp` the write is refused until it's fixed, like any validation error.

Recipes added locally (the `add-recipe` skill in Claude Code) write the same frontmatter; the build's check
(section 2) catches a missing or unknown `item`.

## 5. How the catalogue is updated

The model never edits `data/ingredients.json` itself. It sends catalogue changes as part of the work it is already
doing, and the server checks and stages them like any other change.

### When

**1. While writing a recipe (most changes).** The write's `catalogue` field carries changes for the problems from
section 4:

```json
"catalogue": [
  { "add": { "id": "gochujang", "name": "Gochujang", "section": "Tins & jars", "unit": "g", "per": { "tbsp": 18 } } },
  { "alias": { "item": "capers", "name": "baby capers" } },
  { "set": { "item": "capers", "per": { "tbsp": 10 } } }
]
```

They are part of the recipe's own operation: they show on that recipe's tray card ("New in the catalogue:
Gochujang · Tins & jars") and land in the same commit (S4).

**2. At Finalise review.** A review patch (section 6) changes only this week's list by default. With
`remember: true` the model marks it as generally true, and it becomes a catalogue change too:

| Review patch | Catalogue change |
| --- | --- |
| `merge: ["spring-onion", "scallion"]` | `scallion`'s names become aliases of `spring-onion`, and recipes using `scallion` are re-pointed in the same commit |
| `move: { item, section }` | the item's `section` |
| `rename: { item, name }` | the item's `name` |

These have no recipe to ride on, so they go on one **Catalogue** card in the tray. The staged list is rebuilt from
the catalogue as the tray's replay leaves it (`lib/tray.js` `replay`), so the list and the catalogue never disagree.

### What the model may change

- **Additions:** new items, aliases and conversions. They only affect ingredients that didn't resolve before.
- **Edits to an existing item** (`section`, `name`, a `per` value): allowed. Because shopping amounts are computed,
  not stored, an edit takes effect everywhere at once; the server says how many recipes use the item ("used by 4
  recipes") on the card.
- **Changing an item's `unit`** is a full replacement of the entry and must come with `per` values that keep every
  recipe using it convertible; the check below enforces it.
- **Deleting an item** is refused while any recipe uses it. Unused items are cleaned up by a script.

### How the server checks it

One function, `applyCatalogueChange(catalogue, change, recipes)` in a new `lib/catalogue.js`, used everywhere:
`/mcp` `batch_changes`, the tray dry run and Save. It refuses:

- an id that already exists (for `add`), or one that isn't kebab-case;
- an alias or name that already belongs to another item (the refusal names that item, so the model picks one);
- a section that isn't one of the list's fixed aisles;
- a unit that isn't `g`, `ml`, `count` or a named unit;
- a conversion that is zero, negative or far outside a sane range (e.g. 1 tbsp = 500 g);
- any change after which an ingredient of some recipe would no longer convert or would point at a missing item.

Like every write it is for editors and agents only, checked by `dispatch()` and by the commit path
(`assertCanCommit`); public callers never see it.

### At Save

Save checks the catalogue changes again against the catalogue on `main` (fresh, not the snapshot). If another save
meanwhile added the same item or alias, that is a **clash**, resolved through the bot like recipe clashes
(`docs/chatbot-design.md` 7.1); usually the answer is "use the existing item", which re-points this recipe's
`item` at it.

### Over `/mcp`

The same shapes: the `catalogue` field on `create_recipe` / `update_recipe`, and an `update_catalogue` operation
in `batch_changes` (`{ action: "update_catalogue", changes: [...] }`) for review fixes, all through
`applyCatalogueChange`. The `plan-recipes` workflow describes both.

## 6. The list in the tray, and Finalise list

### The list is rebuilt on every tray change (S5)

Building the list is free, so the tray never holds an out-of-date list. Every tray write that changes what next
week will be after Save (a new recipe, adding to or taking off next week, the switch, an ingredient edit of a
next-week recipe, a dropped item) rebuilds it with `buildShoppingList` inside the same tray write, under the tray's
`version` check, so two people editing at once are handled as today. Then:

- the **List card** appears as soon as the tray changes next week ("86 items for 5 recipes", tap to preview by
  aisle) and updates with every change; it is never "out of date";
- the stored **review patches** and **optional-item answers** (below) are re-applied by item id; one whose item is
  gone is dropped and the card says so ("1 edit no longer applies: cherry tomatoes was removed");
- **planned servings** can be staged at any time, against the current list: the special case for servings asked for
  before the list exists (`servingsBeforeList` / `servingsFromRows` in `lib/tools.js`, and the follow-up `ask_user`
  after Finalise) goes away;
- **Save now** gets an exact rule: a quick fix is allowed when the rebuild shows it doesn't change the list
  (`saveNowRule` in `lib/tray.js` today has to classify the item instead);
- a staged **"At home" (stocktake) card** is checked against the rebuilt list (items by name), not against the list
  as it was when the card was staged, so rebuilds don't make Save refuse it with a 409.

The bot no longer says "tap Finalise list to build the shopping list" after every addition, and the tray's
"Building the list…" state goes away.

### Finalise list: review, then Save

The tray button keeps its name, **Finalise list**: it now means finishing the list rather than building it. While
collecting, the button is Finalise list; after the review it is **Save to site (n)**. Finalise list runs, in order:

1. **The promote question** (`docs/chatbot-design.md` 7.1, step 1), only if next week already has recipes, followed by
   the drafts review card. Unchanged.
2. **The model's review** of the built list, only when the server flags something: fractional counts ("2.5 limes"),
   close names on different items ("cherry tomatoes" / "tomatoes"), very large totals, recipes with no ingredients.
   With nothing flagged there is no model call. The model answers with **patches**, not a list:
   `stage_shopping_list_edits({ edits: [{ round_up: "lime" }, { merge: ["tomatoes", "cherry-tomatoes"] },
   { note: { item: "chicken-thighs", text: "skinless" } }, { move: { item: "tahini", section: "Tins & jars" } }] })`,
   applied and re-validated by the server. A few hundred tokens instead of ~5k per attempt; a bad patch is refused on
   its own without losing the list. A patch that is generally true can be marked `remember: true` and becomes a
   catalogue change (section 5). The tray shows "Reviewing the list…" while the model runs.
3. **The optional items card (S6), at the end.** If the list has optional items, the server shows one card listing
   them, each ticked (kept) by default; the user unticks what they don't want this week and taps **Done**. It works
   like the drafts review card (`lib/draft-review.js`, `.chat-review` in `templates/chat.js`): shown by the server
   with no model call, `POST /chat { action: "review_optional", answers: { item: "keep" | "drop" } }`, once only while
   the card is the open question, any other value refused. The answers are stored as `drop` patches for this week
   only (never catalogue changes) and stored as the editor's message in words ("Leaving off: sesame seeds, chilli
   oil."). The model has a UI tool `review_optional` that shows the same card, and is told never to ask about optional
   items one by one.

Then **Save to site**.

**A change after the review usually keeps Save.** The list rebuilds and the patches and answers are re-applied.
Finalise list comes back only if the change brings something the user hasn't seen: a new optional item, or a new
item the server flags for review. Removing a recipe or editing an amount just updates the List card.

The user's own asks still go through the model at any time ("skip the fancy salt this week", "double the rice"), as
patches.

### What changes in the UI

- **The tray button:** Finalise list (collecting) → Save to site (n) (reviewed). No out-of-date state.
- **The List card** is live while collecting, with a note when an edit no longer applies.
- **A new optional items card**, in the style of the drafts review card: rows with a tick each, all ticked to start,
  one Done. `design.md` gets an entry for it.
- **Tray states:** "Building the list…" goes; "Reviewing the list…" shows only during a model review.

The site and the shopping page don't change.

### Over `/mcp`

`update_shopping_list` with `build: true` builds the list in the batch. The `plan-recipes` workflow asks the
optional-items question with `AskUserQuestion` (one multi-select question listing the optional items, all kept by
default) before its one `batch_changes`, and passes the answers as `drop` edits.

## What stays the model's job, what moves to code

| Step | Today | Proposed |
| --- | --- | --- |
| Write the recipe's ingredients | model, free text with formatting rules | model, as fields checked by a schema |
| Match the same ingredient across recipes | model, every week | `item`, filled by the server (model only for new items / aliases) |
| Scale to 2 servings | model | code |
| Convert tbsp / tsp / cups / cans | model | code (fixed rules + catalogue `per`) |
| Add up, `amounts` per recipe | model | code |
| Name, aisle | model, every week | catalogue (model proposes new entries) |
| Pack sizes, merges, notes, the user's asks | model | model, as review patches |
| Check every recipe is covered | model | code |
| Servings selector on the page | regex over free text | `amount` from the data |

## Migration

A one-off script, run once and then deleted:

1. **Parse** each recipe's `## Ingredients` lines (795 lines, 322 distinct names on 16 Nov 2026) into the fields of
   section 1. A first count of how the lines read:

   | Quantity on the line | Lines |
   | --- | --- |
   | g / ml | 130 |
   | plain count ("2") | 139 |
   | tbsp / tsp / cup | 226 |
   | none ("to taste", "to serve") | 127 |
   | other ("2 cloves", "¾ can", "juice of 1", "heaped tbsp", "handful") | 173 |

   Most map directly to a unit on the list; dual measures keep the metric one; what the script isn't sure of is
   listed in a report.
2. **Draft the catalogue** from the names (fewer items than names once aliases are merged), with sections and the
   `per` conversions the recipes need.
3. **Fix the report by hand** (Claude Code in a session, with you), until every recipe passes the write-time checks
   of section 4.
4. **Compare the pages:** build before and after and diff each recipe page's rendered ingredient text; the only
   differences should be the intended ones (dropped second measures, notes moved).
5. Land it as **one reviewed PR**, together with the code changes it needs (renderer, schema, tools, skill).

Recipes with no ingredients yet ("Ingredients not yet recorded") get `ingredients: []`.

## Code changes

- **Chat panel:** `templates/chat.js` (the live List card, the optional items card, the tray button states).
- **Site:** `build.js` (reads `ingredients`, checks `item` against the catalogue, renders the list),
  `templates/recipe.js` (renders lines and `data-qty` from the data, `recipePlainText`), `templates/quantities.js`
  (ingredient tagging removed), `templates/servings.js` (reads `data-qty` as now; ranges from the data).
- **Server (`mcp-server/lib`):** `recipe-format.js` (the ingredient schema rules, the line renderer, `renderFrontmatter`
  for object lists), `recipes.js` (read/write `ingredients`, index names from the data), `tools.js` (ingredient schema,
  the `catalogue` field, `stage_shopping_list_edits`, `update_catalogue`), new `catalogue.js`, `shopping-list.js`
  (`buildShoppingList`), `scaling.js` (scales `amount`), `tray.js` (card lines, the list rebuilt on every tray write,
patches and optional answers re-applied, the out-of-date hash removed, `saveNowRule` from the rebuild, the stocktake
card checked against the rebuilt list), new `optional-review.js` (the optional items card, next to `draft-review.js`),
`chat-prompt.js` and `tools.js` (`servingsBeforeList` / `servingsFromRows` removed, `review_optional`),
  `operations.js` (the new operations), the photo reader's output schema (`photo-reader-prompt.js`,
  `photo-reader.js`) to the new fields.
- **Docs and workflows:** the `add-recipe` skill, `workflows/plan-recipes.md` (step 3 becomes "review the built
  list", plus the optional-items question; the "In chat" section loses the Finalise build and the servings special
  case), the root `CLAUDE.md` (frontmatter schema, shopping list, the chat's Finalise), `docs/chatbot-design.md` 7.1
  (Finalise and the out-of-date rule), `design.md` (the optional items card, the live List card, and the rendered
  ingredient line if it changes).
- **Tests:** the line renderer (site and server agree), conversions, `buildShoppingList`, `applyCatalogueChange`,
  the build's catalogue check, the tray rebuild (patches and answers re-applied, Finalise coming back only for new
  optional or flagged items), the optional items card's route.

## Costs and risks

- **Migration effort:** the script plus a hand pass over its report; the page diff (step 4) catches mistakes.
- **One measure per ingredient** loses "1 cup (200g)"-style doubles unless kept in the note.
- **Conversions are approximate** (1 tbsp flour ≈ 10 g), the same guesses the model makes today, written down once
  and correctable in one place.
- **Catalogue upkeep:** a few entries a week, proposed by the model, reviewed on the tray card / in the commit.
- **Recipe files are less pleasant to edit by hand:** the ingredient list is YAML. The server and the `add-recipe`
  skill write it; the build check catches mistakes.

## Rollout

1. **Catalogue, schema, renderer and migration**, in one PR: the site renders from the data, the tools write it.
   The model still writes the shopping list for now.
2. **`buildShoppingList`, the rebuild on every tray change, and Finalise list as review**: `stage_shopping_list_edits`
   and the optional items card.
3. **Catalogue write-back** from review patches (`remember: true`).

Meanwhile, two small server changes unblock today's flow: drop `amounts` shares of 0 (and their slugs) instead of
rejecting, and convert tbsp/tsp quantities to ml instead of rejecting (`validateSections` / `amountErrors` in
`lib/shopping-list.js`).

## Open questions

- **S1.** *Decided:* built.
- **S2.** *Decided:* the catalogue lives in the repo (`data/ingredients.json`).
- **S3.** *Decided:* a recipe's ingredients are structured data in its frontmatter, the only place they live; the
  page's list is rendered from it.
- **S4.** *Decided:* catalogue changes made while writing a recipe ride on that recipe's tray card; those from the
  Finalise review go on one Catalogue card (section 5).
- **S5.** *Decided:* the server rebuilds the staged list on every tray change, re-applying review patches and
  optional-item answers by item; Finalise list comes back only for new optional or flagged items (section 6).
- **S6.** *Decided:* optional ingredients go on the list by default; at the end of Finalise list one card asks which to
  keep, all kept unless unticked (section 6). The button keeps the name Finalise list.
