import matter from "gray-matter";
import { recipeFrontmatterSchema } from "../../shared/recipe.ts";

// How a recipe file is written. The fields and their order are shared/recipe.ts's schema (the site's build validates with it); the prose
// rules of .claude/skills/add-recipe/SKILL.md are the one thing still kept in step by hand.

export function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Plain YAML scalar when safe, otherwise a JSON (= YAML double-quoted) string.
function yamlScalar(value, { inFlow = false } = {}) {
  const s = String(value);
  const unsafe =
    /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|:$|\s$/.test(s) || (inFlow && /[,[\]{}]/.test(s)) || /^(true|false|null|yes|no|on|off|~|[-+]?[\d.][\d.eE+-]*)$/i.test(s);
  return unsafe || s === "" ? JSON.stringify(s) : s;
}

function yamlFlowList(items) {
  return `[${items.map((i) => yamlFlowValue(i)).join(", ")}]`;
}

function yamlFlowValue(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return yamlFlowList(v);
  return yamlScalar(v, { inFlow: true });
}

/** One flow mapping on one line: "{ amount: 200, unit: g, name: jasmine rice, item: jasmine-rice }". */
const yamlFlowMap = (obj) => `{ ${Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${yamlFlowValue(v)}`).join(", ")} }`;

// `ingredients` goes last: it is the long one (docs/structured-ingredients.md section 1).
const KEY_ORDER = Object.keys(recipeFrontmatterSchema.shape);

export function renderFrontmatter(data) {
  const keys = [...KEY_ORDER.filter((k) => k in data && k !== "ingredients"), ...Object.keys(data).filter((k) => !KEY_ORDER.includes(k)), ...("ingredients" in data ? ["ingredients"] : [])];
  const lines = [];
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (key === "tags" && value.length === 0) continue; // omit the key entirely if no tags
      if (value.some((v) => v && typeof v === "object" && !Array.isArray(v))) {
        lines.push(`${key}:`, ...value.map((v) => `  - ${yamlFlowMap(v)}`));
      } else lines.push(`${key}: ${yamlFlowList(value)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

/** A recipe's ingredients (frontmatter data), [] when it has none recorded. */
export const ingredientsOf = (data) => (Array.isArray(data?.ingredients) ? data.ingredients : []);

const LIST_MARKER = /^\s*(?:\d+[.)]|[-*+])\s+/;

export function normalizeInstruction(step) {
  return step.replace(LIST_MARKER, "").replace(/\s+/g, " ").trim();
}

/** Soft check: warn when an ingredient is mentioned in the method without being bolded. */
export function instructionWarnings(ingredients, instructions) {
  const warnings = [];
  const steps = instructions.map((s) => s.replace(/\*\*[^*]+\*\*/g, " "));
  const bolded = instructions.join(" ").match(/\*\*[^*]+\*\*/g) || [];
  if (instructions.length && !bolded.length) {
    warnings.push("No ingredient is bolded in the instructions. Bold every ingredient mention, e.g. 'stir in the **oats**'.");
    return warnings;
  }
  for (const ing of ingredients) {
    const name = ing.name.trim().toLowerCase();
    if (!name) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    steps.forEach((s, idx) => {
      if (re.test(s)) warnings.push(`Step ${idx + 1} mentions "${ing.name}" without bolding it.`);
    });
  }
  return [...warnings, ...instructionQuantityWarnings(instructions)];
}

// An amount with a unit (or a bare number) right before a bolded ingredient,
// e.g. "add 37.5 g **sugar**", "heat 1 tablespoon of **olive oil**", "3 ст. л. **цукру**".
const UNIT = "(?:g|kg|ml|l|tsp|tbsp|teaspoons?|tablespoons?|cups?|oz|lb|pinch(?:es)?|г|кг|мл|л|ст\\.\\s*л\\.|ч\\.\\s*л\\.)";
const QTY_BEFORE_INGREDIENT = new RegExp(
  `(\\d+(?:[.,]\\d+)?[¼½¾⅓⅔⅛]?|[¼½¾⅓⅔⅛])(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:${UNIT}(?![\\p{L}])\\s*(?:of\\s+)?)?(?:the\\s+)?\\*\\*`,
  "giu"
);

/** Soft check: warn when the method repeats an amount that belongs in the ingredient list. */
export function instructionQuantityWarnings(instructions) {
  const warnings = [];
  instructions.forEach((s, idx) => {
    for (const m of s.matchAll(QTY_BEFORE_INGREDIENT)) {
      const amount = m[0].replace(/\s*(?:of\s+)?(?:the\s+)?\*\*$/i, "").trim();
      const name = s.slice(m.index + m[0].length).match(/^[^*]+/)?.[0] || "ingredient";
      warnings.push(
        `Step ${idx + 1} repeats a quantity ("${amount} ${name}"). The servings selector only rescales the ingredient list, ` +
          `so refer to it instead: "the **${name}**", "half the **${name}**", "the remaining **${name}**".`
      );
    }
  });
  return warnings;
}

export function renderInstructions(steps) {
  return steps.map((s, i) => `${i + 1}. ${normalizeInstruction(s)}`).join("\n");
}

/** Splits a recipe body into its "## " sections, keeping any preamble. */
export function parseSections(body) {
  const sections = [];
  let current = { heading: null, content: [] };
  for (const line of body.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      sections.push(current);
      current = { heading: m[1], content: [] };
    } else {
      current.content.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, content: s.content.join("\n").trim() }))
    .filter((s) => s.heading !== null || s.content);
}

export function renderSections(sections) {
  return (
    sections
      .map((s) => (s.heading === null ? s.content : `## ${s.heading}\n\n${s.content}`.trimEnd()))
      .join("\n\n")
      .trim() + "\n"
  );
}

/** Free text after the numbered list in an Instructions section (e.g. a nutrition line). */
export function trailingText(instructionsContent) {
  const lines = instructionsContent.split("\n");
  let lastListLine = -1;
  lines.forEach((l, i) => {
    if (/^\s*\d+[.)]\s+/.test(l) || (lastListLine === i - 1 && /^\s{2,}\S/.test(l))) lastListLine = i;
  });
  return lastListLine === -1 ? "" : lines.slice(lastListLine + 1).join("\n").trim();
}

export function parseRecipe(raw) {
  // Passing options disables gray-matter's global cache, whose returned objects
  // would otherwise be shared (and mutated by us) across calls.
  const { data, content } = matter(raw, {});
  return { data: structuredClone(data), sections: parseSections(content) };
}

export function serializeRecipe(data, sections) {
  return `${renderFrontmatter(data)}\n${renderSections(sections)}`;
}

/** Replace (or insert, or with content null remove) one "## heading" section. */
export function setSection(sections, heading, content, { after } = {}) {
  const idx = sections.findIndex((s) => s.heading?.toLowerCase() === heading.toLowerCase());
  if (content === null) {
    if (idx !== -1) sections.splice(idx, 1);
    return sections;
  }
  if (idx !== -1) {
    sections[idx] = { heading: sections[idx].heading, content };
  } else {
    const afterIdx = after ? sections.findIndex((s) => s.heading?.toLowerCase() === after.toLowerCase()) : -1;
    sections.splice(afterIdx === -1 ? sections.length : afterIdx + 1, 0, { heading, content });
  }
  return sections;
}
