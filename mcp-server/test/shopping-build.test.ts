// The shopping list as a sum (docs/structured-ingredients.md sections 3 and 6): buildShoppingList over the recipes' data and the catalogue,
// the review flags, the patches, and the real book's list being valid by construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { buildShoppingList, validateSections, neededAmount } from "../lib/shopping-list.ts";
import { parseCatalogue } from "../lib/catalogue.ts";

const ROOT = new URL("../../", import.meta.url);
const CAT = {
  lime: { name: "Limes", section: "Fresh produce", unit: "count", per: { juice: 1, zest: 1 } },
  rice: { name: "Basmati rice", section: "Pantry", unit: "g", per: { cup: 190 } },
  milk: { name: "Milk", section: "Dairy & eggs", unit: "ml" },
  garlic: { name: "Garlic", section: "Fresh produce", unit: "clove" },
  tomatoes: { name: "Tomatoes", section: "Fresh produce", unit: "count" },
  "cherry-tomatoes": { name: "Cherry tomatoes", section: "Fresh produce", unit: "count" },
  salt: { name: "Salt", section: "Pantry", staple: true },
  water: { name: "Water", skip: true },
  sesame: { name: "Sesame seeds", section: "Pantry", unit: "g", per: { tbsp: 9 } },
};
const R = (slug: any, serves: any, ingredients: any) => ({ slug, serves, ingredients });
const curry = R("curry", 4, [
  { amount: 1, unit: "cup", name: "rice", item: "rice" },
  { amount: 1, unit: "juice", name: "lime", item: "lime" },
  { amount: [2, 3], unit: "tbsp", name: "milk", item: "milk" },
  { amount: 2, unit: "clove", name: "garlic", item: "garlic" },
  { name: "salt", note: "to taste", item: "salt" },
  { amount: 500, unit: "ml", name: "water", item: "water" },
  { name: "sesame seeds", note: "to serve", optional: true, item: "sesame" },
  { amount: 4, name: "tomatoes", item: "tomatoes" },
]);
const bowl = R("bowl", 2, [
  { amount: 100, unit: "g", name: "rice", item: "rice" },
  { amount: 0.5, unit: "juice", name: "lime", item: "lime" },
  { amount: 1, unit: "tbsp", name: "sesame seeds", item: "sesame" },
  { amount: 6, name: "cherry tomatoes", item: "cherry-tomatoes" },
]);
const items = (b: any) => Object.fromEntries(b.sections.flatMap((s: any) => s.items.map((i: any) => [i.name, { ...i, section: s.name }])));

test("the list is the sum: converted to the shopping unit, scaled to 2 servings, totalled per item with each recipe's share", () => {
  const b = buildShoppingList([curry, bowl], CAT);
  const it = items(b);
  // rice: curry 190g x 2/4 = 95, bowl 100g x 2/2 = 100
  assert.deepEqual(it["Basmati rice"], { name: "Basmati rice", quantity: "195g", recipes: ["bowl", "curry"], amounts: { curry: 95, bowl: 100 }, section: "Pantry" });
  // milk: the top of the range, 3 tbsp = 45ml, x 1/2
  assert.equal(it.Milk.quantity, "22.5ml".replace("22.5", "23"));
  assert.deepEqual(it.Limes.amounts, { curry: 0.5, bowl: 0.5 });
  assert.equal(it.Limes.quantity, "1");
  assert.equal(it.Garlic.quantity, "1 clove");
  assert.equal(it.Salt.quantity, undefined, "a staple: listed without a quantity");
  assert.equal(it.Salt.section, "Pantry");
  assert.ok(!it.Water, "skip: never on the list");
  assert.equal(it["Sesame seeds"].note, undefined, "needed by a non-optional ingredient too: not optional");
  assert.deepEqual(b.optional, []);
  assert.deepEqual(b.sections.map((s) => s.name), ["Fresh produce", "Dairy & eggs", "Pantry"], "aisles in the fixed order");
  // valid by construction: no kitchen measures, shares add up
  validateSections(b.sections);
  sharesAddUp(b.sections);
});

/** Every item for several recipes carries its shares (a recipe that only seasons "to taste" has none), adding up to its quantity. */
function sharesAddUp(sections: any) {
  for (const i of sections.flatMap((s: any) => s.items)) {
    if (!i.quantity || i.recipes.length < 2) continue;
    assert.ok(i.amounts, `${i.name} has shares`);
    assert.ok(Object.keys(i.amounts).every((slug) => i.recipes.includes(slug)), i.name);
    const total: any = Object.values(i.amounts).reduce((a: any, b: any) => a + b, 0);
    assert.ok(Math.abs(total - parseFloat(i.quantity)) <= Math.max(0.05, parseFloat(i.quantity) * 0.01), `${i.name}: ${total} vs ${i.quantity}`);
  }
}

