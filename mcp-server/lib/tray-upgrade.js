// A one-off upgrade for trays staged before structured ingredients (docs/structured-ingredients.md). It runs whenever the tray is read
// (loadTray in lib/tray.js) and rewrites any card still in the old shape, once; a card already in the new shape is left exactly as it is.
//
//   - The old list card ({ action: "update_shopping_list", sections } written by the model) becomes the new one the server builds
//     ({ build: true, edits: [] }, not reviewed yet): the old list was only ever a copy of the recipes, so nothing is lost.
//   - A staged recipe's (or edit's) ingredients written the old way, { quantity: "450g", name, note }, become { amount, unit, name, note,
//     optional }, parsed the way the book's own migration did it. What the parse can't place goes into the note, never dropped. If an amount
//     still can't be bought as its catalogue item ("1 honey, to taste"), and the note says "to taste" / "to serve", the amount is dropped
//     rather than leaving a problem on the card.
// The site's ingredient catalogue then fills `item` as for any staged recipe; anything it doesn't know shows on the card as usual.
import { UNITS } from "./ingredient-line.js";
import { checkIngredients, nameIndex, resolveItem, factorFor } from "./catalogue.js";

const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 0.33, "⅔": 0.67, "⅛": 0.125 };
const NUM = "(?:\\d+(?:\\.\\d+)?\\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\\d+(?:\\.\\d+)?|\\d+/\\d+)";
const UNIT_WORDS = {
  g: "g", gram: "g", grams: "g", kg: "kg", ml: "ml", l: "l", litre: "l", litres: "l", tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", cup: "cup", cups: "cup", clove: "clove", cloves: "clove", can: "can", cans: "can",
  tin: "can", tins: "can", slice: "slice", slices: "slice", bunch: "bunch", bunches: "bunch", sprig: "sprig", sprigs: "sprig", piece: "piece",
  pieces: "piece", pinch: "pinch", pinches: "pinch", handful: "handful", handfuls: "handful",
};
const MODIFIERS = /^(heaped|generous|large|small|medium|good|thick|big|scant|level|rounded)\b\s*/i;
const TO_TASTE = /\bto (taste|serve)\b/i;

