import { describe, expect, it } from "vitest";
import type { ShoppingList } from "../../shared/shopping-list.ts";
import { fmtAmount, formatDate, needText, planOf, remaining, shoppingData, splitList } from "./shopping.ts";

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

  it("writes amounts the way the list does", () => {
    expect(fmtAmount(2.5, "kg")).toBe("2.5kg");
    expect(fmtAmount(3, "")).toBe("3");
    expect(fmtAmount(1.256, "heads")).toBe("1.26 heads");
    expect(formatDate("2026-11-21T11:00:00Z")).toBe("21 Nov 2026");
    expect(formatDate("nonsense")).toBe("");
  });

  it("scales a quantity to the plan and takes off what's at home", () => {
    const plan = planOf(list);
    const [, spinach, salt] = list.sections[0].items;
    expect(needText(spinach, plan)).toBe("200g");
    expect(remaining(spinach, plan)).toEqual({ status: "partial", left: "100g" });
    expect(remaining(list.sections[0].items[0], plan)).toEqual({ status: "home", left: "" });
    expect(remaining(salt, plan)).toEqual({ status: "buy", left: "" });
  });

  it("splits the list into what's left to buy by aisle and what's at home", () => {
    const { sections, home, partly } = splitList(list, planOf(list));
    expect(sections.map((s) => [s.name, s.items.map((i) => i.item.name)])).toEqual([["Veg", ["Spinach", "Salt"]], ["Pantry", ["Rice"]]]);
    expect(home.map((i) => i.name)).toEqual(["Garlic", "Oil"]);
    expect(partly).toBe(1);
  });

  it("embeds the list with parsed amounts, the plan and the recipes", () => {
    const data = shoppingData(list, [{ slug: "a", title: "A", image: "/images/recipes/a.jpg" }], null, planOf(list));
    expect(data.recipes).toEqual({ a: { title: "A", image: "images/recipes/a.jpg", href: "recipes/a.html" } });
    expect(data.sections[0].items[1]).toMatchObject({ name: "Spinach", amount: 200, unit: "g" });
    expect(data.version).toMatch(/^[0-9a-f]{12}$/);
    expect(data).toMatchObject({ base: 2, fallback: 4, plan: { a: 2, b: 4 }, auth: null });
  });
});
