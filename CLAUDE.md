# Our Favourite Recipes

The family's cooking app: the recipe book, this week's and next week's plans, and the shopping list. It has three parts:

1. **The site** (GitHub Pages): generated at build time from `recipes/*.md` and `shopping-list.json` by the Node build
   script (`build.js`) and deployed as static files to GitHub Pages. **The one hard requirement is that it builds in the
   Pages workflow (GitHub Actions) and is served as static files from GitHub Pages**: no server-side rendering or hosting
   of the site anywhere else. Pages may need JS to work.
2. **Client-side JS** (`templates/*.js`): today hand-written vanilla JS, copied verbatim into `dist/`. Dynamic JS is allowed
   (frameworks, a bundler or npm packages too, as long as the build runs in the Pages workflow and the output is static files).
   Network calls from the browser go only to **our own backend** (part 3), Supabase Auth and the site's own static files, never
   to third-party APIs directly, and no secrets in the browser: anything that needs a key goes through the backend.
3. **The backend** (`mcp-server/` on Vercel, **not part of the site**; see `mcp-server/CLAUDE.md` and `mcp-server/README.md`):
   the only place with secrets and the only writer to the repo. It serves the MCP tools for agents (`/mcp`), `/stocktake` and
   `/chat` for the site, and holds the validation rules. It never ships anything into `dist/`. Every write is a commit to `main`
   and every commit is a site deploy, so writes are batched.

More context loads when you work in an area: `mcp-server/CLAUDE.md` for the backend, and `.claude/rules/` for the site's
templates (`site.md`), the chat (`chat.md`), the shopping list (`shopping-list.md`) and code that exists twice (`kept-in-step.md`).
For the reasoning behind them: `design.md` (UI: read it before changing any page's look or behaviour), `docs/chatbot-design.md`
(the chat), `docs/structured-ingredients.md` (ingredients as data), `docs/parallel-photo-reading.md` (photo reading).

## How new recipes get added

New recipes are added by asking Claude Code, in chat, to add one. **Always use the `add-recipe` skill** (`.claude/skills/add-recipe/SKILL.md`) for this — it has the exact Markdown formatting rules, the ingredient-bolding rule, and the image rules. Don't freehand a recipe file without it.

The other flow is the agent working through the recipes MCP server: **use the `plan-recipes` workflow** when the user hands over screenshots, links and/or names of recipes we already have. They are always for **next week**. If next week already has recipes, it first switches weeks (`start_next_week`), asking via `AskUserQuestion` about each of this week's drafts: liked → promoted, not liked → removed (unless it's planned for next week: kept, with a warning), not tried → carried over in this week or back to the book. Then it adds the new ones to next week as drafts (photos come from the source link, else the MCP server generates them with OpenRouter; upload links are only a fallback), adds existing ones to next week, always builds next week's shopping list and finishes with a summary. It uses the MCP tools only, never local files, and sends all its writes in one `batch_changes` call: every commit to `main` is a site deploy, so a call per change floods the Pages workflow. The workflow itself ships with the server: its source is `mcp-server/workflows/plan-recipes.md`, served as the `plan-recipes` MCP prompt and by the `get_workflow_guide` tool (the server's instructions tell agents to call it first). `.claude/skills/plan-recipes/SKILL.md` only points there, so change the flow in the server's file; a server deploy updates it for every client.

Shopping at Ocado or Sainsbury's works the same way: the `ocado-shop` and `sainsburys-shop` skills point to the server's guides
(`mcp-server/workflows/ocado-shop.md`, `sainsburys-shop.md`), which shop from `get_shopping_list`. Rules both shops share live once
in `mcp-server/workflows/shared/` and are included into each guide.

## Debugging production

For "why are we getting errors", "what happened in my last chat" and similar, **use the `debug` skill**
(`.claude/skills/debug/`): it reads the stored chats and tray in Supabase, the chat traces in Langfuse and the Vercel runtime logs
(kept only about an hour on the Hobby plan) through the connected MCP servers, read-only, with the project ids and the common
symptoms mapped to their causes (`references/symptoms.md`). Add a symptom there when a new kind of failure turns up.

## Directory layout

