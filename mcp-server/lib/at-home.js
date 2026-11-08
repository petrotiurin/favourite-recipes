// "What can I make with what's at home?" (docs/chatbot-design.md 11.3): ranks the book by how much of each recipe's ingredient list the stocktake
// on shopping-list.json says is already at home (have: true, or a positive amount). Plain matching on ingredient names; pantry staples
// (salt, oil, flour... see STAPLES in lib/recipes.js) are assumed to be there and don't count either way. No model involved.
import { getShoppingList } from "./shopping-list.js";
import { recipeIngredients, STAPLES } from "./recipes.js";

const norm = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("oes") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");

/** Does the at-home item cover the recipe ingredient? Same words, or one name contains the other as whole words ("cherry tomatoes" ~ "tomatoes"). */
export function sameIngredient(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const has = (long, short) => ` ${long} `.includes(` ${short} `);
  return has(x, y) || has(y, x);
}

/** The names of the items the stocktake says are at home (all or some of them). */
export function atHomeNames(list) {
  if (!list?.stocktake) return [];
  return list.sections.flatMap((s) => s.items).filter((i) => i.have === true || (typeof i.have === "number" && i.have > 0)).map((i) => i.name);
}

/**
 * Recipes ranked by what is already at home: fewest missing first, then the larger share. Only recipes with at least one match.
 * Resolves { stocktake (ISO string or null), home (item names), rows: [{ slug, title, draft, mins, kcal, have, total, missing: [names] }] }.
 */
export async function recipesFromHome({ limit = 8, maxMissing = 99 } = {}) {
  const { list } = await getShoppingList();
  const home = atHomeNames(list);
  if (!home.length) return { stocktake: list?.stocktake || null, home, rows: [] };
  const rows = [];
  for (const r of await recipeIngredients()) {
    const counted = [...new Set(r.ingredients.filter((n) => !STAPLES.test(n)).map((n) => n.toLowerCase()))];
    if (!counted.length) continue;
    const missing = counted.filter((n) => !home.some((h) => sameIngredient(h, n)));
    const have = counted.length - missing.length;
    if (!have || missing.length > maxMissing) continue;
    rows.push({ slug: r.slug, title: r.title, draft: r.draft, mins: r.total_mins, kcal: r.calories, have, total: counted.length, missing });
  }
  rows.sort((a, b) => a.missing.length - b.missing.length || b.have / b.total - a.have / a.total || a.title.localeCompare(b.title));
  return { stocktake: list.stocktake, home, rows: rows.slice(0, limit) };
}
