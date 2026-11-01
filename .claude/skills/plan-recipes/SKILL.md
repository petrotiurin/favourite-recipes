---
name: plan-recipes
description: Full flow for "what are we cooking": takes screenshots, links, pasted text and/or names of recipes we already have, adds the new ones as draft recipes, marks existing ones as current, builds the combined shopping list, and reports back with a summary. Use whenever the user hands over recipes to cook or shop for (screenshots, links, recipe names or descriptions), or asks for a shopping list for some recipes. Uses the recipes MCP server, not local files.
---

# Plan recipes

The steps for this flow ship with the recipes MCP server, so they are always in step with its tools.

1. Call the recipes MCP server's `get_workflow_guide` tool with `{ "name": "plan-recipes" }`.
2. Follow the guide it returns, step by step, for the user's request (and any screenshots or links they gave).

If the recipes MCP server's tools aren't available, tell the user it isn't connected (see `mcp-server/README.md` → "Connecting a client") and stop. Never edit `recipes/*.md` or `shopping-list.json` by hand instead.

The guide's source is `mcp-server/workflows/plan-recipes.md`: change the flow there, not here.
