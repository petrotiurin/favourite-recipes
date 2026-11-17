// The recipe page's rounding when its 1/2/4 picker rescales the ingredient list (templates/servings.js format()). Duplicated here (the
// server is deployed on its own and can't import the site's templates): KEEP IN STEP with servings.js. test/phase6.test.js checks both
// round the same. The numbers themselves come from the recipe's structured ingredients (scaledMarkdown in lib/ingredient-line.js).

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
