// What the site and the backend both need to know about shopping-list.json (written by the backend, .claude/rules/shopping-list.md; shown
// by the site): the schemas and reading the file. The quantity text and how much the planned servings need (parseQuantity, neededAmount) are in
// shopping-quantity.ts, which has no zod in it, so the shopping island in the browser can use them; they are re-exported from here.

import { z } from "zod";
export { BASE_SERVINGS, DEFAULT_SERVINGS, neededAmount, parseQuantity, type Plan } from "./shopping-quantity.ts";

export const shoppingItemSchema = z.object({
  name: z.string(),
  quantity: z.string().optional(),
  note: z.string().optional(),
  /** Slugs of the next-week recipes the item is for. */
  recipes: z.array(z.string()).optional(),
  /** slug -> how much of `quantity` (2 servings) that recipe needs, for an item with several recipes; null for one that only seasons it ("to taste"). */
  amounts: z.record(z.string(), z.number().nullable()).nullable().optional(),
  /** At home: true (enough) or how much (in the item's unit), from the stocktake. */
  have: z.union([z.boolean(), z.number()]).optional(),
});
export const shoppingSectionSchema = z.object({ name: z.string(), items: z.array(shoppingItemSchema) });
export const shoppingListSchema = z.object({
  updated: z.string().optional(),
  recipes: z.array(z.string()).optional(),
  /** The plan: slug -> how many people each recipe is cooked for. */
  servings: z.record(z.string(), z.number()).optional(),
  stocktake: z.string().optional(),
  sections: z.array(shoppingSectionSchema),
});
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;
export type ShoppingSection = z.infer<typeof shoppingSectionSchema>;
export type ShoppingList = z.infer<typeof shoppingListSchema>;

/**
 * The saved list from the text of shopping-list.json: the sections that have a name and items, or null when the text isn't JSON, isn't a
 * list or has no usable section (so there is nothing to show or to take a stocktake of). `warn` hears why a file was thrown away.
 */
export function loadShoppingList(text: string | null | undefined, warn?: (message: string) => void): ShoppingList | null {
  if (!text) return null;
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch (err) {
    warn?.(`Ignoring shopping-list.json: ${(err as Error).message}`);
    return null;
  }
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    warn?.("Ignoring shopping-list.json: it isn't an object");
    return null;
  }
  const raw = (list as { sections?: unknown }).sections;
  const sections = (Array.isArray(raw) ? raw : []).filter((s): s is ShoppingSection => !!s && !!s.name && Array.isArray(s.items) && s.items.length > 0);
  if (!sections.length) return null;
  return { ...(list as object), sections } as ShoppingList;
}
