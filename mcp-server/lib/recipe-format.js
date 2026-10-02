import matter from "gray-matter";

// Formatting rules mirror .claude/skills/add-recipe/SKILL.md and the
// frontmatter schema in the root CLAUDE.md. Keep them in sync.

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
  const unsafe = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|\s$/.test(s) || (inFlow && /[,[\]{}]/.test(s));
  return unsafe || s === "" ? JSON.stringify(s) : s;
}

function yamlFlowList(items) {
  return `[${items.map((i) => yamlScalar(i, { inFlow: true })).join(", ")}]`;
}

const KEY_ORDER = ["title", "slug", "image", "course", "tags", "total_mins", "serves", "calories", "scalable"];

export function renderFrontmatter(data) {
  const keys = [...KEY_ORDER.filter((k) => k in data), ...Object.keys(data).filter((k) => !KEY_ORDER.includes(k))];
  const lines = [];
  for (const key of keys) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (key === "tags" && value.length === 0) continue; // omit the key entirely if no tags
      lines.push(`${key}: ${yamlFlowList(value)}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

const TO_TASTE = /\bto (taste|serve)\b/i;

export function validateIngredient(ing, i) {
  const errors = [];
  const where = `ingredients[${i}]`;
  if (!ing.name.trim()) errors.push(`${where}: name is empty`);
  if (/\*/.test(ing.name)) errors.push(`${where}: name must be plain text, the server adds the bold`);
  if (/\*\*/.test(ing.quantity || "") || /\*\*/.test(ing.note || "")) {
    errors.push(`${where}: quantity/note must not contain bold — only the ingredient name is bolded`);
  }
  if (!ing.quantity?.trim() && !TO_TASTE.test(ing.note || "")) {
    errors.push(`${where} (${ing.name}): every ingredient needs a quantity, or a note saying "to taste" / "to serve"`);
  }
  return errors;
}

export function renderIngredient({ quantity, name, note }) {
  let line = "- ";
  if (quantity?.trim()) line += `${quantity.trim()} `;
  line += `**${name.trim()}**`;
  const n = note?.trim();
  if (n) {
    // "(0% or full-fat)" sits right after the name; anything else is a ", prep note".
    if (n.startsWith("(")) line += ` ${n}`;
    else if (n.startsWith(",")) line += n;
    else line += `, ${n}`;
  }
  return line;
}

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
  return warnings;
}

/** Ingredient names (the bolded parts) from an existing Ingredients section. */
export function ingredientNamesFromSection(content) {
  return [...(content || "").matchAll(/\*\*([^*]+)\*\*/g)].map((m) => ({ name: m[1] }));
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
