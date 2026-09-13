# Our Favourite Recipes

Static GitHub Pages site for the family's favourite recipes. Originally migrated from a Notion database.

## Hard constraint: static only

This site has **no client-side dynamism** by design — no framework runtime, no client-side data fetching, no build-time CMS calls at request time. Everything is plain HTML/CSS generated at build time from Markdown files checked into this repo. Do not add React/Vue/etc., a bundler, or any JS dependency to `dist/` output. The only allowed "moving part" is the Node build script that runs before deploy.

## How new recipes get added

New recipes are added by asking Claude Code, in chat, to add one. **Always use the `add-recipe` skill** (`.claude/skills/add-recipe/SKILL.md`) for this — it has the exact Markdown formatting rules, the ingredient-bolding rule, and the image rules. Don't freehand a recipe file without it.

## Directory layout

```
recipes/            source of truth: one .md file per recipe (frontmatter + body)
images/recipes/     source of truth: one hero image per recipe
templates/          JS functions that render HTML strings (layout.js, index.js, recipe.js)
styles/style.css    the one stylesheet, copied verbatim into dist/
build.js            reads recipes/*.md -> writes dist/ (index.html + recipes/<slug>.html)
dist/               build output — gitignored, never hand-edit, regenerated every build
.github/workflows/deploy.yml   GitHub Actions: builds and deploys dist/ to GitHub Pages on push to main
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
---
```

Followed by a Markdown body with `## Ingredients` (bulleted, quantities bolded) and `## Instructions` (numbered). See the `add-recipe` skill for the exact rules.

## Deployment

GitHub Actions deploys `dist/` to Pages on every push to `main` (`.github/workflows/deploy.yml`). One-time manual step: in the repo's Settings → Pages, set the source to "GitHub Actions".
