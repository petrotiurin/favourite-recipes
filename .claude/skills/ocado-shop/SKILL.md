---
name: ocado-shop
description: Fill the Ocado basket from the site's shopping list (or a list the user pastes/screenshots) using Claude in Chrome. Uses the Ocado favourites page first, then search, applies the family's star-rating cutoff and non-negotiable product preferences, and never checks out. Use whenever the user asks to "shop at Ocado", "order the shopping list" or "add the list to the basket".
---

# Ocado shop

The steps for this flow ship with the recipes MCP server, so they are always in step with its shopping list.

1. Call the recipes MCP server's `get_workflow_guide` tool with `{ "name": "ocado-shop" }`.
2. Follow the guide it returns, step by step, for the user's request (and any extras or pasted list they gave).

If the recipes MCP server's tools aren't available, tell the user it isn't connected (see `mcp-server/README.md` → "Connecting a client") and stop.

The guide's source is `mcp-server/workflows/ocado-shop.md`, plus the rules shared with the other shops in `mcp-server/workflows/shared/`: change the flow there, not here.
