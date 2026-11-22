import { test, expect } from "vitest";
import { formatAmount, formatNumber, formatQuantity, withUnit } from "../quantity.ts";
import { scaledMarkdown } from "../ingredient-line.ts";

test("scaled amounts round to the nearest ¼ ⅓ ½ ⅔ ¾, and to whole numbers from 10", () => {
  expect(formatQuantity(0.1)).toBe("⅛");
  expect(formatQuantity(0.3)).toBe("⅓");
  expect(formatQuantity(1.45)).toBe("1½");
  expect(formatQuantity(3.9)).toBe("4");
  expect(formatQuantity(9.99)).toBe("10");
  expect(formatQuantity(12.4)).toBe("12");
  expect(formatQuantity(37.5)).toBe("38");
});

test("scaledMarkdown scales the data's amounts the way the page does", () => {
  expect(scaledMarkdown({ amount: 150, unit: "g", name: "Greek yogurt", note: "diced" }, 1.5)).toBe("225g **Greek yogurt**, diced");
  expect(scaledMarkdown({ amount: 0.5, name: "lemon" }, 3)).toBe("1½ **lemon**");
  expect(scaledMarkdown({ amount: 1, unit: "clove", name: "garlic" }, 2)).toBe("2 cloves **garlic**");
  expect(scaledMarkdown({ amount: [1, 2], unit: "tsp", name: "paprika" }, 2)).toBe("2–4 tsp **paprika**");
  expect(scaledMarkdown({ amount: 1, name: "onion" }, 1)).toBe("1 **onion**");
});

test("the shopping list writes an amount with its unit: metric attached, one decimal under 10, others as a recipe would", () => {
  expect(formatNumber(2.46, "kg")).toBe("2.5");
  expect(formatNumber(12.4, "g")).toBe("12");
  expect(formatNumber(1.5, "heads")).toBe("1½");
  expect(formatNumber(0.1, "")).toBe("⅛");
  expect(withUnit("500", "g")).toBe("500g");
  expect(withUnit("2", "heads")).toBe("2 heads");
  expect(withUnit("3", "")).toBe("3");
  expect(formatAmount(2.5, "kg")).toBe("2.5kg");
  expect(formatAmount(1.256, "heads")).toBe("1¼ heads");
  expect(formatAmount(3, "")).toBe("3");
});
