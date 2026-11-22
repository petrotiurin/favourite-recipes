// The ingredient catalogue, data/ingredients.json (docs/structured-ingredients.md sections 2, 4 and 5): one entry per thing we buy, keyed by
// a stable id, with its shopping-list name, aisle, shopping unit, how recipe units convert to it and the other names recipes use for it.
// Every recipe ingredient points at one (`item`). Only the server writes the file, and only through applyCatalogueChange.
import { config } from "./config.ts";
import { cached } from "./cache.js";
import { ChangeSet } from "./github.js";
import { UNITS, sectionErrors } from "../../shared/ingredient-line.ts";
import { ingredientProblems } from "../../shared/recipe.ts";
import { SECTIONS, SHOP_UNITS, ITEM_ID } from "../../shared/catalogue.ts";

export const CATALOGUE_PATH = "data/ingredients.json";
export { SECTIONS, SHOP_UNITS };

export class CatalogueError extends Error {}

const ID_RE = ITEM_ID;
const ENTRY_KEYS = ["name", "section", "unit", "per", "aliases", "staple", "skip"];

// --- reading and writing ------------------------------------------------------------------------------------------------------

export function parseCatalogue(text) {
  if (!text) return {};
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CatalogueError(`${CATALOGUE_PATH} must be a JSON object keyed by item id`);
  return data;
}

/** Sorted by id, each entry's keys in a fixed order, so a change is a small diff. */
export function serializeCatalogue(catalogue) {
  const out = {};
  for (const id of Object.keys(catalogue).sort()) {
    const e = catalogue[id];
    out[id] = Object.fromEntries([...ENTRY_KEYS.filter((k) => e[k] !== undefined), ...Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k))].map((k) => [k, e[k]]));
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The catalogue. Without a ChangeSet: a read, cached like the recipe index. With one: fresh from the branch plus what the set has staged. */
export async function loadCatalogue(cs) {
  if (cs) return parseCatalogue((await cs.read(CATALOGUE_PATH))?.toString("utf8"));
  return cached(`catalogue:${config.repo}@${config.branch}`, async () => parseCatalogue((await new ChangeSet().read(CATALOGUE_PATH))?.toString("utf8")));
}

export function writeCatalogue(cs, catalogue) {
  cs.write(CATALOGUE_PATH, Buffer.from(serializeCatalogue(catalogue)));
}

// --- names --------------------------------------------------------------------------------------------------------------------

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** The forms a name is matched under: as written, and a naive singular / plural ("limes" ~ "lime", "tomatoes" ~ "tomato"). */
function forms(name) {
  const n = norm(name);
  const out = new Set([n]);
  if (n.endsWith("ies")) out.add(`${n.slice(0, -3)}y`);
  if (n.endsWith("es")) out.add(n.slice(0, -2)); // tomatoes, peaches, chillies -> chilli
  if (n.endsWith("s") && !n.endsWith("ss")) out.add(n.slice(0, -1));
  if (!n.endsWith("s")) out.add(`${n}s`);
  return [...out];
}

/** The names that belong to an item: its own name and its aliases, lower-cased. */
export const namesOf = (entry) => [entry.name, ...(entry.aliases || [])].map(norm).filter(Boolean);

/** Map(name form -> id) over the whole catalogue. Exact names win over a singular/plural form of another item's name. */
export function nameIndex(catalogue) {
  const exact = new Map();
  const loose = new Map();
  for (const [id, e] of Object.entries(catalogue)) {
    for (const n of namesOf(e)) {
      if (!exact.has(n)) exact.set(n, id);
      for (const f of forms(n)) if (!loose.has(f)) loose.set(f, id);
    }
  }
  return { exact, loose };
}

// Words that say how big or ripe one is, not what it is: "large leek" is bought as leeks.
const SIZE_WORDS = /^(?:(?:small|medium|large|big|extra[- ]large|ripe|fresh)\s+)+/;