function number(s) {
  s = String(s).trim();
  let m = s.match(/^(\d+)?\s*([½¼¾⅓⅔⅛])$/);
  if (m) return (m[1] ? Number(m[1]) : 0) + FRACTIONS[m[2]];
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Math.round((Number(m[1]) / Number(m[2])) * 100) / 100;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

const joinNote = (...parts) => parts.map((p) => String(p || "").trim()).filter(Boolean).join(", ");

/** One old-style ingredient ({ quantity, name, note }) in the new fields. Pure; never loses text (what isn't placed goes into the note). */
export function upgradeIngredient(old) {
  const name = String(old?.name ?? "").replace(/\*+/g, "").trim();
  let note = String(old?.note ?? "").trim();
  let q = String(old?.quantity ?? "").trim();
  const out = { name };
  const mods = [];
  let amount = null;
  let unit;
  let m;
  if (!q) {
    // nothing
  } else if ((m = q.match(/^(?:a\s+)?(small|large|good|generous)?\s*(pinch|handful)(?:\s+of)?$/i))) {
    amount = 1;
    unit = m[2].toLowerCase();
    if (m[1]) mods.push(m[1].toLowerCase());
    q = "";
  } else if ((m = q.match(new RegExp(`^(zest|juice) of (${NUM})$`, "i")))) {
    amount = number(m[2]);
    unit = m[1].toLowerCase();
    q = "";
  } else if ((m = q.match(new RegExp(`^(${NUM})\\s*[-–]\\s*(${NUM})\\s*(.*)$`)))) {
    const [a, b] = [number(m[1]), number(m[2])];
    amount = a !== null && b !== null && a < b ? [a, b] : b;
    q = m[3];
  } else if ((m = q.match(new RegExp(`^(${NUM})\\s*(.*)$`)))) {
    amount = number(m[1]);
    q = m[2];
  }
  if (amount !== null && q) {
    while ((m = q.match(MODIFIERS))) {
      mods.push(m[1].toLowerCase());
      q = q.slice(m[0].length);
    }
    if ((m = q.match(/^([a-zA-Z]+)\.?\b\s*(?:of\b\s*)?(.*)$/)) && UNIT_WORDS[m[1].toLowerCase()]) {
      unit = UNIT_WORDS[m[1].toLowerCase()];
      q = m[2];
    }
    q = q.replace(/^\((.*)\)$/, "$1").trim();
  }
  // a unit written in the note ("1", "ground ginger", note "tsp")
  if (amount !== null && !unit && UNIT_WORDS[note.toLowerCase()]) {
    unit = UNIT_WORDS[note.toLowerCase()];
    note = "";
  }
  if (amount === null && q) note = joinNote(q, note); // words with no number ("a few") stay as the source said them
  else if (q) mods.unshift(q);
  if (amount !== null) out.amount = amount;
  if (amount !== null && unit && UNITS.includes(unit)) out.unit = unit;
  if (/\boptional\b/i.test(note)) {
    out.optional = true;
    note = note.replace(/,?\s*\boptional\b,?\s*/i, ", ").replace(/^,\s*|,\s*$/g, "").trim();
  }
  note = joinNote(...mods, note);
  if (out.amount === undefined && !TO_TASTE.test(note)) note = joinNote(note, "to taste");
  if (note) out.note = note;
  return out;
}

// Old-style = has the old `quantity` field. A new-style ingredient that is merely invalid is the card's problem to show, never rewritten.
const isOld = (ing) => !!ing && typeof ing === "object" && "quantity" in ing;

/** Does this tray hold anything in the old shape? */
export function needsUpgrade(items = []) {
  return items.some((i) => (i.kind === "list" && !i.op?.build) || (["new", "edit"].includes(i.kind) && Array.isArray(i.op?.ingredients) && i.op.ingredients.some(isOld)));
}

/** A recipe's upgraded ingredients, with amounts that can't be bought as their item dropped when the note says "to taste" / "to serve". */
function upgradeList(ingredients, catalogue) {
  const index = nameIndex(catalogue);
  return ingredients.map((ing) => {
    if (!isOld(ing)) return ing;
    const up = upgradeIngredient(ing);
    const id = resolveItem(up.name, catalogue, index);
    const entry = id && catalogue[id];
    // "1 salt, to taste", "1 honey, to taste": a number the source didn't mean (a staple, or one that can't be bought that way)
    if (entry && up.amount !== undefined && TO_TASTE.test(up.note || "") && (entry.staple || entry.skip || factorFor(entry, up.unit) === null)) {
      delete up.amount;
      delete up.unit;
    }
    return up;
  });
}

/** The tray's items with every old-shaped card rewritten (see the top of the file); `changed` says whether anything was. Pure. */
export function upgradeItems(items, catalogue) {
  if (!needsUpgrade(items)) return { items, changed: false };
  const upgraded = items.map((item) => {
    if (item.kind === "list" && !item.op?.build) {
      return { ...item, op: { action: "update_shopping_list", build: true, edits: [] }, reviewed: null, error: null };
    }
    if (["new", "edit"].includes(item.kind) && Array.isArray(item.op?.ingredients) && item.op.ingredients.some(isOld)) {
      return { ...item, op: { ...item.op, ingredients: upgradeList(item.op.ingredients, catalogue) }, error: null };
    }
    return item;
  });
  return { items: upgraded, changed: true };
}

/** For the check script and tests: the problems the catalogue would put on each upgraded recipe card. */
export const cardProblems = (items, catalogue) =>
  items.filter((i) => Array.isArray(i.op?.ingredients)).map((i) => ({ title: i.op.title || i.op.slug, errors: checkIngredients(i.op.ingredients, catalogue).errors }));
