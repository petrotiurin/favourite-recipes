import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parseRecipe, serializeRecipe, renderIngredient, slugify, validateIngredient, instructionWarnings, trailingText } from "../lib/recipe-format.js";
import { isAllowedPath } from "../lib/github.js";

const RECIPES = new URL("../../recipes/", import.meta.url);

test("every existing recipe round-trips byte-for-byte", () => {
  for (const f of readdirSync(RECIPES)) {
    const raw = readFileSync(new URL(f, RECIPES), "utf8");
    const { data, sections } = parseRecipe(raw);
    assert.equal(serializeRecipe(data, sections), raw, f);
  }
});

test("slugify matches existing slugs", () => {
  assert.equal(slugify("Harissa Tuna Pitta"), "harissa-tuna-pitta");
  assert.equal(slugify("Mac & Cheese!"), "mac-and-cheese");
  assert.equal(slugify("Crème Brûlée"), "creme-brulee");
  assert.equal(slugify("Mum's Pie"), "mums-pie");
});

test("ingredient rendering bolds only the name", () => {
  assert.equal(renderIngredient({ quantity: "20g (¾oz)", name: "red onion", note: "thinly sliced" }), "- 20g (¾oz) **red onion**, thinly sliced");
  assert.equal(renderIngredient({ name: "Salt and black pepper", note: "to taste" }), "- **Salt and black pepper**, to taste");
  assert.equal(renderIngredient({ quantity: "2 heaped tbsp", name: "Greek yogurt", note: "(0% or full-fat)" }), "- 2 heaped tbsp **Greek yogurt** (0% or full-fat)");
});

test("ingredient validation", () => {
  assert.equal(validateIngredient({ name: "salt" }, 0).length, 1);
  assert.equal(validateIngredient({ name: "salt", note: "to taste" }, 0).length, 0);
  assert.equal(validateIngredient({ name: "**salt**", quantity: "1 tsp" }, 0).length, 1);
});

test("instruction warnings flag unbolded ingredients", () => {
  const w = instructionWarnings([{ name: "oats" }, { name: "honey" }], ["Mix the **oats** with honey"]);
  assert.deepEqual(w, ['Step 1 mentions "honey" without bolding it.']);
});

test("trailing text after the method is detected", () => {
  assert.equal(trailingText("1. a\n2. b\n\nApprox. 400 kcal"), "Approx. 400 kcal");
  assert.equal(trailingText("1. a\n2. b"), "");
});

test("path allowlist", () => {
  assert.ok(isAllowedPath("recipes/foo-bar.md"));
  assert.ok(isAllowedPath("images/recipes/foo.jpg"));
  for (const p of ["build.js", "mcp-server/lib/server.js", "recipes/../build.js", ".github/workflows/deploy.yml", "recipes/Foo.md", "images/recipes/x.svg", "recipes/sub/x.md"]) {
    assert.ok(!isAllowedPath(p), p);
  }
});

test("instruction warnings flag quantities repeated in the method", () => {
  const w = instructionWarnings([{ name: "sugar" }, { name: "olive oil" }], [
    "Add 37.5 g **sugar** and stir",
    "Heat 1 tablespoon of **olive oil**",
    "Add half the **sugar**, then the remaining **olive oil**",
    "Bake for 45 minutes at 180°C",
  ]);
  assert.equal(w.length, 2);
  assert.match(w[0], /^Step 1 repeats a quantity \("37\.5 g sugar"\)/);
  assert.match(w[1], /^Step 2 repeats a quantity \("1 tablespoon olive oil"\)/);
});

test("ASCII fractions in quantities become unicode so they rescale", () => {
  assert.equal(renderIngredient({ quantity: "1 1/2 cups", name: "flour" }), "- 1½ cups **flour**");
  assert.equal(renderIngredient({ quantity: "150g (2/3 cup)", name: "Greek yogurt" }), "- 150g (⅔ cup) **Greek yogurt**");
  assert.equal(renderIngredient({ quantity: "Juice of 1/2", name: "lemon" }), "- Juice of ½ **lemon**");
});

test("shopping-list.json is writable; other root files still aren't", () => {
  assert.equal(isAllowedPath("shopping-list.json"), true);
  assert.equal(isAllowedPath("build.js"), false);
  assert.equal(isAllowedPath("data/shopping-list.json"), false);
});

test("shopping list rejects kitchen measures and mixed sums", async () => {
  const { validateSections, ShoppingListError } = await import("../lib/shopping-list.js");
  const list = (quantity) => [{ name: "Section", items: [{ name: "Rice vinegar", quantity }] }];
  assert.doesNotThrow(() => validateSections(list("145ml")));
  assert.doesNotThrow(() => validateSections(list("2 heads")));
  assert.throws(() => validateSections(list("3 tbsp")), ShoppingListError);
  assert.throws(() => validateSections(list("100ml + 3 tbsp")), ShoppingListError);
  assert.throws(() => validateSections(list("2 heaped tbsp")), ShoppingListError);
});
