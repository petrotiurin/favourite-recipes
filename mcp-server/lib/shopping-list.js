import { ChangeSet, assertCanCommit } from "./github.js";
import { listRecipes, isNextWeek } from "./recipes.js";
import { config, SHOPPING_LIST_PATH } from "./config.js";

// The shopping list is for NEXT WEEK's recipes (`next: true`). The agent combines their
// ingredients itself; this module only validates and stores the result as shopping-list.json
// at the repo root, which build.js turns into shopping-list.html. The file records which
// recipes it was built from. The site shows the saved list until a new one is saved: after
// the switch (start_next_week) those recipes are this week's and the list stays, so it
// covers this week until next week is planned and a new list saved (keep in sync with
// loadShoppingList in build.js).

export const shoppingPageUrl = () => `${config.siteUrl}/shopping-list.html`;

// Every quantity on the list is written for BASE_SERVINGS of each recipe. The list also stores
// `servings` (slug -> how many people each recipe is cooked for this week, set by the agent):
// the page opens on that plan and rescales each recipe's share of every item. A recipe without
// a planned value gets DEFAULT_SERVINGS. Keep these in sync with templates/shopping-list.js.
export const BASE_SERVINGS = 2;
export const DEFAULT_SERVINGS = 4;
export const MAX_SERVINGS = 12;

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
 * Every item names the next-week recipes it is for (`recipes`: slugs), so the page can show which
 * dish each ingredient goes into. Each slug must be a next-week recipe, and every next-week recipe
 * must have at least one item (a recipe with nothing on the list was most likely left out).
 */
export function validateItemRecipes(sections, nextSlugs) {
  const next = new Set(nextSlugs);
  const used = new Set();
  const errors = [];
  for (const s of sections) {
    for (const item of s.items) {
      if (!item.recipes?.length) {
        errors.push(`"${item.name}": recipes is required: the slugs of the next-week recipes it is for`);
        continue;
      }
      for (const slug of item.recipes) {
        if (next.has(slug)) used.add(slug);
        else errors.push(`"${item.name}": "${slug}" is not a next-week recipe (next week: ${[...next].join(", ")})`);
      }
      errors.push(...amountErrors(item));
    }
  }
  const missing = [...next].filter((slug) => !used.has(slug));
  if (missing.length && !errors.length) {
    errors.push(`no item is for ${missing.join(", ")}: every next-week recipe's ingredients must be on the list, each item naming its recipes`);
  }
  if (errors.length) throw new ShoppingListError(`Shopping list rejected:\n- ${errors.join("\n- ")}`);
}

/**
 * An item for several recipes says how much of its (2-serving) quantity each one needs
 * (`amounts`: slug -> number in the item's unit), so the page can scale each recipe on its own.
 * They must add up to the quantity. A one-recipe item doesn't need it.
 */
function amountErrors(item) {
  const slugs = [...new Set(item.recipes)];
  const q = parseQuantity(item.quantity);
  const example = `e.g. amounts: { ${slugs.slice(0, 2).map((s, i) => `"${s}": ${i ? 1 : 2}`).join(", ")} }`;
  if (!item.amounts || !Object.keys(item.amounts).length) {
    return slugs.length > 1 && q
      ? [`"${item.name}": amounts is required for an item with several recipes: how much of "${item.quantity}" (2 servings) each recipe needs, in the same unit, ${example}`]
      : [];
  }
  if (!q) return [`"${item.name}": amounts needs a quantity that is one number (and unit), e.g. "400g" or "3"`];
  const keys = Object.keys(item.amounts);
  const errors = [];
  const extra = keys.filter((k) => !slugs.includes(k));
  const missing = slugs.filter((k) => !keys.includes(k));
  if (extra.length || missing.length) {
    errors.push(`"${item.name}": amounts must have exactly the item's recipes (${slugs.join(", ")})${missing.length ? `, missing ${missing.join(", ")}` : ""}${extra.length ? `, not in recipes: ${extra.join(", ")}` : ""}`);
  }
  if (keys.some((k) => !(item.amounts[k] > 0))) errors.push(`"${item.name}": every amount must be a positive number`);
  const total = keys.reduce((n, k) => n + (Number(item.amounts[k]) || 0), 0);
  if (!errors.length && Math.abs(total - q.amount) > Math.max(0.05, q.amount * 0.01)) {
    errors.push(`"${item.name}": amounts add up to ${round(total)}, but quantity is "${item.quantity}": they must match`);
  }
  return errors;
}

const round = (n) => Math.round(n * 100) / 100;

/** The planned servings for each of `slugs`: the given ones, else what `previous` planned, else DEFAULT_SERVINGS. */
export function resolveServings(slugs, given = {}, previous = {}) {
  return Object.fromEntries([...slugs].sort().map((slug) => [slug, given[slug] ?? previous?.[slug] ?? DEFAULT_SERVINGS]));
}

