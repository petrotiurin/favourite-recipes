import { formatQuantity } from "./scaling.js";

// The ingredient line renderer: a COPY of templates/ingredients.js (the server is deployed on its own and can't import the site's
// templates). KEEP THE TWO IN STEP; test/ingredients.test.js checks that both render the same lines. The server adds scaling (scale_recipe)
// at the end, with the recipe page's rounding (formatQuantity in lib/scaling.js, kept in step with templates/servings.js).
//
// One ingredient: { amount?: number | [min, max], unit?: one of UNITS, name, note?, optional?: true, item }.

export const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "clove", "can", "slice", "bunch", "sprig", "piece", "pinch", "handful", "juice", "zest"];
// Written right after the number: "200g", "1.5l".
const METRIC = new Set(["g", "kg", "ml", "l"]);
// "1 clove" / "2 cloves". tsp and tbsp stay as they are.
const PLURAL = { cup: "cups", clove: "cloves", can: "cans", slice: "slices", bunch: "bunches", sprig: "sprigs", piece: "pieces", pinch: "pinches", handful: "handfuls" };
// Read as "Pinch of", "Handful of" for one, "2 pinches of" for more.
const OF_UNITS = new Set(["pinch", "handful"]);
// "Juice of 1", "Zest of ½".
const FROM_UNITS = { juice: "Juice of", zest: "Zest of" };

const FRACTIONS = [[0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];

/** An amount as written: whole numbers as they are, common fractions as ¼ ⅓ ½ ⅔ ¾ ⅛ (0.33 and 0.67 count as thirds), else up to 2 decimals. Metric amounts keep decimals ("37.5g"). */
export function displayAmount(n, { metric = false } = {}) {
  if (Number.isInteger(n) || metric) return String(Math.round(n * 100) / 100);
  const whole = Math.floor(n);
  const frac = n - whole;
  for (const [v, glyph] of FRACTIONS) if (Math.abs(frac - v) < 0.011) return (whole ? String(whole) : "") + glyph;
  return String(Math.round(n * 100) / 100);
}

const top = (amount) => (Array.isArray(amount) ? amount[1] : amount);

/**
 * The line in parts: `lead` (before the name: words and numbers, each { text } or { qty, text }), `unit` ({ one, many, text } for a word that
 * follows the number of the amount, so the page can say "2 cloves" after scaling "1 clove"), the name, and the tail (", note", ", optional").
 */
function lineParts(ing) {
  const lead = [];
  const nums = ing.amount === undefined || ing.amount === null ? [] : Array.isArray(ing.amount) ? ing.amount : [ing.amount];
  const unit = ing.unit;
  const qty = (n) => ({ qty: n, text: displayAmount(n, { metric: METRIC.has(unit) }) });
  const numbers = () => (nums.length === 2 ? [qty(nums[0]), { text: "–" }, qty(nums[1])] : nums.map(qty));
  let unitWord = null;
  if (unit && FROM_UNITS[unit]) {
    lead.push({ text: `${FROM_UNITS[unit]} ` }, ...numbers(), { text: " " });
  } else if (unit && OF_UNITS.has(unit) && (!nums.length || (nums.length === 1 && nums[0] === 1))) {
    lead.push({ text: `${unit[0].toUpperCase()}${unit.slice(1)} of ` });
  } else if (nums.length) {
    lead.push(...numbers());
    if (unit && METRIC.has(unit)) lead.push({ text: `${unit} ` });
    else if (unit) {
      const many = PLURAL[unit] || unit;
      unitWord = { one: unit, many, text: top(ing.amount) > 1 ? many : unit };
      lead.push({ text: " " });
    } else lead.push({ text: " " });
  }
  const note = String(ing.note || "").trim();
  let tail = "";
  if (note.startsWith("(")) tail += ` ${note}`;
  else if (note) tail += `, ${note}`;
  if (ing.optional === true) tail += ", optional";
  return { lead, unitWord, name: String(ing.name || "").trim(), tail, ofUnit: unitWord && OF_UNITS.has(unitWord.one) };
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function assemble(ing, { num, word, name, text }) {
  const p = lineParts(ing);
  let out = "";
  const lead = p.lead.slice();
  // The unit word sits between the numbers and the trailing space: "2 cloves ".
  if (p.unitWord) lead.splice(lead.length - 1, 0, { unit: true });
  for (const part of lead) {
    if (part.unit) out += " " + word(p.unitWord) + (p.ofUnit ? " of" : "");
    else if (part.qty !== undefined) out += num(part);
    else out += text(part.text);
  }
  return out + name(p.name) + text(p.tail);
}

/** "200g **jasmine rice**", the Markdown line (without the "- "). */
export function ingredientMarkdown(ing) {
  return assemble(ing, { num: (p) => p.text, word: (u) => u.text, name: (n) => `**${n}**`, text: (t) => t });
}

/** The line as plain text, for the "Cook with Claude" prompt. */
export function ingredientText(ing) {
  return assemble(ing, { num: (p) => p.text, word: (u) => u.text, name: (n) => n, text: (t) => t });
}

/** The line as HTML for the recipe page: the name bold, each number a `.qty` the servings selector rescales (when `scalable`). */
export function ingredientHtml(ing, { scalable = true } = {}) {
  return assemble(ing, {
    num: (p) => (scalable ? `<span class="qty" data-qty="${p.qty}">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)),
    word: (u) => (scalable ? `<span class="qty-unit" data-one="${escapeHtml(u.one)}" data-many="${escapeHtml(u.many)}">${escapeHtml(u.text)}</span>` : escapeHtml(u.text)),
    name: (n) => `<strong>${escapeHtml(n)}</strong>`,
    text: (t) => escapeHtml(t),
  });
}

/** Does the list have any amount the servings selector could rescale? */
export const hasAmounts = (ingredients) => (ingredients || []).some((i) => i.amount !== undefined && i.amount !== null && !(OF_UNITS.has(i.unit) && i.amount === 1));

/** The Markdown line scaled by `factor`, as the recipe page shows it after picking servings (1 leaves it as written). */
export function scaledMarkdown(ing, factor) {
  if (factor === 1) return ingredientMarkdown(ing);
  return assemble(ing, {
    num: (p) => formatQuantity(p.qty * factor),
    word: (u) => (top(ing.amount) * factor > 1 ? u.many : u.one),
    name: (n) => `**${n}**`,
    text: (t) => t,
  });
}
