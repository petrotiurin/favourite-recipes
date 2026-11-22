---
paths:
  - "templates/servings.js"
  - "templates/shopping.js"
  - "mcp-server/lib/recipe-format.js"
  - ".claude/skills/add-recipe/SKILL.md"
---

# Code that still exists twice

The ingredient line, the rounding of scaled amounts, `parseQuantity` / `neededAmount` and reading `shopping-list.json` are one
implementation in `shared/` that the site's renderers and the backend both import (`docs/typescript-migration.md` 4.3). What is
left, until the migration reaches it:

| One side | Other side | Checked by |
| --- | --- | --- |
| `templates/servings.js` `format()` (browser script, can't import `.ts` yet) | `formatQuantity` in `shared/quantity.ts` | `shared/test/quantity.test.ts`; goes when servings becomes an island (step 6) |
| `need()` in `templates/shopping.js` (browser script) | `neededAmount` in `shared/shopping-list.ts` | `shared/test/shopping-list.test.ts`; goes when the shopping list becomes an island (step 7) |
| The recipe format in `.claude/skills/add-recipe/SKILL.md` (and the schema in the root `CLAUDE.md`), prose | `mcp-server/lib/recipe-format.js`, the code that writes recipes | nothing: check by hand; the zod schema (step 3) and the skill rewrite (step 10) end this |

`shopping.js`'s `formatNumber` / `withUnit` (how a quantity is written on the shopping page) is also its own, and the static page's
`fmtAmount` in `templates/shopping-list.js`: they belong to the shopping page's single render in step 7.
