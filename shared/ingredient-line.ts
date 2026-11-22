// The ingredient line: one ingredient of a recipe's frontmatter (`ingredients:`, docs/structured-ingredients.md section 1) rendered as the
// line the page shows, as Markdown, as plain text, or scaled. The site's renderers and the backend both import this file.
//
// One ingredient: { amount?: number | [min, max], unit?: one of UNITS, name, note?, optional?: true, section?, item }.
import { formatQuantity } from "./quantity.ts";

export type Amount = number | [number, number];
export interface Ingredient {
  amount?: Amount | null;
  unit?: string;
  name: string;
  note?: string;
  optional?: boolean;
  section?: string;
  item?: string;
}
/** What the renderers accept: ingredients come from frontmatter or from a model, so the checks below must cope with anything. */
type Loose = Partial<Ingredient> | null | undefined;

export const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "clove", "can", "slice", "bunch", "sprig", "piece", "sheet", "stick", "head", "pinch", "handful", "juice", "zest"] as const;
// Written right after the number: "200g", "1.5l".
const METRIC = new Set(["g", "kg", "ml", "l"]);
// "1 clove" / "2 cloves". tsp and tbsp stay as they are.
const PLURAL: Record<string, string> = { cup: "cups", clove: "cloves", can: "cans", slice: "slices", bunch: "bunches", sprig: "sprigs", piece: "pieces", sheet: "sheets", stick: "sticks", head: "heads", pinch: "pinches", handful: "handfuls" };
// Read as "Pinch of", "Handful of" for one, "2 pinches of" for more.
const OF_UNITS = new Set(["pinch", "handful"]);
// "Juice of 1", "Zest of ½".
const FROM_UNITS: Record<string, string> = { juice: "Juice of", zest: "Zest of" };

