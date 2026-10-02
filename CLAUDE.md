# Our Favourite Recipes

Static GitHub Pages site for the family's favourite recipes. Originally migrated from a Notion database.

## Hard constraint: static only

This site has **no framework, no bundler, and no client-side data fetching** by design — no framework runtime, no build-time CMS calls at request time. Everything is plain HTML/CSS generated at build time from Markdown files checked into this repo. Do not add React/Vue/etc., a bundler, or any JS *dependency* to `dist/` output.

One exception: small, dependency-free vanilla JS is allowed for progressive-enhancement UI (e.g. `templates/search.js`, which does client-side title filtering over the already-rendered recipe list, and `templates/servings.js`, the 1/2/4-servings selector on recipe pages that rescales ingredient quantities tagged at build time by `templates/quantities.js`). Rules for that JS:
- No frameworks, no bundler, no npm packages shipped to `dist/` — hand-written vanilla JS only.
- No fetching/loading data at runtime — it must only operate on data already baked into the rendered HTML at build time (DOM already in the page, or a JSON literal the build script embedded).
- It must be optional enhancement: the page's core content (recipe list, recipe pages) must already be fully present and readable with JS disabled: JS only adds interactivity (filtering, search) on top.

The only allowed "moving part" beyond that is the Node build script that runs before deploy.

The `mcp-server/` folder is **not part of the site**: it's a separate MCP server deployed to Vercel (see `mcp-server/README.md`) that lets an agent add/edit recipes by committing `recipes/*.md` and `images/recipes/*` to `main`. It never ships anything into `dist/`, and its tools mirror the `add-recipe` skill rules (`mcp-server/lib/recipe-format.js` — keep the two in sync if the format changes).

## How new recipes get added

New recipes are added by asking Claude Code, in chat, to add one. **Always use the `add-recipe` skill** (`.claude/skills/add-recipe/SKILL.md`) for this — it has the exact Markdown formatting rules, the ingredient-bolding rule, and the image rules. Don't freehand a recipe file without it.

## Directory layout

```
recipes/            source of truth: one .md file per recipe (frontmatter + body)
images/recipes/     source of truth: one hero image per recipe
templates/          JS functions that render HTML strings (layout.js, index.js, recipe.js)
templates/search.js client-side search script, copied verbatim into dist/ (see "Hard constraint" above)
templates/servings.js client-side servings selector, copied verbatim into dist/; quantities.js tags scalable numbers at build time
styles/style.css    the one stylesheet, copied verbatim into dist/
build.js            reads recipes/*.md -> writes dist/ (index.html + recipes/<slug>.html)
dist/               build output — gitignored, never hand-edit, regenerated every build
.github/workflows/deploy.yml   GitHub Actions: builds and deploys dist/ to GitHub Pages on push to main (ignores mcp-server/ changes)
mcp-server/         separate MCP server on Vercel for adding/editing recipes (not part of the site)
```

## Build / preview locally

```
npm install
npm run build        # writes dist/
npx serve dist        # or just open dist/index.html directly in a browser
```

Run `npm run build` after adding or editing any recipe and sanity-check the new page before committing.

## Recipe frontmatter schema

```yaml
---
title: Ultimate Chicken Salad
slug: ultimate-chicken-salad       # kebab-case of title
image: /images/recipes/ultimate-chicken-salad.jpg
course: [Lunch]                    # any of: Breakfast, Lunch, Dinner, Snack, Drink
tags: [High Protein]               # optional, free text list
total_mins: 15
serves: 2                          # number of people the recipe serves, required
calories: 195                      # kcal per serving, required (source's figure, else estimated from ingredients)
scalable: false                    # optional: hides the servings selector (only when the ingredient list already gives per-person amounts)
---
```

Followed by a Markdown body with `## Ingredients` (bulleted, quantities bolded) and `## Instructions` (numbered). See the `add-recipe` skill for the exact rules.

## Deployment

GitHub Actions deploys `dist/` to Pages on every push to `main` (`.github/workflows/deploy.yml`). One-time manual step: in the repo's Settings → Pages, set the source to "GitHub Actions".
