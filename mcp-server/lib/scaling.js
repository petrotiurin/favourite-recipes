// Scaling a recipe's ingredient list to N servings, the way the recipe page does it (templates/quantities.js tags the numbers at build time,
// templates/servings.js rescales and formats them). The rules are duplicated here (the server is deployed on its own and can't import the
// site's templates): KEEP IN STEP with quantities.js (which numbers scale) and servings.js (format). test/phase6.test.js checks that both pick
// the same numbers. Skipped on purpose: numbers inside the bolded name, percentages, anything after the "x" in "2 x 150g", and anything inside
// a parenthetical containing "each".

const FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const NUM = "(?:\\d+(?:\\.\\d+)?[¼½¾⅓⅔⅛]?|[¼½¾⅓⅔⅛])";
const RANGE_RE = new RegExp(`(?<![\\d.])(${NUM})(?:(\\s*[-–]\\s*)(${NUM}))?(?!\\d)(\\s*%)?`, "g");

function parseNumber(str) {
  const m = str.match(/^(\d+(?:\.\d+)?)?([¼½¾⅓⅔⅛])?$/);
  return (m[1] ? parseFloat(m[1]) : 0) + (m[2] ? FRACTIONS[m[2]] : 0);
}

const STEPS = [[0, ""], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""]];
/** servings.js format(): whole numbers from 10 up, else the nearest ¼ ⅓ ½ ⅔ ¾. */
export function formatQuantity(value) {
  if (value >= 10) return String(Math.round(value));
  const whole = Math.floor(value);
  const frac = value - whole;
  let best = STEPS[0];
  for (const f of STEPS) if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
  if (best[0] === 1) return String(whole + 1);
  if (whole === 0 && best[0] === 0) return "⅛";
  return (whole ? String(whole) : "") + best[1];
}

/**
 * Walks one ingredient line (Markdown: `- 150g **Greek yogurt**, diced`) and calls fn(number, text) for each scalable number, in order;
 * returns the line with each replaced by fn's result.
 */
function mapScalable(line, fn) {
  const parts = line.split(/(\*\*[^*]+\*\*)/); // the bolded name is left alone
  const plain = parts.join("").replace(/\*\*/g, "");
  const eachRanges = [...plain.matchAll(/\([^()]*\beach\b[^()]*\)/g)].map((m) => [m.index, m.index + m[0].length]);
  let offset = 0;
  return parts
    .map((part) => {
      const isName = /^\*\*[^*]+\*\*$/.test(part);
      const inner = isName ? part.slice(2, -2) : part;
      const start = offset;
      offset += inner.length;
      if (isName) return part;
      let out = "";
      let last = 0;
      const perItem = part.search(/\d\s*x\s*\d/);
      for (const m of part.matchAll(RANGE_RE)) {
        out += part.slice(last, m.index);
        last = m.index + m[0].length;
        const afterX = perItem !== -1 && m.index > perItem;
        if (m[4] || afterX || eachRanges.some(([a, b]) => start + m.index >= a && start + m.index < b)) {
          out += m[0];
          continue;
        }
        out += fn(parseNumber(m[1]), m[1]);
        if (m[3]) out += m[2] + fn(parseNumber(m[3]), m[3]);
      }
      return out + part.slice(last);
    })
    .join("");
}

/** The scalable numbers of an ingredient line (what quantities.js tags as data-qty), in order. */
export const scalableNumbers = (line) => {
  const found = [];
  mapScalable(line, (n) => (found.push(n), ""));
  return found;
};

/** The ingredient line with its scalable numbers multiplied by `factor` (1 leaves it as written). */
export const scaleLine = (line, factor) => (factor === 1 ? line : mapScalable(line, (n) => formatQuantity(n * factor)));

/** The bullet lines of a recipe Markdown's "## Ingredients" section. */
export function ingredientLines(markdown) {
  const section = String(markdown).split(/^## /m).find((s) => /^Ingredients\b/i.test(s)) || "";
  return section.split("\n").filter((l) => l.startsWith("- "));
}
