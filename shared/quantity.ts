// The rounding of a scaled amount: the recipe page's 1/2/4 picker (src/islands/Servings.tsx, through src/lib/rescale.ts) and the backend's
// scale_recipe (scaledMarkdown in ingredient-line.ts) both show numbers this way.

const STEPS: readonly (readonly [number, string])[] = [[0, ""], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""]];

/** Whole numbers from 10 up, else the nearest ¼ ⅓ ½ ⅔ ¾ (and ⅛ for what would round to nothing). */
export function formatQuantity(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const whole = Math.floor(value);
  const frac = value - whole;
  let best = STEPS[0];
  for (const f of STEPS) if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
  if (best[0] === 1) return String(whole + 1);
  if (whole === 0 && best[0] === 0) return "⅛";
  return (whole ? String(whole) : "") + best[1];
}