const FRACTIONS: readonly (readonly [number, string])[] = [[0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];

/** An amount as written: whole numbers as they are, common fractions as ¼ ⅓ ½ ⅔ ¾ ⅛ (0.33 and 0.67 count as thirds), else up to 2 decimals. Metric amounts keep decimals ("37.5g"). */
export function displayAmount(n: number, { metric = false }: { metric?: boolean } = {}): string {
  if (Number.isInteger(n) || metric) return String(Math.round(n * 100) / 100);
  const whole = Math.floor(n);
  const frac = n - whole;
  for (const [v, glyph] of FRACTIONS) if (Math.abs(frac - v) < 0.011) return (whole ? String(whole) : "") + glyph;
  return String(Math.round(n * 100) / 100);
}

const top = (amount: Amount | null | undefined): number => (Array.isArray(amount) ? amount[1] : (amount as number));

/**
 * The line in parts: `lead` (before the name: words and numbers, each { text } or { qty, text }), `unit` ({ one, many, text } for a word that
 * follows the number of the amount, so the page can say "2 cloves" after scaling "1 clove"), the name, and the tail (", note", ", optional").
 */
type Part = { text: string; qty?: undefined; unit?: undefined } | { text: string; qty: number; unit?: undefined } | { unit: true; text?: undefined; qty?: undefined };
interface UnitWord { one: string; many: string; text: string }

function lineParts(ing: Partial<Ingredient>) {
  const lead: Part[] = [];
  const nums = ing.amount === undefined || ing.amount === null ? [] : Array.isArray(ing.amount) ? ing.amount : [ing.amount];
  const unit = ing.unit;
  const qty = (n: number): Part => ({ qty: n, text: displayAmount(n, { metric: METRIC.has(unit ?? "") }) });
  const numbers = () => (nums.length === 2 ? [qty(nums[0]), { text: "–" }, qty(nums[1])] : nums.map(qty));
  let unitWord: UnitWord | null = null;
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

function escapeHtml(str: unknown): string {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Writer {
  num: (p: { qty: number; text: string }) => string;
  word: (u: UnitWord) => string;
  name: (n: string) => string;
  text: (t: string) => string;
}

function assemble(ing: Partial<Ingredient>, { num, word, name, text }: Writer): string {
  const p = lineParts(ing);
  let out = "";
  const lead: Part[] = p.lead.slice();
  // The unit word sits between the numbers and the trailing space: "2 cloves ".
  if (p.unitWord) lead.splice(lead.length - 1, 0, { unit: true });
  for (const part of lead) {
    if (part.unit) out += " " + word(p.unitWord!) + (p.ofUnit ? " of" : "");
    else if (part.qty !== undefined) out += num({ qty: part.qty, text: part.text });
    else out += text(part.text);
  }
  return out + name(p.name) + text(p.tail);
}

/** "200g **jasmine rice**", the Markdown line (without the "- "). */
export function ingredientMarkdown(ing: Partial<Ingredient>): string {
  return assemble(ing, { num: (p) => p.text, word: (u) => u.text, name: (n) => `**${n}**`, text: (t) => t });
}

/** The line as plain text, for the "Cook with Claude" prompt. */
export function ingredientText(ing: Partial<Ingredient>): string {
  return assemble(ing, { num: (p) => p.text, word: (u) => u.text, name: (n) => n, text: (t) => t });
}

/** The line as HTML for the recipe page: the name bold, each number a `.qty` the servings selector rescales (when `scalable`). */
export function ingredientHtml(ing: Partial<Ingredient>, { scalable = true }: { scalable?: boolean } = {}): string {
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
export function ingredientGroups<T extends Loose>(ingredients: readonly T[] | null | undefined): { section: string | null; items: T[] }[] {
  const groups: { section: string | null; items: T[] }[] = [];
  for (const ing of ingredients || []) {
    const section = String(ing?.section || "").trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.items.push(ing);
    else groups.push({ section, items: [ing] });
  }
  return groups;
}

/** A problem with a list's sections: which line, and what is wrong (without the line's own name). */
export interface SectionIssue {
  index: number;
  message: string;
}

/** Problems with a list's sections: a name that is blank or too long, lines without a section after a section, a section split in two. */
export function sectionIssues(ingredients: readonly Loose[] | null | undefined): SectionIssue[] {
  const issues: SectionIssue[] = [];
  const seen = new Set<string>();
  let prev: string | undefined;
  (ingredients || []).forEach((ing, index) => {
    if (!ing || typeof ing !== "object" || ing.section === undefined) {
      if (prev) issues.push({ index, message: `lines without a section go first, before "${prev}"; give it a section or move it up` });
      return;
    }
    const name = typeof ing.section === "string" ? ing.section.trim() : "";
    if (!name) return void issues.push({ index, message: `section is a short name ("Sauce") or left out` });
    if (name.length > 40 || /[*\n]/.test(name)) issues.push({ index, message: `section "${name}" must be a short plain name ("Sauce", "For the dressing")` });
    if (name !== prev && seen.has(name.toLowerCase())) issues.push({ index, message: `the "${name}" lines must sit together; move it next to the others` });
    seen.add(name.toLowerCase());
    prev = name;
  });
  return issues;
}

/** `ingredients[3] (soy sauce)`: how a problem names its line. */
export const ingredientWhere = (ing: Loose, i: number): string => `ingredients[${i}]${ing?.name ? ` (${ing.name})` : ""}`;

/** sectionIssues as one sentence each, "ingredients[3] (soy sauce): …". */
export function sectionErrors(ingredients: readonly Loose[] | null | undefined): string[] {
  return sectionIssues(ingredients).map(({ index, message }) => `${ingredientWhere(ingredients![index], index)}: ${message}`);
}

/** Does the list have any amount the servings selector could rescale? */
export const hasAmounts = (ingredients: readonly Loose[] | null | undefined): boolean => (ingredients || []).some((i) => i != null && i.amount !== undefined && i.amount !== null && !(OF_UNITS.has(i.unit ?? "") && i.amount === 1));

/** The Markdown line scaled by `factor`, as the recipe page shows it after picking servings (1 leaves it as written). */
export function scaledMarkdown(ing: Partial<Ingredient>, factor: number): string {
  if (factor === 1) return ingredientMarkdown(ing);
  return assemble(ing, {
    num: (p) => formatQuantity(p.qty * factor),
    word: (u) => (top(ing.amount) * factor > 1 ? u.many : u.one),
    name: (n) => `**${n}**`,
    text: (t) => t,
  });
}
