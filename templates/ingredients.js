// A recipe's ingredients are data in its frontmatter (`ingredients:`, docs/structured-ingredients.md section 1): this renders each one as
// the line the page shows. DUPLICATED in mcp-server/lib/ingredient-line.js (the server is deployed on its own and can't import the site's
// templates): KEEP THE TWO IN STEP. mcp-server/test/ingredients.test.js checks that both render the same lines.
//
// One ingredient: { amount?: number | [min, max], unit?: one of UNITS, name, note?, optional?: true, section?, item }.

const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "clove", "can", "slice", "bunch", "sprig", "piece", "sheet", "stick", "head", "pinch", "handful", "juice", "zest"];
// Written right after the number: "200g", "1.5l".
const METRIC = new Set(["g", "kg", "ml", "l"]);
// "1 clove" / "2 cloves". tsp and tbsp stay as they are.
const PLURAL = { cup: "cups", clove: "cloves", can: "cans", slice: "slices", bunch: "bunches", sprig: "sprigs", piece: "pieces", sheet: "sheets", stick: "sticks", head: "heads", pinch: "pinches", handful: "handfuls" };
// Read as "Pinch of", "Handful of" for one, "2 pinches of" for more.
const OF_UNITS = new Set(["pinch", "handful"]);
// "Juice of 1", "Zest of ½".
const FROM_UNITS = { juice: "Juice of", zest: "Zest of" };

const FRACTIONS = [[0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];

/** An amount as written: whole numbers as they are, common fractions as ¼ ⅓ ½ ⅔ ¾ ⅛ (0.33 and 0.67 count as thirds), else up to 2 decimals. Metric amounts keep decimals ("37.5g"). */
function displayAmount(n, { metric = false } = {}) {
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
function ingredientMarkdown(ing) {
  return assemble(ing, { num: (p) => p.text, word: (u) => u.text, name: (n) => `**${n}**`, text: (t) => t });
}

/** The line as plain text, for the "Cook with Claude" prompt. */
function ingredientText(ing) {
  return assemble(ing, { num: (p) => p.text, word: (u) => u.text, name: (n) => n, text: (t) => t });
}

/** The line as HTML for the recipe page: the name bold, each number a `.qty` the servings selector rescales (when `scalable`). */
function ingredientHtml(ing, { scalable = true } = {}) {
  return assemble(ing, {
    num: (p) => (scalable ? `<span class="qty" data-qty="${p.qty}">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)),
    word: (u) => (scalable ? `<span class="qty-unit" data-one="${escapeHtml(u.one)}" data-many="${escapeHtml(u.many)}">${escapeHtml(u.text)}</span>` : escapeHtml(u.text)),
    name: (n) => `<strong>${escapeHtml(n)}</strong>`,
    text: (t) => escapeHtml(t),
  });
}

/**
 * The list in its sections (`section` on each line, docs/structured-ingredients.md 1): [{ section, items }] in order. Lines without a section
 * come first under no heading; each section's lines sit together (sectionErrors refuses a list where they don't).
 */
function ingredientGroups(ingredients) {
  const groups = [];
  for (const ing of ingredients || []) {
    const section = String(ing.section || "").trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.items.push(ing);
    else groups.push({ section, items: [ing] });
  }
  return groups;
}

/** Problems with a list's sections: a name that is blank or too long, lines without a section after a section, a section split in two. */
function sectionErrors(ingredients) {
  const errors = [];
  const seen = new Set();
  let prev;
  (ingredients || []).forEach((ing, i) => {
    if (!ing || typeof ing !== "object" || ing.section === undefined) {
      if (prev) errors.push(`ingredients[${i}]${ing?.name ? ` (${ing.name})` : ""}: lines without a section go first, before "${prev}"; give it a section or move it up`);
      return;
    }
    const where = `ingredients[${i}]${ing.name ? ` (${ing.name})` : ""}`;
    const name = typeof ing.section === "string" ? ing.section.trim() : "";
    if (!name) return void errors.push(`${where}: section is a short name ("Sauce") or left out`);
    if (name.length > 40 || /[*\n]/.test(name)) errors.push(`${where}: section "${name}" must be a short plain name ("Sauce", "For the dressing")`);
    if (name !== prev && seen.has(name.toLowerCase())) errors.push(`${where}: the "${name}" lines must sit together; move it next to the others`);
    seen.add(name.toLowerCase());
    prev = name;
  });
  return errors;
}

/** Does the list have any amount the servings selector could rescale? */
const hasAmounts = (ingredients) => (ingredients || []).some((i) => i.amount !== undefined && i.amount !== null && !(OF_UNITS.has(i.unit) && i.amount === 1));

export { UNITS, ingredientMarkdown, ingredientText, ingredientHtml, hasAmounts, displayAmount, ingredientGroups, sectionErrors };