/** The item a recipe's ingredient name resolves to, or null. A name with a size word in front ("large leek") falls back to the name without it. */
export function resolveItem(name, catalogue, index = nameIndex(catalogue)) {
  const look = (n) => {
    if (index.exact.has(n)) return index.exact.get(n);
    for (const f of forms(n)) if (index.exact.has(f)) return index.exact.get(f);
    for (const f of forms(n)) if (index.loose.has(f)) return index.loose.get(f);
    return null;
  };
  const n = norm(name);
  return look(n) ?? (SIZE_WORDS.test(n) ? look(n.replace(SIZE_WORDS, "")) : null);
}

/** Up to `n` ids whose names share words with `name`, best first (for "Closest: …" in a problem). */
export function closestItems(name, catalogue, n = 3) {
  const words = new Set(norm(name).split(/[^a-z0-9]+/).filter((w) => w.length > 2).flatMap(forms));
  const scored = [];
  for (const [id, e] of Object.entries(catalogue)) {
    const theirs = new Set([id.replace(/-/g, " "), ...namesOf(e)].join(" ").split(/[^a-z0-9]+/).filter((w) => w.length > 2).flatMap(forms));
    const score = [...words].filter((w) => theirs.has(w)).length;
    if (score) scored.push([score, id]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).slice(0, n).map(([, id]) => id);
}

// --- conversions --------------------------------------------------------------------------------------------------------------

const FIXED = {
  g: { g: 1, kg: 1000 },
  ml: { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240 },
};

/**
 * How much of the item's shopping unit one recipe unit is (`unit` undefined = a plain count), or null when there's no rule and no `per`.
 * Fixed rules: g <-> kg, ml <-> l, tsp / tbsp / cup -> 5 / 15 / 240 ml; a count is a count; a named unit is itself. Otherwise the item's `per`.
 */
export function factorFor(entry, unit) {
  const u = unit || "count";
  const per = entry.per || {};
  if (per[u] !== undefined) return per[u];
  const shop = entry.unit;
  if (FIXED[shop]?.[u] !== undefined) return FIXED[shop][u];
  if (shop === u) return 1;
  return null;
}

/** The ingredient's amount (the top of a range: buy enough) in the item's shopping unit, or null when it has no amount. Throws if it can't convert. */
export function shopAmount(ing, entry) {
  if (ing.amount === undefined || ing.amount === null) return null;
  const amount = Array.isArray(ing.amount) ? ing.amount[1] : ing.amount;
  const f = factorFor(entry, ing.unit);
  if (f === null) throw new CatalogueError(conversionProblem(ing, entry));
  return amount * f;
}

const conversionProblem = (ing, entry) =>
  `${entry.name} (${ing.item}) is bought in ${entry.unit === "count" ? "a count" : entry.unit} and has no conversion from ${ing.unit || "a count"}. ` +
  `Add \`per: { ${ing.unit || "count"}: … }\` for ${ing.item} (how many ${entry.unit === "count" ? "of it" : entry.unit} one ${ing.unit || "of them"} is), or use another unit.`;

/** Does an ingredient with this unit need a conversion for this item at all? Staples and skipped items never do, nor amount-less ones. */
export const needsConversion = (ing, entry) => !entry.staple && !entry.skip && ing.amount !== undefined && ing.amount !== null;

// --- the write-time checks (section 4) ----------------------------------------------------------------------------------------

const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Schema problems with one ingredient (no catalogue needed): the rules and messages of shared/recipe.ts, the ones the site's build checks too. */
export const ingredientSchemaErrors = ingredientProblems;

/** Problems with one ingredient against the catalogue (it resolves, and converts). `ing.item` must be filled. */
function catalogueErrors(ing, catalogue, where) {
  const entry = catalogue[ing.item];
  if (!entry) return [`${where}: item "${ing.item}" isn't in the catalogue`];
  if (needsConversion(ing, entry) && factorFor(entry, ing.unit) === null) return [`${where}: ${conversionProblem(ing, entry)}`];
  return [];
}

/** Fixed key order and no empty fields, so the frontmatter is tidy. */
export function tidyIngredient(ing) {
  const out = {};
  if (ing.amount !== undefined && ing.amount !== null) out.amount = ing.amount;
  if (ing.unit) out.unit = ing.unit;
  out.name = String(ing.name).trim();
  if (String(ing.note || "").trim()) out.note = String(ing.note).trim();
  if (ing.optional === true) out.optional = true;
  if (String(ing.section || "").trim()) out.section = String(ing.section).trim();
  if (ing.item) out.item = ing.item;
  return out;
}

/**
 * Section 4: checks a recipe's ingredients and fills each `item` from its name (a given item is kept). Resolves { ingredients, errors }:
 * the tidied list, and every problem with what would fix it.
 */
export function checkIngredients(ingredients, catalogue) {
  const index = nameIndex(catalogue);
  const errors = [];
  const out = (ingredients || []).map((raw, i) => {
    const schema = ingredientSchemaErrors(raw, i);
    if (schema.length) {
      errors.push(...schema);
      return raw;
    }
    const ing = tidyIngredient(raw);
    const where = `ingredients[${i}] (${ing.name})`;
    if (!ing.item) {
      const id = resolveItem(ing.name, catalogue, index);
      if (!id) {
        const near = closestItems(ing.name, catalogue);
        errors.push(`${where}: no catalogue item for "${ing.name}".${near.length ? ` Closest: ${near.join(", ")}.` : ""} Set \`item\` to one of them, or add it to the catalogue (catalogue: [{ add: { id, name, section, unit, per? } }]).`);
        return ing;
      }
      ing.item = id;
      // keep `item` last
      const { item, ...rest } = ing;
      return checked({ ...rest, item });
    }
    return checked(ing);
    function checked(x) {
      errors.push(...catalogueErrors(x, catalogue, where));
      return x;
    }
  });
  errors.push(...sectionErrors(out));
  return { ingredients: out, errors };
}

// --- changing the catalogue (section 5) ----------------------------------------------------------------------------------------

const MAX_PER = { tsp: 20, tbsp: 50, cup: 500, pinch: 5, handful: 200 };
function perErrors(id, per) {
  if (per === undefined) return [];
  if (!per || typeof per !== "object" || Array.isArray(per)) return [`${id}: per is an object, e.g. { "tbsp": 10 }`];
  const errors = [];
  for (const [u, v] of Object.entries(per)) {
    if (u !== "count" && !UNITS.includes(u)) errors.push(`${id}: per "${u}" isn't a recipe unit (${UNITS.join(", ")}, or count)`);
    else if (!positive(v)) errors.push(`${id}: per ${u} must be a positive number`);
    else if (v > (MAX_PER[u] ?? 5000)) errors.push(`${id}: per ${u} = ${v} is far outside a sane range (at most ${MAX_PER[u] ?? 5000})`);
  }
  return errors;
}

function entryErrors(id, e) {
  const errors = [];
  if (!String(e.name || "").trim()) errors.push(`${id}: name is required (the shopping-list name, e.g. "Red onions")`);
  if (!e.skip && !SECTIONS.includes(e.section)) errors.push(`${id}: section must be one of ${SECTIONS.join(", ")}`);
  if (!e.staple && !e.skip && !SHOP_UNITS.includes(e.unit)) errors.push(`${id}: unit must be one of ${SHOP_UNITS.join(", ")}`);
  if (e.unit !== undefined && !SHOP_UNITS.includes(e.unit)) errors.push(`${id}: unit must be one of ${SHOP_UNITS.join(", ")}`);
  if (e.aliases !== undefined && !(Array.isArray(e.aliases) && e.aliases.every((a) => String(a).trim()))) errors.push(`${id}: aliases is a list of names`);
  for (const k of ["staple", "skip"]) if (e[k] !== undefined && e[k] !== true) errors.push(`${id}: ${k} is true or left out`);
  return [...errors, ...perErrors(id, e.per)];
}

/** Names (and aliases) that another item already has: [{ name, owner }]. */
function nameClashes(catalogue, id, names) {
  const owners = new Map();
  for (const [other, e] of Object.entries(catalogue)) if (other !== id) for (const n of namesOf(e)) owners.set(n, other);
  return names.map(norm).filter((n) => owners.has(n)).map((n) => ({ name: n, owner: owners.get(n) }));
}

const clashText = (c) => `"${c.name}" already belongs to ${c.owner}: use that item (set \`item: ${c.owner}\`), or pick another name`;

/** How many recipes use each item: Map(id -> [slug]). `recipes`: [{ slug, ingredients }]. */
export function usage(recipes) {
  const used = new Map();
  for (const r of recipes) for (const ing of r.ingredients || []) if (ing.item) used.set(ing.item, [...new Set([...(used.get(ing.item) || []), r.slug])]);
  return used;
}

/**
 * Applies one catalogue change to a copy of the catalogue and checks the result. `change` is one of:
 *   { add: { id, name, section, unit, per?, aliases?, staple?, skip? } }   a new item
 *   { alias: { item, name } }                                             another name for an item
 *   { set: { item, name?, section?, unit?, per?, staple?, skip? } }        edit an item (per merges; unit replaces and needs per that keep recipes converting)
 *   { merge: { into, from } }                                             `from` becomes aliases of `into`; recipes using `from` are re-pointed
 *   { remove: { item } }                                                  only when no recipe uses it
 * `recipes` ([{ slug, ingredients }]) is the book after the write this change rides on. Resolves { catalogue, line, repoint? ({ from, into }) },
 * or throws a CatalogueError saying what to fix. Pure.
 */
export function applyCatalogueChange(catalogue, change, recipes = []) {
  const next = structuredClone(catalogue);
  const kinds = ["add", "alias", "set", "merge", "remove"].filter((k) => change?.[k] !== undefined);
  if (kinds.length !== 1) throw new CatalogueError("A catalogue change is exactly one of add, alias, set, merge, remove");
  const kind = kinds[0];
  const c = change[kind];
  const used = usage(recipes);
  const usedBy = (id) => {
    const n = (used.get(id) || []).length;
    return n ? ` (used by ${n} recipe${n === 1 ? "" : "s"})` : "";
  };
  let line;
  let repoint = null;
  const need = (id) => {
    if (!next[id]) throw new CatalogueError(`No catalogue item "${id}"`);
    return next[id];
  };
  switch (kind) {
    case "add": {
      const { id, ...entry } = c;
      if (!ID_RE.test(String(id || ""))) throw new CatalogueError(`"${id}" isn't a valid id: kebab-case, e.g. "red-onion"`);
      if (next[id]) throw new CatalogueError(`"${id}" is already in the catalogue (${next[id].name}): use it, or set its fields with { set: { item: "${id}", … } }`);
      const errors = entryErrors(id, entry);
      const clashes = nameClashes(next, id, [entry.name, ...(entry.aliases || [])].filter(Boolean));
      if (errors.length || clashes.length) throw new CatalogueError([...errors, ...clashes.map(clashText)].join("; "));
      next[id] = { ...entry, name: String(entry.name).trim(), ...(entry.aliases ? { aliases: [...new Set(entry.aliases.map(norm))] } : {}) };
      line = `New in the catalogue: ${next[id].name}${next[id].skip ? " (never bought)" : ` · ${next[id].section}`}`;
      break;
    }
    case "alias": {
      const e = need(c.item);
      const n = norm(c.name);
      if (!n) throw new CatalogueError("alias: name is required");
      if (namesOf(e).includes(n)) return { catalogue, line: `"${n}" is already a name of ${e.name}` };
      const clashes = nameClashes(next, c.item, [n]);
      if (clashes.length) throw new CatalogueError(clashes.map(clashText).join("; "));
      e.aliases = [...(e.aliases || []), n];
      line = `"${n}" is now another name for ${e.name}`;
      break;
    }
    case "set": {
      const e = need(c.item);
      const { item, ...fields } = c;
      if (!Object.keys(fields).length) throw new CatalogueError(`set: nothing to change for ${item}`);
      const merged = { ...e, ...fields, ...(fields.per ? { per: { ...(fields.unit && fields.unit !== e.unit ? {} : e.per || {}), ...fields.per } } : {}) };
      if (fields.unit && fields.unit !== e.unit && !fields.per) delete merged.per; // a new unit means new conversions
      const errors = entryErrors(item, merged);
      const clashes = fields.name ? nameClashes(next, item, [fields.name]) : [];
      if (errors.length || clashes.length) throw new CatalogueError([...errors, ...clashes.map(clashText)].join("; "));
      next[item] = merged;
      line = `Catalogue: ${merged.name} ${Object.keys(fields).map((k) => (k === "per" ? `conversions ${JSON.stringify(fields.per)}` : `${k} ${JSON.stringify(fields[k])}`)).join(", ")}${usedBy(item)}`;
      break;
    }
    case "merge": {
      const into = need(c.into);
      const from = need(c.from);
      if (c.into === c.from) throw new CatalogueError("merge: into and from are the same item");
      into.aliases = [...new Set([...(into.aliases || []), ...namesOf(from)].filter((n) => !namesOf({ name: into.name }).includes(n)))];
      delete next[c.from];
      repoint = { from: c.from, into: c.into };
      line = `Catalogue: ${from.name} merged into ${into.name}${usedBy(c.from)}`;
      break;
    }
    case "remove": {
      need(c.item);
      if ((used.get(c.item) || []).length) throw new CatalogueError(`${c.item} is used by ${used.get(c.item).join(", ")}: it can't be removed`);
      delete next[c.item];
      line = `Catalogue: removed ${c.item}`;
      break;
    }
  }
  // Nothing in the book may stop converting or point at a missing item.
  const after = repoint ? recipes.map((r) => ({ ...r, ingredients: (r.ingredients || []).map((i) => (i.item === repoint.from ? { ...i, item: repoint.into } : i)) })) : recipes;
  const broken = [];
  for (const r of after) {
    for (const ing of r.ingredients || []) {
      if (!ing.item) continue;
      const entry = next[ing.item];
      if (!entry) broken.push(`${r.slug}: ${ing.name} would point at a missing item ${ing.item}`);
      else if (needsConversion(ing, entry) && factorFor(entry, ing.unit) === null) broken.push(`${r.slug}: ${ing.name} (${ing.unit || "count"}) would no longer convert to ${entry.unit}; add per: { ${ing.unit || "count"}: … }`);
    }
  }
  if (broken.length) throw new CatalogueError(`That catalogue change breaks ${broken.length} ingredient${broken.length === 1 ? "" : "s"}: ${broken.slice(0, 5).join("; ")}${broken.length > 5 ? "; …" : ""}`);
  return { catalogue: next, line, ...(repoint ? { repoint } : {}) };
}

/** Applies several changes in order (each checked against the result of the ones before). Resolves { catalogue, lines, repoints }. */
export function applyCatalogueChanges(catalogue, changes, recipes = []) {
  let cat = catalogue;
  let book = recipes;
  const lines = [];
  const repoints = [];
  for (const [k, change] of (changes || []).entries()) {
    let out;
    try {
      out = applyCatalogueChange(cat, change, book);
    } catch (err) {
      if (err instanceof CatalogueError) throw new CatalogueError(`catalogue[${k}]: ${err.message}`);
      throw err;
    }
    cat = out.catalogue;
    lines.push(out.line);
    if (out.repoint) {
      repoints.push(out.repoint);
      book = book.map((r) => ({ ...r, ingredients: (r.ingredients || []).map((i) => (i.item === out.repoint.from ? { ...i, item: out.repoint.into } : i)) }));
    }
  }
  return { catalogue: cat, lines, repoints };
}
