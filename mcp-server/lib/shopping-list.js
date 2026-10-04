import { ChangeSet } from "./github.js";
import { listRecipes, isCurrent } from "./recipes.js";
import { config, SHOPPING_LIST_PATH } from "./config.js";

// The agent combines the current recipes' ingredients itself; this module only
// validates and stores the result as shopping-list.json at the repo root, which
// build.js turns into shopping-list.html. The file records which current recipes
// (drafts + recipes marked current) it was built from, and the site shows it only
// while that still matches the recipes that are current now (keep in sync with
// loadShoppingList in build.js).

export const shoppingPageUrl = () => `${config.siteUrl}/shopping-list.html`;

export class ShoppingListError extends Error {}

// Kitchen measures the shopping list must not use: the agent converts them to g / ml / counts (recipes keep theirs).
const KITCHEN_MEASURE = /\b(tbsps?|tsps?|tablespoons?|teaspoons?|cups?|oz|ounces?|lbs?|pounds?|heaped|pinch(es)?|handfuls?)\b/i;

export function validateSections(sections) {
  const errors = [];
  if (!sections?.length) errors.push("sections: at least one section is required");
  const seen = new Map();
  (sections || []).forEach((s, i) => {
    if (!s.name?.trim()) errors.push(`sections[${i}]: name is required (e.g. "Fresh produce")`);
    if (!s.items?.length) errors.push(`sections[${i}] "${s.name}": at least one item is required`);
    (s.items || []).forEach((item, j) => {
      if (item.quantity && KITCHEN_MEASURE.test(item.quantity)) {
        errors.push(`"${item.name}": quantity "${item.quantity}" uses a kitchen measure: convert it to g or ml (or a count) and add the amounts into ONE number`);
      } else if (item.quantity && item.quantity.includes("+")) {
        errors.push(`"${item.name}": quantity "${item.quantity}" mixes amounts: add them up into one number in one unit`);
      }
      const key = item.name?.trim().toLowerCase();
      if (!key) {
        errors.push(`sections[${i}].items[${j}]: name is required`);
      } else if (seen.has(key)) {
        errors.push(`"${item.name}" is listed twice (${seen.get(key)} and "${s.name}"): combine it into one line with the total quantity`);
      } else {
        seen.set(key, `"${s.name}"`);
      }
    });
  });
  if (errors.length) throw new ShoppingListError(`Shopping list rejected:\n- ${errors.join("\n- ")}`);
}

export function buildShoppingList(sections, currentSlugs, now = new Date()) {
  return {
    updated: now.toISOString().slice(0, 10),
    recipes: [...currentSlugs].sort(),
    sections: sections.map((s) => ({
      name: s.name.trim(),
      items: s.items.map((item) => ({
        name: item.name.trim(),
        ...(item.quantity?.trim() ? { quantity: item.quantity.trim() } : {}),
        ...(item.note?.trim() ? { note: item.note.trim() } : {}),
      })),
    })),
  };
}

export const serializeShoppingList = (list) => `${JSON.stringify(list, null, 2)}\n`;

/**
 * "current" when the stored list covers exactly the recipes that are current now, "outdated" when the set has
 * changed since (the site keeps showing the old list until it is rewritten), "none" when there's no list.
 */
export function shoppingListStatus(list, currentSlugs) {
  if (!list || !Array.isArray(list.sections) || !list.sections.length) return "none";
  const covered = [...(list.recipes || [])].sort().join("\n");
  return covered === [...currentSlugs].sort().join("\n") ? "current" : "outdated";
}

async function readStoredList(cs) {
  const raw = await cs.read(SHOPPING_LIST_PATH);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

export async function getShoppingList(cs = new ChangeSet()) {
  const [list, recipes] = await Promise.all([readStoredList(cs), listRecipes(cs)]);
  const current = recipes.filter(isCurrent);
  return { list, current, status: shoppingListStatus(list, current.map((r) => r.slug)) };
}

/** Without a ChangeSet it commits straight away; with one (batch_changes) it only stages the file. */
export async function updateShoppingList(sections, batch) {
  const cs = batch || new ChangeSet();
  validateSections(sections);
  const current = (await listRecipes(cs)).filter(isCurrent);
  if (!current.length) {
    throw new ShoppingListError(
      "There are no current recipes, so there is nothing to shop for. Add a draft, or mark recipes current with set_current_recipes. The shopping page stays blank until then."
    );
  }
  const list = buildShoppingList(sections, current.map((r) => r.slug));
  cs.write(SHOPPING_LIST_PATH, Buffer.from(serializeShoppingList(list)));
  const subject = `Update shopping list (${current.length} current recipe${current.length === 1 ? "" : "s"})`;
  const commit = batch ? null : await cs.commit(`${subject}\n\nUpdated via the recipes MCP server.`);
  return { list, current, commit, subject };
}
