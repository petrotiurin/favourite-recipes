---
name: add-recipe
description: Add a new recipe to the favourite-recipes static site — collects recipe info, writes the Markdown file with correct formatting, saves the image, and rebuilds the site. Use whenever the user asks to add, migrate, or import a recipe (pasted text, a photo, a link, or dictated from memory).
---

# Add a recipe

> Handing over recipes to cook this week, or want a shopping list too? Use the `plan-recipes` skill instead (it works through the recipes MCP server and builds the shopping list). This skill is for editing the repo's files directly.

This site is 100% static (see root `CLAUDE.md`). Adding a recipe means: create one Markdown file in `recipes/` (with its ingredients as frontmatter data, adding any new ingredient to `data/ingredients.json`), save one image in `images/recipes/`, then rebuild. Never write directly into `dist/` — it's regenerated output.

## 1. Collect the recipe

From whatever the user gives you (pasted text, a photo of a recipe card, a link, or a description), extract:

- **Title**
- **Course** — one or more of: `Breakfast`, `Lunch`, `Dinner`, `Snack`, `Drink`
- **Tags** — optional, free text (e.g. `High Protein`, `Low Carb`)
- **Total minutes** — a single number. If the source gives prep+cook separately, sum them.
- **Serves** — a single number of people the recipe serves. Always required — if the source doesn't state it, estimate from the ingredient quantities and ask the user to confirm rather than guessing silently.
- **Calories** — kcal per serving, a single whole number. Always required. Use the source's figure if it gives one (Emily English recipes usually state "xxx kcal per portion"); otherwise estimate from the ingredient quantities divided by `serves`, and tell the user it's an estimate.
- **Ingredients** — a full list, each with an amount
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
current: true        # optional: in this week (what's being cooked now); drafts too, nothing is in a week by default
next: true           # optional: in next week (being planned; the shopping list is built from these)
draft: true          # new recipes start as drafts; omit only if the user says it's already a tried-and-tested favourite
ingredients:         # always last; one flow mapping per line, in the order they're used
  - { amount: 200, unit: g, name: jasmine rice, item: jasmine-rice }
  - { amount: 4, name: salmon fillets, note: about 140g each, item: salmon-fillet }
  - { amount: [2, 3], unit: tbsp, name: red curry paste, item: curry-paste }
  - { amount: 1, unit: juice, name: lime, item: lime }
  - { name: salt, note: to taste, item: salt }
  - { name: sesame seeds, note: to serve, optional: true, item: sesame-seeds }
---
```

**Drafts.** Add new recipes as drafts (`draft: true`) by default — their recipe page says it's a draft until the family has tried them. When the user says a draft is a keeper, promote it by deleting the `draft: true` line (nothing else changes, its weeks included). Skip the draft only when the user says the recipe is already a proven favourite (e.g. migrating an old family recipe). Being a draft says nothing about the week: only add `current: true` (this week) or `next: true` (next week) if the user says which week it's for. Key order in the frontmatter: `scalable`, `current`, `next`, `draft`, then `ingredients` last.

Body (the ingredient list is NOT in the body: the page renders it from the frontmatter):

```markdown
## Instructions

1. <One action per step, sentence case, with each ingredient mention **bolded**.>
```

Rules that matter:

- **Ingredients are data** (`docs/structured-ingredients.md`). Keys in this order, omitting absent ones: `amount`, `unit`, `name`, `note`, `optional`, `section`, `item`. Quote a string (double quotes) when YAML needs it (it contains `: `, `,`, `#`, brackets, or looks like a number). The page bolds the name, writes `200g`, `2 tbsp`, `2 cloves`, `¾ can`, `Juice of 1`, `Pinch of`, and the servings selector rescales every amount.
  - `amount`: a number (decimals: `0.5`, `0.75`; thirds as `0.33` / `0.67`) or a range `[2, 3]`. Leave it out only for "to taste" / "to serve" items, and then the `note` must say so.
  - `unit`: one of `g, kg, ml, l, tsp, tbsp, cup, clove, can, slice, bunch, sprig, piece, sheet, stick, head, pinch, handful, juice, zest`; none for a count. **One measure per ingredient**, metric where the source gives it ("1 cup (200g)" → `200`, `g`); convert oz/lb to g. A useful second measure can go in the note.
  - `name`: what the recipe calls it, plain text. `note`: prep or buying detail ("finely diced", "about 140g each"); a split goes here ("1½ tbsp for the salmon, ½ for the pan") unless the recipe has sections. `optional: true` for garnishes and "if using" (never "optional" in the note).
  - `section`: only when the recipe is made of parts ("For the sauce", "Pickle"): the part's short name on each of its lines (`section: Curry sauce`), shown as a small heading over them. A section's lines sit together, lines without one go first, a one-part recipe has none. An ingredient used in two parts is two lines, one per section (not a split note). The build fails on a split-up section.
  - `item`: the id in `data/ingredients.json` (the ingredient catalogue) it's bought as. Look it up by the entry's `name` / `aliases`. If there's none, add an entry (id kebab-case; `name` as on a shopping list; `section` one of `Fresh produce, Meat & fish, Dairy & eggs, Bakery, Tins & jars, Pantry, Frozen`; `unit` `g`, `ml`, `count` or a named unit; `per` conversions from the recipe's units when there's no fixed rule, e.g. `{ "tbsp": 10 }` grams per tbsp; `staple: true` for salt, pepper, oil). Keep the file sorted by id. The build fails on an unknown `item` or unit.
- **In the Instructions section, bold every mention of an ingredient** from the list above wherever it's referenced (e.g. "stir together the **oats**, **yogurt** and **honey**"). Only bold the ingredient noun itself, not surrounding words, and don't bold references to the dish being made (e.g. "the lamb burgers", "the batter").
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
- Instructions as a numbered list (`1.`, `2.`, ...), one clear action per step, sentence case, no trailing period requirement but be consistent within the file.
- Use `##` for `Instructions` — don't add other top-level sections unless the user explicitly wants e.g. a "Notes" section (also `##`, placed after Instructions).

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

Confirm it completes without error, then open `dist/index.html` (or the new `dist/recipes/<slug>.html`) and check: the new tile appears with its image, time and calories, the ingredient list renders from the frontmatter with bold names and the right amounts, the instructions bold each ingredient mention, and the instructions are numbered correctly.

## 5. Done

Leave the change staged/committed per however the user works (this skill doesn't push or open PRs on its own — follow normal git conventions, and don't commit unless asked).
