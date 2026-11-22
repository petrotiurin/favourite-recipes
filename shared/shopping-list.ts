// What the site and the backend both need to know about shopping-list.json (written by the backend, .claude/rules/shopping-list.md; shown
// by the site): reading the file, the quantity text and how much the planned servings need. The browser's templates/shopping.js still has
// its own need() until it becomes an island (docs/typescript-migration.md step 7); shared/test/shopping-list.test.ts checks it against
// neededAmount here.

// Every quantity on the list is written for BASE_SERVINGS of each recipe; the page and the backend rescale from it. The list's `servings`
// plans each recipe (set by the agent), and a recipe without a plan gets DEFAULT_SERVINGS.
export const BASE_SERVINGS = 2;
export const DEFAULT_SERVINGS = 4;

export interface ShoppingItem {
  name: string;
  quantity?: string;
  note?: string;
  /** Slugs of the next-week recipes the item is for. */
  recipes?: string[];
  /** slug -> how much of `quantity` (2 servings) that recipe needs, for an item with several recipes. */
  amounts?: Record<string, number> | null;
  /** At home: true (enough) or how much (in the item's unit), from the stocktake. */
  have?: boolean | number;
}
export interface ShoppingSection {
  name: string;
  items: ShoppingItem[];
}
export interface ShoppingList {
  updated?: string;
  recipes?: string[];
  servings?: Record<string, number>;
  stocktake?: string;
  sections: ShoppingSection[];
}
/** slug -> planned servings. */
export type Plan = Record<string, number>;

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
export function neededAmount(item: Pick<ShoppingItem, "quantity" | "amounts" | "recipes">, plan: Plan): number | null {
  const q = parseQuantity(item.quantity);
  if (!q) return null;
  const servingsOf = (slug: string) => plan[slug] || DEFAULT_SERVINGS;
  if (item.amounts) return Object.entries(item.amounts).reduce((n, [slug, a]) => n + (a * servingsOf(slug)) / BASE_SERVINGS, 0);
  const slugs = item.recipes?.length ? item.recipes : Object.keys(plan);
  const mean = slugs.length ? slugs.reduce((n, slug) => n + servingsOf(slug), 0) / slugs.length : DEFAULT_SERVINGS;
  return (q.amount * mean) / BASE_SERVINGS;
}
