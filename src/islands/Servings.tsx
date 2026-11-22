// The 1/2/4-servings selector on recipe pages (`client:visible`): "Serves" and the segmented control, with the recipe's own number among the
// options. Written at build time with the recipe's own number pressed (the amounts on the page are for it); once loaded it opens at
// DEFAULT_SERVINGS (4), like the shopping page, and rescales the amounts IngredientList.astro writes as `.qty` (src/lib/rescale.ts). The chat reads
// the pressed button (`.servings-picker [aria-pressed="true"]`, `data-serves`). The picked number is in the shared store (src/lib/servings.ts).
import { useEffect, useLayoutEffect } from "preact/hooks";
import { DEFAULT_SERVINGS } from "../../shared/servings.ts";
import { rescale } from "../lib/rescale.ts";
import { servings } from "../lib/servings.ts";

export default function Servings({ serves }: { serves: number }) {
  const options = [...new Set([1, 2, 4, serves])].sort((a, b) => a - b);
  const picked = servings.value ?? serves;
  useEffect(() => {
    servings.value = DEFAULT_SERVINGS;
  }, []);
  // In the same frame as the pressed button, so the amounts never lag a tap.
  useLayoutEffect(() => rescale(document, serves, picked), [serves, picked]);
  return (
    <div class="servings-picker" data-base={serves}>
      <span class="servings-label" id="servings-label">Serves</span>
      <div class="seg" role="group" aria-labelledby="servings-label">
        {options.map((n) => (
          <button type="button" data-serves={n} aria-pressed={n === picked ? "true" : "false"} onClick={() => (servings.value = n)}>{n}</button>
        ))}
      </div>
    </div>
  );
}
