import { test, expect } from "vitest";
import { BASE_SERVINGS, DEFAULT_SERVINGS, loadShoppingList, neededAmount, parseQuantity, type Plan } from "../shopping-list.ts";

test("parseQuantity: an amount and the rest as its unit", () => {
  expect(parseQuantity("400g")).toEqual({ amount: 400, unit: "g" });
  expect(parseQuantity("3")).toEqual({ amount: 3, unit: "" });
  expect(parseQuantity("2 heads")).toEqual({ amount: 2, unit: "heads" });
  expect(parseQuantity(" 1.5 l ")).toEqual({ amount: 1.5, unit: "l" });
  expect(parseQuantity("a pinch")).toBeNull();
  expect(parseQuantity(undefined)).toBeNull();
});

test("neededAmount: each recipe's share scaled by its servings, else the average of the recipes'", () => {
  const plan: Plan = { a: 4, b: 2, c: 6 };
  expect(neededAmount({ quantity: "400g", recipes: ["a"] }, plan)).toBe(800);
  expect(neededAmount({ quantity: "400g", recipes: ["a", "b"], amounts: { a: 100, b: 300 } }, plan)).toBe(500);
  // older lists have no amounts: the average of the recipes' servings (4 and 2 -> 3)
  expect(neededAmount({ quantity: "400g", recipes: ["a", "b"] }, plan)).toBe(600);
  // not on the plan: DEFAULT_SERVINGS
  expect(neededAmount({ quantity: "2", recipes: ["zzz"] }, plan)).toBe((2 * DEFAULT_SERVINGS) / BASE_SERVINGS);
  expect(neededAmount({ quantity: "2" }, {})).toBe((2 * DEFAULT_SERVINGS) / BASE_SERVINGS);
  expect(neededAmount({ quantity: "some" }, plan)).toBeNull();
  // not rounded: the callers round for what they show
  expect(neededAmount({ quantity: "100g", recipes: ["a"] }, { a: 3 })).toBeCloseTo(150, 10);
  expect(neededAmount({ quantity: "100g", recipes: ["a"] }, { a: 5 })).toBe(250);
  expect(neededAmount({ quantity: "1", recipes: ["a"], amounts: { a: 1 } }, { a: 1 / 3 })).toBeCloseTo(1 / 6, 10);
});

test("loadShoppingList: the sections with a name and items, or null", () => {
  const list = { updated: "2026-11-01", recipes: ["a"], servings: { a: 4 }, stocktake: "2026-11-02T10:00:00.000Z", sections: [{ name: "Pantry", items: [{ name: "Rice", quantity: "500g" }] }] };
  expect(loadShoppingList(JSON.stringify(list))).toEqual(list);
  // sections that can't be shown are dropped, everything else in the file is kept
  const messy = { ...list, sections: [null, { name: "", items: [{ name: "x" }] }, { name: "Empty", items: [] }, { name: "NoItems" }, ...list.sections] };
  expect(loadShoppingList(JSON.stringify(messy))).toEqual(list);
  expect(loadShoppingList(JSON.stringify({ ...list, sections: [{ name: "Empty", items: [] }] }))).toBeNull();
  expect(loadShoppingList(JSON.stringify({ updated: "x" }))).toBeNull();
  const warnings: string[] = [];
  expect(loadShoppingList("{ not json", (m) => warnings.push(m))).toBeNull();
  expect(loadShoppingList("null", (m) => warnings.push(m))).toBeNull();
  expect(loadShoppingList("[]", (m) => warnings.push(m))).toBeNull();
  expect(warnings).toHaveLength(3);
  expect(loadShoppingList("")).toBeNull();
  expect(loadShoppingList(null)).toBeNull();
});
