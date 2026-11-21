---
paths:
  - "build.js"
  - "templates/ingredients.js"
  - "templates/servings.js"
  - "templates/shopping.js"
  - "templates/shopping-list.js"
  - "mcp-server/lib/ingredient-line.js"
  - "mcp-server/lib/scaling.js"
  - "mcp-server/lib/shopping-list.js"
  - "mcp-server/lib/recipe-format.js"
  - ".claude/skills/add-recipe/SKILL.md"
---

# Code that exists twice

The site's build and browser scripts can't import the backend's modules (and the reverse), so a few pieces are written twice. When
you change one side, change the other in the same change:

| Site | Backend | Checked by |
| --- | --- | --- |
| `templates/ingredients.js` (the ingredient line) | `mcp-server/lib/ingredient-line.js` | `mcp-server/test/ingredients.test.js`, over the whole book |
| `templates/servings.js` (rounding of scaled amounts) | `formatQuantity` in `mcp-server/lib/scaling.js` | `mcp-server/test/phase6.test.js` |
| `loadShoppingList` in `build.js` | `loadShoppingList` in `mcp-server/lib/shopping-list.js` | nothing: check by hand when the list format changes |
| `parseQuantity` / `neededAmount` in `templates/shopping-list.js`, `need()` in `templates/shopping.js` | `parseQuantity` / `neededAmount` in `mcp-server/lib/shopping-list.js` | nothing: check by hand |
| The recipe format in `.claude/skills/add-recipe/SKILL.md` (and the schema in the root `CLAUDE.md`) | `mcp-server/lib/recipe-format.js` | nothing: check by hand |
