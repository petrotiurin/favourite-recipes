---
paths:
  - "templates/servings.js"
  - "templates/shopping.js"
  - ".claude/skills/add-recipe/SKILL.md"
---

# Code that still exists twice

The ingredient line, the rounding of scaled amounts, `parseQuantity` / `neededAmount`, reading `shopping-list.json` and the recipe format's
rules (the zod schemas in `shared/recipe.ts`, `shared/catalogue.ts`) are one
implementation in `shared/` that the site's renderers and the backend both import (`docs/typescript-migration.md` 4.3). What is
left, until the migration reaches it:

| One side | Other side | Checked by |
| --- | --- | --- |
| `templates/servings.js` `format()` (browser script, can't import `.ts` yet) | `formatQuantity` in `shared/quantity.ts` | `shared/test/quantity.test.ts`; goes when servings becomes an island (step 6) |
| `need()` in `templates/shopping.js` (browser script) | `neededAmount` in `shared/shopping-list.ts` | `shared/test/shopping-list.test.ts`; goes when the shopping list becomes an island (step 7) |

`shopping.js`'s `formatNumber` / `withUnit` (how a quantity is written on the shopping page) is also its own, and the static page's
`fmtAmount` in `templates/shopping-list.js`: they belong to the shopping page's single render in step 7.

The recipe format's prose, `.claude/skills/add-recipe/SKILL.md` (and the schema in the root `CLAUDE.md`), describes what `shared/recipe.ts` enforces; change
them together until the skill is rewritten around the schema (`docs/typescript-migration.md` step 10).
