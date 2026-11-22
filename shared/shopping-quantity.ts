// The shopping list's quantity text and how much the planned servings need. Their own file, with no zod in it, so the shopping island in the
// browser can import them (a browser module must not import a shared/ file that imports zod: shopping-list.ts has the schemas).
import { BASE_SERVINGS, DEFAULT_SERVINGS } from "./servings.ts";

// Every quantity on the list is for BASE_SERVINGS of each recipe, and a recipe without a plan gets DEFAULT_SERVINGS (shared/servings.ts).
export { BASE_SERVINGS, DEFAULT_SERVINGS };

/** slug -> planned servings. */
export type Plan = Record<string, number>;

/** The fields of a list item that decide how much of it is needed (the zod `ShoppingItem` in shopping-list.ts has them). */
export interface QuantifiedItem {
  quantity?: string;
  /** slug -> how much of `quantity` (2 servings) that recipe needs; null for one that only seasons it. */
  amounts?: Record<string, number | null> | null;
  recipes?: string[];
}

/** "400g" -> { amount: 400, unit: "g" }, "3" -> { amount: 3, unit: "" }, "2 heads" -> { amount: 2, unit: "heads" }; else null. */
export function parseQuantity(quantity: unknown): { amount: number; unit: string } | null {
  const m = String(quantity ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([^\d\s].*)?$/);
  return m ? { amount: parseFloat(m[1]), unit: (m[2] || "").trim() } : null;
}

/**
 * How much of an item the plan needs, in the item's unit and not rounded: each recipe's share of the 2-serving quantity (`amounts`, or the
 * whole quantity for a one-recipe item) times its servings / BASE_SERVINGS. Items without `amounts` (older lists) scale by the average of
 * their recipes' servings. null without an amount.
 */
export function neededAmount(item: QuantifiedItem, plan: Plan): number | null {
  const q = parseQuantity(item.quantity);
  if (!q) return null;
  const servingsOf = (slug: string) => plan[slug] || DEFAULT_SERVINGS;
  if (item.amounts) return Object.entries(item.amounts).reduce((n, [slug, a]) => n + ((a ?? 0) * servingsOf(slug)) / BASE_SERVINGS, 0);
  const slugs = item.recipes?.length ? item.recipes : Object.keys(plan);
  const mean = slugs.length ? slugs.reduce((n, slug) => n + servingsOf(slug), 0) / slugs.length : DEFAULT_SERVINGS;
  return (q.amount * mean) / BASE_SERVINGS;
}
