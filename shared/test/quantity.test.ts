import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatQuantity } from "../quantity.ts";
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

// templates/servings.js is still the browser's own copy until it becomes an island (docs/typescript-migration.md step 6): it must round
// like formatQuantity. Delete this test with that copy.
test("the recipe page's servings.js rounds like formatQuantity", () => {
  const src = fs.readFileSync(path.resolve("templates/servings.js"), "utf8");
  const fractions = src.match(/var FRACTIONS = \[[\s\S]*?\];/)![0];
  const fn = src.match(/function format\(value\) \{[\s\S]*?\n  \}/)![0];
  const format = new Function(`${fractions}\n${fn}\nreturn format;`)() as (v: number) => string;
  for (let v = 0.01; v < 40; v += 0.01) expect(formatQuantity(v), String(v)).toBe(format(v));
});
