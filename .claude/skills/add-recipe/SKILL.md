---
name: add-recipe
description: Add a new recipe to the favourite-recipes static site — collects recipe info, writes the Markdown file with correct formatting, saves the image, and rebuilds the site. Use whenever the user asks to add, migrate, or import a recipe (pasted text, a photo, a link, or dictated from memory).
---

# Add a recipe

This site is 100% static (see root `CLAUDE.md`). Adding a recipe means: create one Markdown file in `recipes/`, save one image in `images/recipes/`, then rebuild. Never write directly into `dist/` — it's regenerated output.

## 1. Collect the recipe

From whatever the user gives you (pasted text, a photo of a recipe card, a link, or a description), extract:

- **Title**
- **Course** — one or more of: `Breakfast`, `Lunch`, `Dinner`, `Snack`, `Drink`
- **Tags** — optional, free text (e.g. `High Protein`, `Low Carb`)
- **Total minutes** — a single number. If the source gives prep+cook separately, sum them.
- **Serves** — a single number of people the recipe serves. Always required — if the source doesn't state it, estimate from the ingredient quantities and ask the user to confirm rather than guessing silently.
- **Calories** — kcal per serving, a single whole number. Always required. Use the source's figure if it gives one (Emily English recipes usually state "xxx kcal per portion"); otherwise estimate from the ingredient quantities divided by `serves`, and tell the user it's an estimate.
- **Ingredients** — a full list, each with a quantity
- **Instructions** — numbered steps
- **One hero image**

If something essential is missing (no quantities, no image, unclear course), ask the user rather than guessing.

## 2. Markdown rules

File: `recipes/<slug>.md`, where `<slug>` is the kebab-case of the title (lowercase, spaces → hyphens, strip punctuation). Frontmatter:

```yaml
---
title: <Title Case title>
slug: <slug>
image: /images/recipes/<slug>.<ext>
course: [<Course>, ...]
tags: [<Tag>, ...]     # omit the key entirely if there are no tags
total_mins: <number>
serves: <number>
calories: <number>   # kcal per serving
current: true        # optional: regular recipe in the current rotation (not needed on drafts, which are always current)
draft: true          # new recipes start as drafts; omit only if the user says it's already a tried-and-tested favourite
---
```

**Drafts.** Add new recipes as drafts (`draft: true`) by default — they're highlighted on the site, sorted first and tagged "Draft" until the family has tried them. When the user says a draft is a keeper, promote it by deleting the `draft: true` line (nothing else changes). Skip the draft only when the user says the recipe is already a proven favourite (e.g. migrating an old family recipe). Drafts are always "current" (listed first and put on the shopping list); a regular recipe only becomes current via `current: true`, so don't add that key when adding a new recipe.

Body:

```markdown
## Ingredients

- <quantity>, **<ingredient>**, <optional prep note>

## Instructions

1. <One action per step, sentence case, with each ingredient mention **bolded**.>
```

Rules that matter:

- **Every ingredient line must state a quantity.** Never write a bare ingredient with no amount. If a recipe genuinely has no fixed amount for something, write the words `to taste` or `to serve` explicitly rather than omitting quantity language.
- **Bold only the ingredient name itself, not the quantity.** e.g. `150g (⅔ cup) **Greek yogurt**`, or `2 **celery sticks**, finely diced`. The quantity/measurement stays outside the bold, and so do prep notes after the ingredient (diced, finely chopped, to taste, etc.). If a line has no quantity at all (e.g. `**Salt and pepper**, to taste`), the whole ingredient name is still bolded.
- **In the Instructions section, bold every mention of an ingredient** from the list above wherever it's referenced (e.g. "stir together the **oats**, **yogurt** and **honey**"). Only bold the ingredient noun itself, not surrounding words, and don't bold references to the dish being made (e.g. "the lamb burgers", "the batter").
- **Write quantities as numerals** (`1`, `½`, `1¾`, `150g`, `2-3`), not words ("one", "two"), and fractions as `½` `¼` `¾` `⅓` `⅔` rather than `1/2`, so the recipe page's servings selector can rescale them. Every number in an ingredient line outside the bolded name is scaled, except percentages, numbers after an `x` (`2 x 150g` — the 150g is per item) and numbers inside a parenthetical containing `each`.
- **If an ingredient is used in two places, put the split in the ingredient line** (`75 g **sugar**, split in half`, `1 tbsp **olive oil**, plus 2 tsp for the fish`) and let the instructions refer to the parts.
- **Never repeat an amount in the Instructions.** The servings selector only rescales the ingredient list, so a number in the method is wrong as soon as someone cooks for a different number of people. Refer to the ingredient instead:

  | Instead of | Write |
  | --- | --- |
  | add 37.5 g **sugar** … add the other 37.5 g **sugar** | add half the **sugar** … add the remaining **sugar** |
  | heat 1 tbsp **olive oil** | heat the **olive oil** (or "the **olive oil** for the vegetables") |
  | stir in 3 tbsp **flour** | stir in the **flour** (keeping some back for dusting) |
  | divide the dough into 2 portions | divide the dough into equal portions, one per person |
  | shape into 4 patties | shape into equal patties, one per **burger roll** |
  | press 2 **sausages** onto each tortilla | divide the **sausages** evenly between the **tortillas** |

  Fractions of a listed amount are fine ("half the **yogurt**", "a third of the dressing", "the rest"), because they scale with it. Times, temperatures, hob/oven settings, pan sizes and per-item sizes that don't depend on servings ("about 50 g per patty", "fry 2 slices at a time") stay as they are.
- If the ingredient list genuinely can't be scaled (e.g. it already lists amounts per number of people), add `scalable: false` to the frontmatter to hide the servings selector.
- Ingredients as a flat bulleted list (`-`), no sub-headings, in the order they're used.
- Instructions as a numbered list (`1.`, `2.`, ...), one clear action per step, sentence case, no trailing period requirement but be consistent within the file.
- Use `##` for `Ingredients` and `Instructions` — don't add other top-level sections unless the user explicitly wants e.g. a "Notes" section (also `##`, placed after Instructions).

## 3. Picture rules

- One hero image per recipe, saved to `images/recipes/<slug>.<ext>` (`.jpg`/`.jpeg`/`.png`/`.webp`) — filename must match the recipe's slug.
- Resize so the long edge is ≤ 1600px before saving, to keep the repo and page weight small. If you're given a much larger source image, downscale it rather than committing it as-is — use whatever's available on the machine: `sips` (macOS), `ffmpeg`/`magick` (CLI), or Python's Pillow (`python3 -c "from PIL import Image; im = Image.open('src'); im.thumbnail((1600, 1600)); im.save('dest')"`) when the others aren't installed.
- Reference it in frontmatter as `image: /images/recipes/<slug>.<ext>` (leading slash, matches the schema in root `CLAUDE.md`).
- If no image is available, ask the user for one — don't invent a placeholder and don't skip the `image` field; every tile on the index page needs a real photo.

## 4. Build and check

After writing the `.md` file and saving the image:

```
npm run build
```

Confirm it completes without error, then open `dist/index.html` (or the new `dist/recipes/<slug>.html`) and check: the new tile appears with its image, time and calories, the ingredient bullets render with bold ingredient names (quantities not bolded), the instructions bold each ingredient mention, and the instructions are numbered correctly.

## 5. Done

Leave the change staged/committed per however the user works (this skill doesn't push or open PRs on its own — follow normal git conventions, and don't commit unless asked).
