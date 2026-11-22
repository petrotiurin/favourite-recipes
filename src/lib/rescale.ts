// Rescaling the ingredient amounts on a recipe page for the servings picked. The amounts are `.qty` elements written at build time by
// IngredientList.astro with the amount in `data-qty` (for the recipe's own servings), and the unit words are `.qty-unit` with the
// singular and plural in `data-one` / `data-many`.
import { formatQuantity } from "../../shared/quantity.ts";

const number = (el: Element, attr: string) => parseFloat(el.getAttribute(attr) ?? "");

/** Writes the amounts for `serves` people into the page, from a recipe that is written for `base`. The text as the page was written is kept in `data-original` and put back at the recipe's own number. */
export function rescale(root: ParentNode, base: number, serves: number): void {
  const factor = serves / base;
  root.querySelectorAll(".qty").forEach((el) => {
    if (!el.hasAttribute("data-original")) el.setAttribute("data-original", el.textContent ?? "");
    el.textContent = factor === 1 ? el.getAttribute("data-original") : formatQuantity(number(el, "data-qty") * factor);
  });
  // "1 clove" -> "2 cloves": the unit word follows the (last) number before it in the same line.
  root.querySelectorAll(".qty-unit").forEach((el) => {
    const nums = el.parentElement?.querySelectorAll(".qty");
    const last = nums?.length ? number(nums[nums.length - 1], "data-qty") * factor : 1;
    el.textContent = last > 1 ? el.getAttribute("data-many") : el.getAttribute("data-one");
  });
}
