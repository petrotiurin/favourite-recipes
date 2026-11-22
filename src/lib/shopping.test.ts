import { describe, expect, it } from "vitest";
import type { ShoppingList } from "../../shared/shopping-list.ts";
import { formatDate, planOf, shoppingProps } from "./shopping.ts";

const list: ShoppingList = {
  updated: "2026-11-20T10:00:00Z",
  recipes: ["b", "a"],
  servings: { a: 2, b: 0 },
  stocktake: "2026-11-21T11:00:00Z",
  sections: [
    { name: "Veg", items: [{ name: "Garlic", quantity: "4", have: true }, { name: "Spinach", quantity: "200g", recipes: ["a"], have: 100 }, { name: "Salt" }] },
    { name: "Pantry", items: [{ name: "Rice", quantity: "400g", recipes: ["a", "b"], amounts: { a: 200, b: 200 } }, { name: "Oil", quantity: "1", have: true }] },
  ],
};

describe("the shopping page's numbers", () => {
  it("plans every covered recipe, 4 when none is set or it's no use", () => {
    expect(planOf(list)).toEqual({ a: 2, b: 4 });
  });

  it("writes dates", () => {
    expect(formatDate("2026-11-21T11:00:00Z")).toBe("21 Nov 2026");
    expect(formatDate("nonsense")).toBe("");
  });

  it("gives the island the list, the plan, the recipes and where the editor saves", () => {
    const props = shoppingProps(list, [{ slug: "a", title: "A", image: "/images/recipes/a.jpg" }], "https://api.test/stocktake", planOf(list));
    expect(props.recipes).toEqual({ a: { title: "A", image: "images/recipes/a.jpg", href: "recipes/a.html" } });
    expect(props.sections).toBe(list.sections);
    expect(props.version).toMatch(/^[0-9a-f]{12}$/);
    expect(props).toMatchObject({ plan: { a: 2, b: 4 }, stocktake: "2026-11-21T11:00:00Z", stocktakeApi: "https://api.test/stocktake" });
    expect(shoppingProps(list, [], null, {}).stocktakeApi).toBeNull();
  });

  it("changes the version with the items and quantities, not with the stocktake or the plan", () => {
    const v = (l: ShoppingList) => shoppingProps(l, [], null, planOf(l)).version;
    expect(v({ ...list, stocktake: undefined, servings: {} })).toBe(v(list));
    const more: ShoppingList = { ...list, sections: [{ name: "Veg", items: [{ name: "Garlic", quantity: "5" }] }] };
    expect(v(more)).not.toBe(v(list));
  });
});
