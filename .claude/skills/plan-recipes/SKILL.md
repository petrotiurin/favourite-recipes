---
name: plan-recipes
description: Full flow for "what are we cooking": takes screenshots, links, pasted text and/or names of recipes we already have, adds the new ones as draft recipes, marks existing ones as current, builds the combined shopping list, and reports back with a summary. Use whenever the user hands over recipes to cook or shop for (screenshots, links, recipe names or descriptions), or asks for a shopping list for some recipes. Uses the recipes MCP server, not local files.
---

# Plan recipes: add / pick recipes, then build the shopping list

This is the whole flow from "here are the recipes" to "here is the shopping list". It works **only through the recipes MCP server** (`list_recipes`, `get_recipe`, `create_image_upload_link`, `get_shopping_list`, and `batch_changes` for the writes; the single-change tools `create_recipe`, `update_recipe`, `set_current_recipes`, `update_shopping_list`, `promote_recipe` take the same fields). Never edit `recipes/*.md` or `shopping-list.json` by hand: if those tools aren't available, tell the user the recipes MCP server isn't connected (see `mcp-server/README.md` → "Connecting a client") and stop.

Vocabulary (see the server's instructions for details):
- **Draft**: a new recipe nobody has tried yet. Always current.
- **Current**: the recipes being cooked now: all drafts, plus regular recipes marked current. Listed first on the site and on the shopping list.
- **Shopping list**: one combined, deduplicated list for all current recipes, written by you with `update_shopping_list`.

**Write once.** Every commit redeploys the site and deploys queue behind each other, so one call per change (add each recipe, fix each, mark current, save the list) leaves the site minutes behind. Do all the reading and asking first, then send **every write in a single `batch_changes` call** (step 4). Don't call `create_recipe`, `update_recipe`, `set_current_recipes` or `update_shopping_list` one by one in this flow.

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

**Leftovers.** From the same `list_recipes` result, note the recipes that are current now (`current: true`) but aren't part of this request (e.g. last week's). Their ingredients would go on the shopping list, so the user has to decide: keep them, or take them out of current. Drafts can't simply be unmarked: a draft the user wants out has to be promoted first (it stays current), then unmarked.

Before changing anything, write a short plan back to the user: "New: A, B. Existing (will be marked current): C, D." Then carry on; only stop to ask if something is ambiguous or missing.

## 1. Prepare the new recipes (draft)

Skip to 2 if there are no new recipes.

**Read each source.** For a link, open it and read the recipe. For a screenshot, read the text off the image. Extract title, course, tags, total minutes, serves, calories, ingredients and instructions. Follow the format rules in the recipes MCP server's instructions and tool schemas (structured ingredients with a numeral quantity, bold every ingredient mention in the steps, never repeat amounts in the steps, one action per step, etc.). Don't re-invent them here. If `serves` or `calories` isn't in the source, estimate it and say it's an estimate in the summary. If something essential is missing (no quantities, unreadable image, unclear course), ask.

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

All the existing recipes found in step 0 go in **one** `{ action: "set_current_recipes", slugs: [...], current: true }` operation. Recipes that are already current (and drafts) are skipped; note them as "already current" in the summary. Leftovers the user wants out go in a `{ action: "set_current_recipes", slugs: [...], current: false }` operation (a draft needs a `promote_recipe` operation before it).

## 3. Build the shopping list (always)

This step always happens, even if nothing was added and the user only picked existing recipes.

1. Work out the set the list must cover: the new drafts, the existing recipes being marked current, and the leftovers the user is keeping. Don't silently drop or include leftovers: if the user hasn't answered about them, ask.
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

1. Put the operations in this order: `create_recipe` for each new recipe, `promote_recipe` for drafts leaving the rotation, the `set_current_recipes` operations, then `update_shopping_list`.
2. Call `batch_changes({ operations, dry_run: true })`. Nothing is committed. Fix every warning it reports (unbolded ingredient, repeated amount) in your operations, and any rejected operation (duplicate shopping item, missing photo, bad field). Repeat the dry run until it's clean.
3. Call `batch_changes({ operations })` once. It's all or nothing: if an operation is rejected, nothing was committed, so fix it and send the whole batch again.

That's one commit and one site deploy for the whole plan. If you have to change something afterwards (the user corrects a recipe), gather the fixes and send them as one more batch, ending with `update_shopping_list` if ingredients or the current set changed.

## 5. Summary

Finish with one message to the user containing:

1. **Recipes added** (new drafts): names, each linked to its page. Mention any estimated serves/calories, and any photo that came from a link.
2. **Existing recipes made current**: names (and "already current" ones, if any).
3. **Anything left out or needing a decision** (leftover current recipes, unmatched names, skipped recipes).
4. **The shopping list**, written out in full, grouped by section, as a checklist the user can read without opening the site, e.g.

   **Fresh produce**
   - 3 red onions (for the tacos and the salsa)
   - Parsley

5. **Link to the shopping page** (`…/shopping-list.html`) and a note that the site updates in about a minute.

Keep it factual and short; don't repeat the recipe steps.

## Notes

- The shopping page shows the saved list until you save a new one, so re-run steps 3-4 whenever the current set changes (recipes added, marked or unmarked, a recipe's ingredients edited).
- Promoting a draft (`promote_recipe`) does not change whether it's current. Only promote when the user says they've tried it and want to keep it.
- Upload links expire after an hour; if the user comes back later, create a fresh link for the recipes still missing a photo.