```
recipes/            source of truth: one .md file per recipe (frontmatter + body)
images/recipes/     source of truth: one hero image per recipe
data/ingredients.json the ingredient catalogue: one entry per thing we buy (list name, aisle, shopping unit, conversions, aliases); written by the MCP server
shopping-list.json  the shopping list for next week's recipes, written via the MCP server (.claude/rules/shopping-list.md)
build.js            reads recipes/*.md (+ shopping-list.json, checks ingredients against data/ingredients.json) -> writes dist/ (index.html, next-week.html, recipes/<slug>.html, shopping-list.html)
templates/          build-time renderers (layout, index, next-week, tiles, recipe, ingredients, shopping-list, status) and the browser scripts (.claude/rules/site.md)
styles/style.css    the one stylesheet, copied verbatim into dist/
design.md           UI principles: palette tokens, type, the house icon language, shared components
dist/               build output — gitignored, never hand-edit, regenerated every build
mcp-server/         separate backend on Vercel: /mcp, /stocktake, /chat (not part of the site; mcp-server/CLAUDE.md)
supabase/           `supabase init` layout: migrations/ (rate limits, chats, the tray, photo buckets, photo_reads), config.toml for `supabase start`
docs/               design docs (chatbot-design.md, structured-ingredients.md, parallel-photo-reading.md)
.github/workflows/deploy.yml   GitHub Actions: builds and deploys dist/ to GitHub Pages on push to main (ignores mcp-server/ changes)
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
current: true                      # optional: in THIS week (being cooked now). Top of the home page, under a "This week" heading, sorted by meal, kicker = the meal in accent ink.
next: true                         # optional: in NEXT week (being planned). Listed on next-week.html (linked from the home page); the shopping list is built from these.
draft: true                        # optional: not tried yet. Marked only by a line on its recipe page (tiles show the week). Says nothing about the week. Promoting just drops this line.
ingredients:                       # required, always last: the only place a recipe's ingredients live ([] when not recorded yet)
  - { amount: 200, unit: g, name: jasmine rice, item: jasmine-rice }
  - { amount: [2, 3], unit: tbsp, name: red curry paste, item: curry-paste }
  - { name: sesame seeds, note: to serve, optional: true, item: sesame-seeds }
  - { amount: 2, unit: tbsp, name: soy sauce, section: Sauce, item: soy-sauce }
---
```

**Ingredients are data** (`docs/structured-ingredients.md`): `amount` (a number or a range `[min, max]`; none only for "to taste" / "to serve"
in the `note`), `unit` (one of `g, kg, ml, l, tsp, tbsp, cup, clove, can, slice, bunch, sprig, piece, sheet, stick, head, pinch, handful, juice, zest`; none = a count),
`name`, `note`, `optional`, `section` (the part of the dish, e.g. "Sauce": a small heading on the page over that part's lines; a section's lines sit
together, lines without one first; the shopping list ignores it), and `item`: the id of what it's bought as in the **ingredient catalogue**, `data/ingredients.json` (shopping-list name,
aisle, shopping unit, conversions `per`, `aliases`, `staple` / `skip`). The page's ingredient list, the servings selector (`data-qty` written by
`templates/ingredients.js`), "Cook with Claude", `scale_recipe` and the shopping list are all generated from it; nothing parses ingredient text.
The MCP server fills `item` from the name, checks every amount converts, and refuses a write with the
exact fix (set `item`, or send a `catalogue` change with the recipe: `{ add }`, `{ alias }`, `{ set }`; `mcp-server/lib/catalogue.js`); the build fails on
an unknown `item` or unit. Only the server (or the `add-recipe` skill) writes the catalogue.

New recipes start as drafts (`draft: true`); once the family has cooked one and wants to keep it, it's promoted to a regular recipe (the MCP server's `promote_recipe` tool drops `draft: true`; its weeks don't change). A draft the family didn't like is deleted with the MCP server's `remove_draft` tool (recipe file + photo); it refuses anything that isn't a draft, so regular recipes can't be removed through the server, and it refuses a draft planned for next week (the family keeps those).

**This week and next week.** Two independent flags, neither implied by `draft`: `current: true` is this week (what's being cooked now), `next: true` is next week (what's being planned and shopped for). A recipe can be in this week, next week, both, or neither. The index shows this week at the top (grouped by meal, drafts first inside each), then "The rest of the book" (alphabetical); the filters are courses only. A heading above the grid says "This week" with a teal "Next week · n →" link to `next-week.html` (or "Next week: not planned"). Next week's recipes are unmarked in the book and listed together only on `next-week.html` (`templates/next-week.js`); a draft that's only in next week isn't on the home page at all (search included) until the switch. The MCP's `list_recipes` orders this week, next week, the rest. `set_week_recipes` adds/removes recipes from a week; `start_next_week` is the switch (next week becomes this week, next week is emptied, `carry_over` keeps chosen this-week recipes); both are agent-driven.

Followed by a Markdown body with `## Instructions` (numbered; the ingredient list is rendered from the frontmatter) and an optional `## Notes`. See the `add-recipe` skill for the exact rules.

The shopping list (`shopping-list.html`) covers next week's recipes only and is built by the MCP server, never by hand: see
`.claude/rules/shopping-list.md`.

## Deployment

GitHub Actions deploys `dist/` to Pages on every push to `main` (`.github/workflows/deploy.yml`). One-time manual step: in the repo's Settings → Pages, set the source to "GitHub Actions".
