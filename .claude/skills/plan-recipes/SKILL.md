---
name: plan-recipes
description: Full flow for "what are we cooking": takes screenshots, links, pasted text and/or names of recipes we already have, adds the new ones as draft recipes, marks existing ones as current, builds the combined shopping list, and reports back with a summary. Use whenever the user hands over recipes to cook or shop for (screenshots, links, recipe names or descriptions), or asks for a shopping list for some recipes. Uses the recipes MCP server, not local files.
---

# Plan recipes: add / pick recipes, then build the shopping list

This is the whole flow from "here are the recipes" to "here is the shopping list". It works **only through the recipes MCP server** (`list_recipes`, `get_recipe`, `create_image_upload_link`, `get_shopping_list`, and `batch_changes` for the writes; the single-change tools `create_recipe`, `update_recipe`, `set_current_recipes`, `update_shopping_list`, `promote_recipe`, `remove_draft` take the same fields). Never edit `recipes/*.md` or `shopping-list.json` by hand: if those tools aren't available, tell the user the recipes MCP server isn't connected (see `mcp-server/README.md` → "Connecting a client") and stop.

Vocabulary (see the server's instructions for details):
- **Draft**: a new recipe nobody has tried yet. Always current. A draft ends one of two ways: liked → `promote_recipe` (regular recipe), not liked → `remove_draft` (deleted; only drafts can be removed).
- **Current**: the recipes being cooked now: all drafts, plus regular recipes marked current. Listed first on the site and on the shopping list.
- **Shopping list**: one combined, deduplicated list for all current recipes, written by you with `update_shopping_list`.

**Write once.** Every commit redeploys the site and deploys queue behind each other, so one call per change (add each recipe, fix each, mark current, save the list) leaves the site minutes behind. Do all the reading and asking first, then send **every write in a single `batch_changes` call** (step 4). Don't call `create_recipe`, `update_recipe`, `promote_recipe`, `remove_draft`, `set_current_recipes` or `update_shopping_list` one by one in this flow.

## 0. Work out what the user gave you

Inputs can be any mix of:
- **Screenshots or photos** of recipes: new recipes to add.
- **Links** to recipes: new recipes to add.
- **Pasted or dictated recipes**: new recipes to add.
- **Names or descriptions** of recipes we already have ("the harissa pitta", "that salmon bagel thing", "something with chicken"): existing recipes to select.

If the user gave **none of these**, don't guess and don't start: ask which recipes they want (screenshots, links, or names of ones we already have), then wait.

Call `list_recipes` once up front. Then sort every item the user mentioned:

1. **A screenshot/link/text of a recipe** → new. But first check it isn't already logged (same or very similar title in `list_recipes`). If it is, treat it as existing and say so.
2. **A name or description** → search the list: match on title first, then tags, course, and what you can infer from the description. If a recipe clearly matches, use it. If several plausibly match, or none does, **ask** the user instead of picking: show the candidates (title + course + time). If nothing matches and they want it added, ask for a screenshot, link or the recipe text.

**Last round's recipes (close them out).** From the same `list_recipes` result, take the recipes that are current now (`current: true`) but **aren't named in this request** (e.g. last week's). They get closed out so the rotation and the shopping list only hold this round's recipes:

- **Regular current recipes** (`current: true`, no `draft: true`): take them out of current with `set_current_recipes` (`current: false`). No question needed. If the user wants one kept, they'll have named it in the request, and then it isn't a leftover.
- **Drafts** (`draft: true`, not in this request): ask the user whether they liked each one (step 0b). Liked → promote it to a regular recipe and take it out of current. Didn't like → remove it. Not tried yet → leave it as a draft (it stays current and goes on the shopping list).

A draft the user names in this request is one they're cooking (again): treat it as existing, leave it as it is, and don't ask about it.

### 0b. Ask about each leftover draft

Skip if there are no leftover drafts. Otherwise, **before** any plan or write, call the `AskUserQuestion` tool: one question per draft (the tool takes up to 4 questions per call; use further calls for more), each with these options:

- "Liked it" → keep it as a regular recipe (promoted, no longer current)
- "Didn't like it" → remove it from the site
- "Haven't tried it yet" → leave it as a draft

Name the recipe in each question ("Did you like Harissa Tuna Pitta?") and put what the options do in their descriptions. Say in the question that "Didn't like it" deletes the recipe and its photo.

If `AskUserQuestion` isn't available or fails, ask the same thing in plain chat (one numbered list covering every draft) and wait for the answer. Never guess an answer, and never remove a draft unless the user clearly said they didn't like it: removal is permanent on the site (it only survives in git history). An unclear or skipped answer means "haven't tried it yet": leave the draft alone.

**Plan.** Before changing anything, write a short plan back to the user: "New: A, B. Existing (will be marked current): C, D. Taken out of current: E. Liked, now regular: F. Removed: G." Then carry on; only stop to ask if something is ambiguous or missing.

## 1. Prepare the new recipes (draft)

Skip to 2 if there are no new recipes.

**Read each source.** For a link, open it and read the recipe. For a screenshot, read the text off the image. Extract title, course, tags, total minutes, serves, calories, ingredients and instructions, and write them following **"Writing a recipe that passes first time"** below. If `serves` or `calories` isn't in the source, estimate it and say it's an estimate in the summary. If something essential is missing (no quantities, unreadable image, unclear course), ask.

### Writing a recipe that passes first time

These are the mistakes that cost extra round-trips: a rejected recipe, or warnings to fix afterwards. Check every recipe against this list **before** the dry run. The recipes MCP server's instructions and tool schemas have the full rules; these are the ones that matter most.

**1. Every ingredient has a `quantity`, or a `note` containing "to taste" or "to serve". Otherwise the whole recipe is rejected.**
Sources often list seasoning, oil and garnish without amounts. Never leave both fields empty:

| Source says | Bad (rejected) | Good |
| --- | --- | --- |
| "olive oil, for brushing" | `{ name: "olive oil", note: "for brushing" }` | `{ quantity: "1 tbsp", name: "olive oil", note: "for brushing" }` if you can estimate an amount, else `{ name: "olive oil", note: "for brushing, to taste" }` |
| "salt and pepper" | `{ name: "salt and pepper" }` | `{ name: "salt", note: "to taste" }`, `{ name: "black pepper", note: "to taste" }` |
| "chives, to garnish" | `{ name: "chives", note: "to garnish" }` | `{ quantity: "Small handful of", name: "chives", note: "chopped, to serve" }` or `{ name: "chives", note: "chopped, to serve" }` |

"to garnish", "for brushing", "optional" and "as needed" do **not** count: the note must literally contain "to taste" or "to serve".

**2. One ingredient per line.** Split combined lines ("olive oil, salt and pepper" → three ingredients). The `name` is plain text: no `**`, no quantity, no prep. Those go in `quantity` and `note`.

**3. Bold every mention of an ingredient in every step, including later steps and passing references.** The server warns about any ingredient name that appears in a step without `**`. Don't write steps first and bold some of them afterwards: bold as you write.

| Bad (warning) | Good |
| --- | --- |
| "Whisk the **eggs**. … Pour in the eggs." | "Whisk the **eggs**. … Pour in the **eggs**." |
| "Squeeze over the lemon juice" (ingredient: lemon) | "Squeeze over the **lemon** juice" |
| "Adjust the lemon, mustard and seasoning" | "Adjust the **lemon**, **mustard**, **salt** and **pepper**" |
| "Top with the rest of the ham" | "Top with the rest of the **ham**" |

Bold the ingredient noun only, not the dish ("the batter", "the salad", "the meatballs").

**4. Never repeat an amount in a step.** The servings selector rescales the ingredient list but not the steps, so a number in a step is wrong as soon as someone cooks for a different number of people.

| Bad (warning) | Good |
| --- | --- |
| "Add 1 tsp of the **garlic granules**" | "Add the **garlic granules**" |
| "Stir in 100g **feta**, keep 50g back" | ingredient `"150g"` with note `"split: 100g + 50g"`, step "Stir in most of the **feta**, keeping some back for the top" |
| "Shape into 8 **meatballs**" | "Shape into equal meatballs, two per person" |

Fractions of a listed amount ("half the **sugar**", "the remaining **sugar**") are fine. So are times, temperatures, pan sizes and per-item sizes ("about 50g each").

**5. Other format rules.** One action per step, no numbering (the server numbers them). Quantities are numerals ("2", "½", "150g"), never words ("two"). `serves` and `calories` (kcal per serving) are required: estimate them if the source doesn't give them.

**Photos.** Every recipe needs a real photo of the dish; never invent a placeholder.
- A recipe from a **link**: try the page's dish photo (usually `og:image`) with `create_recipe`'s `image: { url }`. If that fails, fall back to an upload link.
- A recipe from a **screenshot, pasted text or from memory**: the user has to upload the photo. Call `create_image_upload_link` **once** with all of these recipes, `create_image_upload_link({ recipes: [{ title: "A" }, { title: "B" }] })`: it returns **one** link to a page that lists every recipe, where each photo uploads as soon as it's picked.

**Ask for all uploads in one message** (put the leftovers question in the same message, if there is one): the single link, then a numbered list in the same order as the page, where each item names the recipe and says what photo is wanted, e.g.:

> Please upload a photo of each finished dish on this page (the link works for one hour): <link>
> 1. **Harissa Tuna Pitta** (from your screenshot of the pitta recipe)
> 2. **Lemon Chicken Traybake** (from the BBC Good Food link)
>
> Tell me when they're all uploaded.

Then wait for the user to confirm. Uploaded photos for new recipes don't redeploy the site on their own, so there's no rush on their side.

**Write each recipe** as a `create_recipe` operation: `{ action: "create_recipe", title, course, ..., image }`, with the same title as its upload link and `image: { uploaded: true }` (or `{ url }`). Leave `draft` at its default (true): new recipes are drafts and therefore current. If a recipe's slug already exists (`list_recipes`), it was already logged: treat it as existing.

## 2. Select the existing recipes

All the existing recipes found in step 0 go in **one** `{ action: "set_current_recipes", slugs: [...], current: true }` operation. Recipes that are already current (and drafts) are skipped; note them as "already current" in the summary.

Close out last round's recipes (step 0):
- Each leftover draft the user **didn't like**: a `{ action: "remove_draft", slug }` operation.
- Each leftover draft the user **liked**: a `{ action: "promote_recipe", slug }` operation (the recipe stays current when promoted), and its slug goes in the `current: false` operation below so it leaves the rotation.
- Leftover regular current recipes, plus the liked drafts just promoted, go in **one** `{ action: "set_current_recipes", slugs: [...], current: false }` operation.
- Drafts the user hasn't tried yet: no operation.

## 3. Build the shopping list (always)

This step always happens, even if nothing was added and the user only picked existing recipes.

1. Work out the set the list must cover: the new drafts, the existing recipes being marked current, and any leftover drafts the user hasn't tried yet. Recipes taken out of current, promoted-and-unmarked and removed ones are not on it. If that set is empty, skip the `update_shopping_list` operation (the server clears the saved list when nothing is current any more).
2. Read every one of those that already exists with `get_recipe` (you wrote the new ones yourself, so you already have their ingredients).
3. Combine the ingredients into one list:
   - **One line per ingredient across the whole list.** Add up amounts of the same ingredient (2 + 1 onions → 3; 100g + 150g feta → 250g). Convert compatible units when it's obvious (2 tbsp + 1 tbsp → 3 tbsp). If units can't be added (1 lemon and juice of ½ a lemon → 2 lemons, round up), pick the sensible shopping unit.
   - Use the recipes' own amounts as written (each for its own `serves`). Don't rescale.
   - Keep genuinely different items separate ("garlic cloves" vs "garlic powder", "smoked paprika" vs "paprika").
   - Put useful context in `note` ("for the tacos and the salsa", "finely diced"); keep it short.
   - "To taste" / "to serve" items: list them without a quantity (merge duplicates). Plain pantry basics (salt, pepper, oil) can go in a "Pantry" section so they can be checked off.
   - Drop the prep note unless it matters for buying.
4. Group into shop-aisle sections, e.g. **Fresh produce, Meat & fish, Dairy & eggs, Bakery, Tins & jars, Pantry, Frozen**. Only include sections that have items.
5. This becomes the **last** operation: `{ action: "update_shopping_list", sections }`. It covers whatever is current after the operations before it, and the server records which recipes those are and links them on the page.

## 4. Commit everything in one go

1. Put the operations in this order: `create_recipe` for each new recipe, `remove_draft` for the disliked drafts, `promote_recipe` for the liked drafts, the `set_current_recipes` operations (`current: false` first, then `current: true`), then `update_shopping_list`.
2. Call `batch_changes({ operations, dry_run: true })`. Nothing is committed, so fixing things here is free. Fix any rejected operation (missing quantity / "to taste" note, duplicate shopping item, missing photo, bad field, `remove_draft` on a recipe that isn't a draft) and **every** warning (unbolded ingredient, repeated amount) in your operations. Warnings don't block the commit, but don't leave any as "minor": an unbolded or loosely referenced ingredient is still an inconsistency on the site, and fixing it after the commit costs another commit and deploy. Repeat the dry run until it reports no warnings.
3. Call `batch_changes({ operations })` once. It's all or nothing: if an operation is rejected, nothing was committed, so fix it and send the whole batch again. Never fix things afterwards with separate `update_recipe` calls.

That's one commit and one site deploy for the whole plan. If you have to change something afterwards (the user corrects a recipe), gather the fixes and send them as one more batch, ending with `update_shopping_list` if ingredients or the current set changed.

## 5. Summary

Finish with one message to the user containing:

1. **Recipes added** (new drafts): names, each linked to its page. Mention any estimated serves/calories, and any photo that came from a link.
2. **Existing recipes made current**: names (and "already current" ones, if any).
3. **Last round's recipes**: which drafts were promoted (liked, no longer current), which were removed (not liked), which stay as drafts (not tried yet), and which regular recipes were taken out of current.
4. **Anything left out or needing a decision** (unmatched names, skipped recipes).
5. **The shopping list**, written out in full, grouped by section, as a checklist the user can read without opening the site, e.g.

   **Fresh produce**
   - 3 red onions (for the tacos and the salsa)
   - Parsley

6. **Link to the shopping page** (`…/shopping-list.html`) and a note that the site updates in about a minute.

Keep it factual and short; don't repeat the recipe steps.

## Notes

- The shopping page shows the saved list until you save a new one, so re-run steps 3-4 whenever the current set changes (recipes added, marked or unmarked, a recipe's ingredients edited).
- Promoting a draft (`promote_recipe`) does not change whether it's current: in this flow a liked draft is promoted **and** unmarked in the same batch. Only promote when the user says they've tried it and liked it.
- `remove_draft` is permanent on the site and only works on drafts. Only call it after an explicit "didn't like it"; never use it to tidy up a draft the user hasn't answered about.
- Upload links expire after an hour; if the user comes back later, create a fresh link for the recipes still missing a photo.