test("optional: an item only optional ingredients need is marked optional and listed for the card; flags at the planned servings", () => {
  const b = buildShoppingList([curry], CAT, [], { curry: 4 });
  assert.deepEqual(b.optional, [{ item: "sesame", name: "Sesame seeds", quantity: "", recipes: ["curry"] }]);
  assert.equal(items(b)["Sesame seeds"].note, "optional");
  // limes: 0.5 at 2 servings, 1 at the planned 4: no fraction to flag; at 3 servings it is 0.75
  assert.ok(!b.flags.some((f) => f.key === "fraction:lime"));
  const three = buildShoppingList([curry], CAT, [], { curry: 3 });
  assert.ok(three.flags.some((f) => f.key === "fraction:lime"));
  // close names on the same unit: tomatoes / cherry tomatoes
  const both = buildShoppingList([curry, bowl], CAT);
  assert.ok(both.flags.some((f) => f.key === "close:cherry-tomatoes+tomatoes"));
  // a recipe with no ingredients contributes nothing and is named
  const empty = buildShoppingList([curry, R("toast", 1, [])], CAT);
  assert.deepEqual(empty.empty, ["toast"]);
  assert.ok(empty.flags.some((f) => f.key === "empty:toast"));
});

test("patches: round_up at the planned servings, merge, note, move, rename, drop, scale; a patch whose item is gone is stale, not an error", () => {
  const plan = { curry: 3, bowl: 4 };
  const base = buildShoppingList([curry, bowl], CAT, [], plan);
  const b = buildShoppingList([curry, bowl], CAT, [
    { round_up: "lime" },
    { merge: ["tomatoes", "cherry-tomatoes"] },
    { note: { item: "rice", text: "wholegrain" } },
    { move: { item: "milk", section: "Pantry" } },
    { rename: { item: "garlic", name: "Garlic bulbs" } },
    { drop: "sesame" },
    { scale: { item: "salt", factor: 2 } },
    { drop: "no-such-item" },
  ], plan);
  const it = items(b);
  const lime = { name: "Limes", amounts: it.Limes.amounts, recipes: it.Limes.recipes, quantity: it.Limes.quantity };
  const planned = neededAmount(lime, plan);
  assert.equal(planned!, Math.ceil(neededAmount({ ...lime, amounts: items(base).Limes.amounts }, plan)!), "whole at the planned servings");
  assert.ok(neededAmount({ ...lime, amounts: items(base).Limes.amounts }, plan)! % 1 !== 0, "it was a fraction before");
  assert.ok(!b.flags.some((f) => f.key === "fraction:lime"));
  assert.ok(!it["Cherry tomatoes"]);
  assert.equal(it.Tomatoes.quantity, "8");
  assert.deepEqual(it.Tomatoes.recipes, ["bowl", "curry"]);
  assert.equal(it["Basmati rice"].note, "wholegrain");
  assert.equal(it.Milk.section, "Pantry");
  assert.ok(it["Garlic bulbs"]);
  assert.ok(!it["Sesame seeds"]);
  assert.equal(b.stale.length, 1, "only the missing item is stale (scaling salt, which has no amount, is a no-op)");
  assert.match(b.stale.find((x) => x.edit.drop === "no-such-item").why, /isn't on the list any more/);
  // a merge across units is refused on its own
  const bad = buildShoppingList([curry, bowl], CAT, [{ merge: ["rice", "milk"] }]);
  assert.match(bad.stale[0].why, /aren't bought in the same unit/);
  assert.ok(items(bad).Milk, "nothing merged");
});

test("the real book: next week's list builds for every recipe, valid by construction, in milliseconds", () => {
  const catalogue = parseCatalogue(readFileSync(new URL("data/ingredients.json", ROOT), "utf8"));
  const book = readdirSync(new URL("recipes/", ROOT)).map((f) => ({ slug: f.slice(0, -3), ...matter(readFileSync(new URL(`recipes/${f}`, ROOT), "utf8")).data }));
  const t0 = performance.now();
  const b = buildShoppingList(book, catalogue);
  assert.ok(performance.now() - t0 < 500);
  assert.deepEqual(b.problems, []);
  validateSections(b.sections);
  sharesAddUp(b.sections);
  const covered = new Set(b.sections.flatMap((s: any) => s.items.flatMap((i: any) => i.recipes)));
  assert.deepEqual(book.filter((r: any) => r.ingredients.length && !covered.has(r.slug)).map((r: any) => r.slug), [], "every recipe with ingredients is on the list");
});
