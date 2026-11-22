import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { UNITS, ingredientMarkdown as md, ingredientText, ingredientHtml, ingredientGroups, sectionErrors, hasAmounts } from "../ingredient-line.ts";

const dir = path.resolve("recipes");
const book = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ slug: f.slice(0, -3), ...matter(fs.readFileSync(path.join(dir, f), "utf8")).data }) as { slug: string; ingredients: any[] });

test("lines render the fixed way per unit", () => {
  expect(md({ amount: 200, unit: "g", name: "jasmine rice" })).toBe("200g **jasmine rice**");
  expect(md({ amount: 4, name: "salmon fillets", note: "about 140g each" })).toBe("4 **salmon fillets**, about 140g each");
  expect(md({ amount: [2, 3], unit: "tbsp", name: "red curry paste" })).toBe("2–3 tbsp **red curry paste**");
  expect(md({ amount: 0.75, unit: "can", name: "coconut milk" })).toBe("¾ can **coconut milk**");
  expect(md({ amount: 2, unit: "clove", name: "garlic", note: "minced" })).toBe("2 cloves **garlic**, minced");
  expect(md({ amount: 1, unit: "juice", name: "lime" })).toBe("Juice of 1 **lime**");
  expect(md({ amount: 0.5, unit: "zest", name: "lemon" })).toBe("Zest of ½ **lemon**");
  expect(md({ amount: 1, unit: "pinch", name: "salt" })).toBe("Pinch of **salt**");
  expect(md({ amount: 2, unit: "handful", name: "spinach" })).toBe("2 handfuls of **spinach**");
  expect(md({ amount: 0.33, unit: "cup", name: "oats" })).toBe("⅓ cup **oats**");
  expect(md({ amount: 1, unit: "sheet", name: "puff pastry" })).toBe("1 sheet **puff pastry**");
  expect(md({ amount: 2, unit: "stick", name: "celery" })).toBe("2 sticks **celery**");
  expect(md({ amount: 1, unit: "head", name: "broccoli" })).toBe("1 head **broccoli**");
  expect(md({ amount: 37.5, unit: "g", name: "sugar" })).toBe("37.5g **sugar**");
  expect(md({ name: "sesame seeds", note: "to serve", optional: true })).toBe("**sesame seeds**, to serve, optional");
  expect(md({ amount: 500, unit: "g", name: "Greek yogurt", note: "(0% or full-fat)" })).toBe("500g **Greek yogurt** (0% or full-fat)");
  expect(ingredientText({ amount: 2, unit: "clove", name: "garlic", note: "minced" })).toBe("2 cloves garlic, minced");
  // the page tags every number for the servings selector, and the unit word for its plural
  expect(ingredientHtml({ amount: 1, unit: "clove", name: "garlic" })).toBe('<span class="qty" data-qty="1">1</span> <span class="qty-unit" data-one="clove" data-many="cloves">clove</span> <strong>garlic</strong>');
  expect(ingredientHtml({ amount: 2, name: "<b>" }, { scalable: false })).toBe("2 <strong>&lt;b&gt;</strong>");
});

test("every ingredient of the book renders, and the three renderers say the same thing", () => {
  let n = 0;
  for (const r of book) {
    for (const ing of r.ingredients) {
      const where = `${r.slug}: ${ing.name}`;
      expect(UNITS, where).toContain(ing.unit ?? UNITS[0]);
      const text = ingredientText(ing);
      expect(md(ing).replace(/\*\*/g, ""), where).toBe(text);
      expect(ingredientHtml(ing).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'), where).toBe(text);
      expect(text, where).not.toMatch(/undefined|NaN|null/);
      n++;
    }
    expect(sectionErrors(r.ingredients), r.slug).toEqual([]);
  }
  expect(n).toBeGreaterThan(500);
});

test("sections: grouped in order, kept together, refused when split up", () => {
  const list = [
    { amount: 2, name: "chicken breasts" },
    { amount: 1, unit: "tbsp", name: "soy sauce", section: "Marinade" },
    { amount: 2, unit: "tbsp", name: "soy sauce", section: "Sauce" },
    { amount: 1, unit: "tsp", name: "honey", section: "Sauce" },
  ];
  expect(ingredientGroups(list).map((g) => [g.section, g.items.length])).toEqual([[null, 1], ["Marinade", 1], ["Sauce", 2]]);
  expect(sectionErrors(list)).toEqual([]);
  const split = [{ name: "a", section: "Sauce" }, { name: "b", section: "Pickle" }, { name: "c", section: "Sauce" }];
  expect(sectionErrors(split).join()).toMatch(/"Sauce" lines must sit together/);
  expect(sectionErrors([{ name: "a", section: "Sauce" }, { name: "b" }]).join()).toMatch(/lines without a section go first/);
  expect(sectionErrors([{ name: "a", section: "  " }]).join()).toMatch(/short name/);
});

test("hasAmounts: only what the servings selector could rescale counts", () => {
  expect(hasAmounts([{ name: "salt", note: "to taste" }, { amount: 1, unit: "pinch", name: "pepper" }])).toBe(false);
  expect(hasAmounts([{ name: "salt" }, { amount: 2, name: "eggs" }])).toBe(true);
  expect(hasAmounts([])).toBe(false);
});
