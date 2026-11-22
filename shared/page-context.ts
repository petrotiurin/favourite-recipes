// The JSON every page embeds for the chat (`<script type="application/json" id="page-context">`, written by the layout, read by
// templates/chat.cjs) and what the chat sends the server as `page` (that JSON plus the live state of the page). The server never
// trusts it: `pageNote` in mcp-server/lib/chat.js re-resolves a recipe's slug against the book.
import { z } from "zod";
import { COURSES } from "./recipe.ts";

/** What the layout bakes in: which page this is, and for a recipe page which recipe. */
export const pageContextSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("index") }),
  z.object({ page: z.literal("next-week") }),
  z.object({ page: z.literal("shopping") }),
  z.object({ page: z.literal("recipe"), slug: z.string(), title: z.string() }),
]);
export type PageContext = z.infer<typeof pageContextSchema>;

/**
 * The `page` the chat sends with every message: the page context plus what the visitor has done on it (servings picked on a recipe,
 * the search text and course filter on the home page), or `{ page, dismissed: true }` when they closed the "about this page" chip.
 */
export const chatPageSchema = z.union([
  z.object({ page: z.enum(["index", "next-week", "shopping", "recipe"]), dismissed: z.literal(true) }),
  z.object({ page: z.literal("recipe"), slug: z.string(), servings: z.number().int().positive().optional() }),
  z.object({ page: z.literal("index"), search: z.string().optional(), filter: z.enum(COURSES).optional() }),
  z.object({ page: z.literal("next-week") }),
  z.object({ page: z.literal("shopping") }),
]);
export type ChatPage = z.infer<typeof chatPageSchema>;
