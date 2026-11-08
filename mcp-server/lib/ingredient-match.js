// Matching an ingredient name against another ("cherry tomatoes" ~ "tomatoes"), shared by the at-home ranking and the stocktake by chat.

const norm = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("oes") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");

/** Does the at-home item cover the recipe ingredient? Same words, or one name contains the other as whole words ("cherry tomatoes" ~ "tomatoes"). */
export function sameIngredient(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const has = (long, short) => ` ${long} `.includes(` ${short} `);
  return has(x, y) || has(y, x);
}

