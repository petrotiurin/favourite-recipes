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

/**
 * Every item names the current recipes it is for (`recipes`: slugs), so the page can show which
 * dish each ingredient goes into. Each slug must be a current recipe, and every current recipe
 * must have at least one item (a recipe with nothing on the list was most likely left out).
 */
export function validateItemRecipes(sections, currentSlugs) {
  const current = new Set(currentSlugs);
  const used = new Set();
  const errors = [];
  for (const s of sections) {
    for (const item of s.items) {
      if (!item.recipes?.length) {
        errors.push(`"${item.name}": recipes is required: the slugs of the current recipes it is for`);
        continue;
      }
      for (const slug of item.recipes) {
        if (current.has(slug)) used.add(slug);
        else errors.push(`"${item.name}": "${slug}" is not a current recipe (current: ${[...current].join(", ")})`);
      }
    }
  }
  const missing = [...current].filter((slug) => !used.has(slug));
  if (missing.length && !errors.length) {
    errors.push(`no item is for ${missing.join(", ")}: every current recipe's ingredients must be on the list, each item naming its recipes`);
  }
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
        ...(item.recipes?.length ? { recipes: [...new Set(item.recipes)] } : {}),
      })),
    })),
  };
}

export const serializeShoppingList = (list) => `${JSON.stringify(list, null, 2)}\n`;

// --- Stocktake: what's already at home -------------------------------------------------------------
// Saved from the shopping page by a signed-in editor (api/stocktake.js). Each item may carry
// `have`: true (got enough of it) or a number (that much at home, in the item's own unit, e.g. 2 of
// "4" lemons or 150 of "400g" rice). `have` is an absolute amount, so it isn't rescaled with the
// servings selector. A new list from update_shopping_list starts without a stocktake.
// Keep parseQuantity in sync with templates/shopping-list.js.

export class StocktakeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** "400g" -> { amount: 400, unit: "g" }, "3" -> { amount: 3, unit: "" }, "2 heads" -> { amount: 2, unit: "heads" }; else null. */
export function parseQuantity(quantity) {
  const m = String(quantity ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([^\d\s].*)?$/);
  return m ? { amount: parseFloat(m[1]), unit: (m[2] || "").trim() } : null;
}

const itemKey = (item) => `${String(item?.name ?? "").trim().toLowerCase()}\n${String(item?.quantity ?? "").trim()}`;

/** What's left to buy for one item at the list's base servings: { status: "buy" | "partial" | "home", remaining }. */
export function remainingFor(item) {
  const q = parseQuantity(item.quantity);
  if (item.have === true) return { status: "home", remaining: 0 };
  if (typeof item.have !== "number" || !q) return { status: "buy", remaining: q?.amount ?? null };
  const remaining = Math.round((q.amount - item.have) * 100) / 100;
  return remaining > 0 ? { status: "partial", remaining } : { status: "home", remaining: 0 };
}

/**
 * Applies a stocktake sent by the page. `items` must be exactly the stored list's items (name +
 * quantity), so a page loaded before the agent replaced the list can't write onto the new one.
 */
export function applyStocktake(list, items, now = new Date()) {
  if (!list?.sections?.length) throw new StocktakeError("There is no shopping list to save a stocktake for.", 409);
  if (!Array.isArray(items)) throw new StocktakeError("items must be an array.");
  const sent = new Map(items.map((i) => [itemKey(i), i]));
  const stored = list.sections.flatMap((s) => s.items);
  if (sent.size !== items.length || sent.size !== stored.length || stored.some((i) => !sent.has(itemKey(i)))) {
    throw new StocktakeError("The shopping list has changed since this page was loaded. Reload the page and do the stocktake again.", 409);
  }
  const errors = [];
  const sections = list.sections.map((s) => ({
    ...s,
    items: s.items.map(({ have: _old, ...item }) => {
      const have = sent.get(itemKey(item)).have;
      if (have === undefined || have === false || have === 0) return item;
      if (have === true) return { ...item, have };
      if (typeof have !== "number" || !Number.isFinite(have) || have < 0) {
        errors.push(`"${item.name}": have must be true or a positive number`);
      } else if (!parseQuantity(item.quantity)) {
        errors.push(`"${item.name}" has no amount, so it can only be marked as at home (have: true)`);
      }
      return { ...item, have: Math.round(have * 100) / 100 };
    }),
  }));
  if (errors.length) throw new StocktakeError(`Stocktake rejected:\n- ${errors.join("\n- ")}`);
  return { ...list, stocktake: now.toISOString(), sections };
}

/** Commits the stocktake to shopping-list.json (one commit = one site deploy). */
export async function saveStocktake(items, now = new Date()) {
  const cs = new ChangeSet();
  const list = applyStocktake(await readStoredList(cs), items, now);
  cs.write(SHOPPING_LIST_PATH, Buffer.from(serializeShoppingList(list)));
  const all = list.sections.flatMap((s) => s.items);
  const counts = { home: 0, partial: 0 };
  for (const item of all) {
    const { status } = remainingFor(item);
    if (status in counts) counts[status]++;
  }
  const commit = await cs.commit(
    `Update shopping list stocktake (${counts.home} of ${all.length} items at home, ${counts.partial} partly)\n\nSaved from the shopping page.`
  );
  return { list, commit, counts };
}

const fmtAmount = (amount, unit) => `${amount}${!unit ? "" : /^(g|kg|ml|l)$/i.test(unit) ? unit : ` ${unit}`}`;

/** The stocktake as text for get_shopping_list: what to buy (at the 2-serving base) and what to skip. */
export function stocktakeLines(list) {
  if (!list?.sections?.length) return [];
  if (!list.stocktake) return ["Stocktake: none saved, so everything on the list is to buy."];
  const buy = [];
  const home = [];
  for (const s of list.sections) {
    for (const item of s.items) {
      const { status, remaining } = remainingFor(item);
      const q = parseQuantity(item.quantity);
      const note = item.note ? ` (${item.note})` : "";
      if (status === "home") home.push(`- ${item.name}${item.quantity ? `: ${item.quantity}` : ""}`);
      else if (status === "partial") buy.push(`- ${s.name} / ${item.name}: ${fmtAmount(remaining, q.unit)}${note} [have ${fmtAmount(item.have, q.unit)} of ${item.quantity}]`);
      else buy.push(`- ${s.name} / ${item.name}${item.quantity ? `: ${item.quantity}` : ""}${note}`);
    }
  }
  return [
    `Stocktake saved ${list.stocktake}: the user has marked what's already at home.`,
    "To buy (2 servings of each recipe; buy only these amounts):",
    ...(buy.length ? buy : ["- nothing: everything is at home"]),
    "",
    "Already at home (skip):",
    ...(home.length ? home : ["- nothing"]),
  ];
}

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
  validateItemRecipes(sections, current.map((r) => r.slug));
  const list = buildShoppingList(sections, current.map((r) => r.slug));
  cs.write(SHOPPING_LIST_PATH, Buffer.from(serializeShoppingList(list)));
  const subject = `Update shopping list (${current.length} current recipe${current.length === 1 ? "" : "s"})`;
  const commit = batch ? null : await cs.commit(`${subject}\n\nUpdated via the recipes MCP server.`);
  return { list, current, commit, subject };
}
