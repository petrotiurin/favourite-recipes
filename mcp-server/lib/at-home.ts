// "What can I make with what's at home?" (docs/chatbot-design.md 11.3): ranks the book by how much of each recipe's ingredient list the stocktake
// on shopping-list.json says is already at home (have: true, or a positive amount). Plain matching on ingredient names; pantry staples
// (salt, oil, flour... see STAPLES in lib/recipes.ts) are assumed to be there and don't count either way. No model involved.
import { getShoppingList } from "./shopping-list.ts";
import { recipeIngredients, STAPLES } from "./recipes.ts";
import { sameIngredient } from "./ingredient-match.ts";
import { loadCatalogue } from "./catalogue.ts";
import type { Catalogue } from "../../shared/catalogue.ts";
import type { ShoppingList } from "../../shared/shopping-list.ts";

export { sameIngredient };

/** The names of the items the stocktake says are at home (all or some of them). */
export function atHomeNames(list: ShoppingList | null | undefined): string[] {
  if (!list?.stocktake) return [];
  return list.sections.flatMap((s) => s.items).filter((i) => i.have === true || (typeof i.have === "number" && i.have > 0)).map((i) => i.name);
}

/** One recipe of the at-home ranking. */
export interface HomeRow {
  slug: string;
  title: string;
  draft?: true;
  mins: number;
  kcal: number;
  have: number;
  total: number;
  missing: string[];
}

/** What recipesFromHome resolves. */
export interface HomeRanking {
  stocktake: string | null | undefined;
  home: string[];
  rows: HomeRow[];
}

/**
 * Recipes ranked by what is already at home: fewest missing first, then the larger share. Only recipes with at least one match.
 * Resolves { stocktake (ISO string or null), home (item names), rows: [{ slug, title, draft, mins, kcal, have, total, missing: [names] }] }.
 */
export async function recipesFromHome({ limit = 8, maxMissing = 99 }: { limit?: number; maxMissing?: number } = {}): Promise<HomeRanking> {
  const { list } = await getShoppingList();
  const home = atHomeNames(list);
  if (!list || !home.length) return { stocktake: list?.stocktake || null, home, rows: [] };
  const rows: HomeRow[] = [];
  const catalogue = await loadCatalogue().catch((): Catalogue => ({}));
  const homeNames = new Set(home.map((h) => h.trim().toLowerCase()));
  for (const r of await recipeIngredients()) {
    // By catalogue item first (the list's names come from the catalogue), then by words. Staples and never-bought items don't count.
    const byName = new Map<string, string>();
    for (const ing of r.items || []) {
      const entry = catalogue[ing.item];
      if (entry?.staple || entry?.skip || STAPLES.test(ing.name)) continue;
      const key = String(ing.name).trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, entry?.name?.toLowerCase() || "");
    }
    const counted = [...byName.keys()];
    if (!counted.length) continue;
    const missing = counted.filter((n) => !homeNames.has(byName.get(n) ?? "") && !home.some((h) => sameIngredient(h, n)));
    const have = counted.length - missing.length;
    if (!have || missing.length > maxMissing) continue;
    rows.push({ slug: r.slug, title: r.title, draft: r.draft, mins: r.total_mins, kcal: r.calories, have, total: counted.length, missing });
  }
  rows.sort((a, b) => a.missing.length - b.missing.length || b.have / b.total - a.have / a.total || a.title.localeCompare(b.title));
  return { stocktake: list.stocktake, home, rows: rows.slice(0, limit) };
}
