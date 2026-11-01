---
name: sainsburys-shop
description: Fill the Sainsbury's trolley from the site's shopping list (or a list the user pastes/screenshots) using Claude in Chrome. Searches through Sainsbury's own product API, picks with Nectar prices, the family's star-rating cutoff and non-negotiable product preferences, adds on product pages, and never checks out. Use whenever the user asks to "shop at Sainsbury's", "order the list from Sainsbury's" or "add the list to the Sainsbury's trolley".
---

# Sainsbury's shop

The steps for this flow ship with the recipes MCP server, so they are always in step with its shopping list.

1. Call the recipes MCP server's `get_workflow_guide` tool with `{ "name": "sainsburys-shop" }`.
2. Follow the guide it returns, step by step, for the user's request (and any extras or pasted list they gave).

If the recipes MCP server's tools aren't available, tell the user it isn't connected (see `mcp-server/README.md` → "Connecting a client") and stop.

The guide's source is `mcp-server/workflows/sainsburys-shop.md`, plus the rules shared with the other shops in `mcp-server/workflows/shared/`: change the flow there, not here.