export function validateServings(servings, allowed, what) {
  const ok = new Set(allowed);
  const errors = Object.entries(servings || {}).flatMap(([slug, n]) => [
    ...(ok.has(slug) ? [] : [`servings: "${slug}" is not ${what} (${[...ok].join(", ")})`]),
    ...(Number.isInteger(n) && n >= 1 && n <= MAX_SERVINGS ? [] : [`servings: "${slug}" must be a whole number from 1 to ${MAX_SERVINGS}`]),
  ]);
  if (errors.length) throw new ShoppingListError(`Servings rejected:\n- ${errors.join("\n- ")}`);
}

export function buildShoppingList(sections, slugs, now = new Date(), servings = resolveServings(slugs)) {
  return {
    updated: now.toISOString().slice(0, 10),
    recipes: [...slugs].sort(),
    servings,
    sections: sections.map((s) => ({
      name: s.name.trim(),
      items: s.items.map((item) => {
        const recipes = [...new Set(item.recipes || [])];
        const amounts = recipes.length > 1 && item.amounts ? Object.fromEntries(recipes.map((slug) => [slug, round(item.amounts[slug])])) : null;
        return {
          name: item.name.trim(),
          ...(item.quantity?.trim() ? { quantity: item.quantity.trim() } : {}),
          ...(item.note?.trim() ? { note: item.note.trim() } : {}),
          ...(recipes.length ? { recipes } : {}),
          ...(amounts ? { amounts } : {}),
        };
      }),
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

/** slug -> planned servings for every recipe the list covers (DEFAULT_SERVINGS where it has none, e.g. older lists). */
export const planOf = (list) => resolveServings(list?.recipes || [], list?.servings || {});

/**
 * How much of an item the plan needs: each recipe's share of the 2-serving quantity (`amounts`, or
 * the whole quantity for a one-recipe item) scaled by its servings / BASE_SERVINGS. Items without
 * `amounts` (older lists) scale by the average of their recipes' servings. null without an amount.
 * Keep in sync with neededAmount in templates/shopping-list.js and templates/shopping.js.
 */
export function neededAmount(item, plan) {
  const q = parseQuantity(item.quantity);
  if (!q) return null;
  const servingsOf = (slug) => plan[slug] ?? DEFAULT_SERVINGS;
  if (item.amounts) return round(Object.entries(item.amounts).reduce((n, [slug, a]) => n + (a * servingsOf(slug)) / BASE_SERVINGS, 0));
  const slugs = item.recipes?.length ? item.recipes : Object.keys(plan);
  const mean = slugs.length ? slugs.reduce((n, slug) => n + servingsOf(slug), 0) / slugs.length : DEFAULT_SERVINGS;
  return round((q.amount * mean) / BASE_SERVINGS);
}

/** What's left to buy for one item at the planned servings: { status: "buy" | "partial" | "home", need, remaining }. */
export function remainingFor(item, plan = {}) {
  const need = neededAmount(item, plan);
  if (item.have === true) return { status: "home", need, remaining: 0 };
  if (typeof item.have !== "number" || need === null) return { status: "buy", need, remaining: need };
  const remaining = round(need - item.have);
  return remaining > 0 ? { status: "partial", need, remaining } : { status: "home", need, remaining: 0 };
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
export async function saveStocktake(items, caller, now = new Date()) {
  assertCanCommit(caller); // defence in depth: callers must say who they are, see lib/tools.js
  const cs = new ChangeSet();
  const list = applyStocktake(await readStoredList(cs), items, now);
  cs.write(SHOPPING_LIST_PATH, Buffer.from(serializeShoppingList(list)));
  const all = list.sections.flatMap((s) => s.items);
  const counts = { home: 0, partial: 0 };
  const plan = planOf(list);
  for (const item of all) {
    const { status } = remainingFor(item, plan);
    if (status in counts) counts[status]++;
  }
  const commit = await cs.commit(
    `Update shopping list stocktake (${counts.home} of ${all.length} items at home, ${counts.partial} partly)\n\nSaved from the shopping page.`,
    caller
  );
  return { list, commit, counts };
}

const fmtAmount = (amount, unit) => `${amount}${!unit ? "" : /^(g|kg|ml|l)$/i.test(unit) ? unit : ` ${unit}`}`;

/** The planned servings as text, e.g. "- spicy-tuna-loaded-sweet-potato: 1". */
export const servingsLines = (list) => Object.entries(planOf(list)).map(([slug, n]) => `- ${slug}: ${n}`);

/** What to buy at the planned servings (minus the stocktake, if any) and what to skip, for get_shopping_list. */
export function stocktakeLines(list) {
  if (!list?.sections?.length) return [];
  const plan = planOf(list);
  const buy = [];
  const home = [];
  for (const s of list.sections) {
    for (const item of s.items) {
      const { status, need, remaining } = remainingFor(item, plan);
      const q = parseQuantity(item.quantity);
      const note = item.note ? ` (${item.note})` : "";
      const needText = q ? fmtAmount(need, q.unit) : item.quantity;
      if (status === "home") home.push(`- ${item.name}${needText ? `: ${needText}` : ""}`);
      else if (status === "partial") buy.push(`- ${s.name} / ${item.name}: ${fmtAmount(remaining, q.unit)}${note} [have ${fmtAmount(item.have, q.unit)} of ${needText}]`);
      else buy.push(`- ${s.name} / ${item.name}${needText ? `: ${needText}` : ""}${note}`);
    }
  }
  return [
    "Planned servings per recipe (the page opens on these; the user can change them there):",
    ...servingsLines(list),
    "",
    list.stocktake
      ? `Stocktake saved ${list.stocktake}: the user has marked what's already at home.`
      : "Stocktake: none saved, so everything on the list is to buy.",
    "To buy, at the planned servings (buy only these amounts):",
    ...(buy.length ? buy : ["- nothing: everything is at home"]),
    ...(list.stocktake ? ["", "Already at home (skip):", ...(home.length ? home : ["- nothing"])] : []),
  ];
}

/**
 * "current" when the stored list covers exactly next week's recipes, "outdated" when next week has changed since
 * (the site keeps showing the old list until it is rewritten), "not planned" when next week is empty (e.g. just
 * after start_next_week: the page keeps showing the last list, now for this week), "none" when there's no list.
 */
export function shoppingListStatus(list, nextSlugs) {
  if (!list || !Array.isArray(list.sections) || !list.sections.length) return "none";
  if (!nextSlugs.length) return "not planned";
  const covered = [...(list.recipes || [])].sort().join("\n");
  return covered === [...nextSlugs].sort().join("\n") ? "current" : "outdated";
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
  const next = recipes.filter(isNextWeek);
  return { list, next, status: shoppingListStatus(list, next.map((r) => r.slug)) };
}

/**
 * Without a ChangeSet it commits straight away; with one (batch_changes) it only stages the file.
 * `servings` (slug -> people) plans individual recipes; the others keep what the previous list
 * planned for them, else DEFAULT_SERVINGS.
 */
export async function updateShoppingList(sections, batch, servings = {}, caller) {
  assertCanCommit(caller); // defence in depth: callers must say who they are, see lib/tools.js
  const cs = batch || new ChangeSet();
  validateSections(sections);
  const next = (await listRecipes(cs)).filter(isNextWeek);
  if (!next.length) {
    throw new ShoppingListError(
      'Next week has no recipes, so there is nothing to shop for. Plan it first: create_recipe with week: "next", or set_week_recipes with week: "next". The page keeps showing the last list until then.'
    );
  }
  const slugs = next.map((r) => r.slug);
  validateServings(servings, slugs, "a next-week recipe");
  validateItemRecipes(sections, slugs);
  const previous = await readStoredList(cs);
  const list = buildShoppingList(sections, slugs, new Date(), resolveServings(slugs, servings, previous?.servings));
  cs.write(SHOPPING_LIST_PATH, Buffer.from(serializeShoppingList(list)));
  const subject = `Update shopping list (${next.length} next-week recipe${next.length === 1 ? "" : "s"})`;
  const commit = batch ? null : await cs.commit(`${subject}\n\nUpdated via the recipes MCP server.`, caller);
  return { list, next, commit, subject };
}

/**
 * Changes how many people individual recipes on the saved list are planned for (slug -> servings),
 * without rebuilding the list: quantities stay at the 2-serving base and the stocktake (absolute
 * amounts) is kept. The page opens on the new plan once the site redeploys.
 */
export async function setShoppingServings(servings, batch, caller) {
  assertCanCommit(caller); // defence in depth: callers must say who they are, see lib/tools.js
  const cs = batch || new ChangeSet();
  const list = await readStoredList(cs);
  if (!list?.sections?.length) {
    throw new ShoppingListError("There is no shopping list yet: build one with update_shopping_list (it takes servings too).");
  }
  if (!Object.keys(servings || {}).length) throw new ShoppingListError("servings: give at least one recipe, e.g. { \"slug\": 1 }");
  validateServings(servings, list.recipes || [], "on the shopping list");
  const before = planOf(list);
  const changed = Object.entries(servings).filter(([slug, n]) => before[slug] !== n);
  if (!changed.length) return { list, changed, commit: null, subject: null };
  const updated = { ...list, servings: resolveServings(list.recipes, servings, before) };
  cs.write(SHOPPING_LIST_PATH, Buffer.from(serializeShoppingList(updated)));
  const subject = `Set shopping list servings (${changed.map(([slug, n]) => `${slug}: ${n}`).join(", ")})`;
  const commit = batch ? null : await cs.commit(`${subject}\n\nUpdated via the recipes MCP server.`, caller);
  return { list: updated, changed, commit, subject };
}
