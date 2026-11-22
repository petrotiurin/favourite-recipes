// Structured ingredients and the ingredient catalogue (docs/structured-ingredients.md sections 2, 4, 5): the write-time checks, catalogue
// changes, and the site build's check. The ingredient line itself is tested in shared/test/ingredient-line.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import { checkIngredients, applyCatalogueChange, applyCatalogueChanges, parseCatalogue, factorFor, shopAmount, resolveItem } from "../lib/catalogue.js";

const ROOT = new URL("../../", import.meta.url);
const book = readdirSync(new URL("recipes/", ROOT)).map((f) => ({ slug: f.slice(0, -3), ...matter(readFileSync(new URL(`recipes/${f}`, ROOT), "utf8")).data }));
const catalogue = parseCatalogue(readFileSync(new URL("data/ingredients.json", ROOT), "utf8"));

test("every recipe in the book passes the write-time checks, and every name resolves to the item it was given", () => {
  for (const r of book) {
    assert.deepEqual(checkIngredients(r.ingredients, catalogue).errors, [], r.slug);
    const filled = checkIngredients(r.ingredients.map(({ item, ...rest }) => rest), catalogue).ingredients;
    filled.forEach((ing, i) => assert.equal(ing.item, r.ingredients[i].item, `${r.slug}: ${ing.name}`));
  }
});

test("the write-time checks: schema, the item filled from the name, conversions, with what would fix it", () => {
  const cat = {
    capers: { name: "Capers", section: "Tins & jars", unit: "g", aliases: ["baby capers"] },
    lime: { name: "Limes", section: "Fresh produce", unit: "count", per: { juice: 1 } },
    milk: { name: "Milk", section: "Dairy & eggs", unit: "ml" },
    salt: { name: "Salt", section: "Pantry", staple: true },
  };
  const ok = checkIngredients([{ amount: 2, unit: "tbsp", name: "Milk" }, { amount: 1, unit: "juice", name: "lime" }, { name: "salt", note: "to taste" }], cat);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.ingredients.map((i) => i.item), ["milk", "lime", "salt"]);
  const bad = checkIngredients([{ amount: 1, unit: "tbsp", name: "baby capers" }, { amount: 2, name: "gochujang paste" }, { name: "pepper" }, { amount: 2, unit: "oz", name: "milk" }, { amount: [3, 2], unit: "g", name: "capers" }], cat);
  assert.match(bad.errors[0], /Capers \(capers\) is bought in g and has no conversion from tbsp\. Add `per: \{ tbsp: … \}` for capers/);
  assert.match(bad.errors[1], /no catalogue item for "gochujang paste"/);
  assert.match(bad.errors[2], /needs an amount, or a note saying "to taste"/);
  assert.match(bad.errors[3], /unit "oz" isn't one of/);
  assert.match(bad.errors[4], /a range is \[min, max\]/);
  // a given item is kept, so the model can say exactly which one
  assert.equal(checkIngredients([{ amount: 1, name: "something else", item: "lime" }], cat).ingredients[0].item, "lime");
  assert.equal(resolveItem("Limes", cat), "lime");
  assert.equal(resolveItem("large ripe lime", cat), "lime", "size words in front don't change what it is");
  assert.equal(resolveItem("small", cat), null);
  assert.equal(resolveItem("lime", cat), "lime");
});

test("conversions: fixed rules, then the item's per; the top of a range", () => {
  assert.equal(factorFor({ unit: "ml" }, "tbsp"), 15);
  assert.equal(factorFor({ unit: "ml" }, "l"), 1000);
  assert.equal(factorFor({ unit: "g" }, "kg"), 1000);
  assert.equal(factorFor({ unit: "g" }, "tbsp"), null);
  assert.equal(factorFor({ unit: "g", per: { tbsp: 10 } }, "tbsp"), 10);
  assert.equal(factorFor({ unit: "count" }, undefined), 1);
  assert.equal(factorFor({ unit: "clove" }, "clove"), 1);
  assert.equal(shopAmount({ amount: [2, 3], unit: "tbsp", item: "x" }, { unit: "ml" }), 45);
});

test("catalogue changes are checked: ids, names that belong to another item, sections, sane conversions, and nothing in the book may break", () => {
  const cat = { capers: { name: "Capers", section: "Tins & jars", unit: "g", per: { tbsp: 10 } }, olives: { name: "Olives", section: "Tins & jars", unit: "g" } };
  const recipes = [{ slug: "puttanesca", ingredients: [{ amount: 1, unit: "tbsp", name: "capers", item: "capers" }, { amount: 50, unit: "g", name: "olives", item: "olives" }] }];
  const added = applyCatalogueChange(cat, { add: { id: "gochujang", name: "Gochujang", section: "Tins & jars", unit: "g", per: { tbsp: 18 } } }, recipes);
  assert.equal(added.line, "New in the catalogue: Gochujang · Tins & jars");
  assert.ok(!cat.gochujang, "pure: the input is untouched");
  assert.throws(() => applyCatalogueChange(cat, { add: { id: "capers", name: "Capers 2", section: "Tins & jars", unit: "g" } }, recipes), /already in the catalogue/);
  assert.throws(() => applyCatalogueChange(cat, { add: { id: "Bad Id", name: "X", section: "Pantry", unit: "g" } }, recipes), /kebab-case/);
  assert.throws(() => applyCatalogueChange(cat, { add: { id: "caper-berries", name: "Caper berries", aliases: ["olives"], section: "Tins & jars", unit: "g" } }, recipes), /"olives" already belongs to olives/);
  assert.throws(() => applyCatalogueChange(cat, { add: { id: "x", name: "X", section: "Snacks aisle", unit: "g" } }, recipes), /section must be one of/);
  assert.throws(() => applyCatalogueChange(cat, { set: { item: "capers", per: { tbsp: 500 } } }, recipes), /far outside a sane range/);
  assert.throws(() => applyCatalogueChange(cat, { set: { item: "capers", unit: "count" } }, recipes), /puttanesca: capers \(tbsp\) would no longer convert/);
  assert.throws(() => applyCatalogueChange(cat, { remove: { item: "capers" } }, recipes), /used by puttanesca/);
  assert.match(applyCatalogueChange(cat, { set: { item: "capers", section: "Pantry" } }, recipes).line, /used by 1 recipe/);
  assert.deepEqual(applyCatalogueChange(cat, { alias: { item: "capers", name: "Baby capers" } }, recipes).catalogue.capers.aliases, ["baby capers"]);
  const merged = applyCatalogueChanges(cat, [{ add: { id: "caperberries", name: "Caperberries", section: "Tins & jars", unit: "g", per: { tbsp: 10 } } }, { merge: { into: "capers", from: "caperberries" } }], recipes);
  assert.ok(!merged.catalogue.caperberries);
  assert.deepEqual(merged.catalogue.capers.aliases, ["caperberries"]);
  assert.deepEqual(merged.repoints, [{ from: "caperberries", into: "capers" }]);
});

test("the site build refuses a recipe whose ingredient points at no catalogue item, or that still has an Ingredients section", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-"));
  for (const p of ["astro.config.ts", "tsconfig.json", "package.json", "src", "templates", "shared", "styles"]) cpSync(new URL(p, ROOT), join(dir, p), { recursive: true });
  symlinkSync(new URL("node_modules", ROOT).pathname, join(dir, "node_modules"));
  mkdirSync(join(dir, "recipes"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data/ingredients.json"), JSON.stringify({ rice: { name: "Rice", section: "Pantry", unit: "g" } }));
  const fm = "title: Rice\nslug: rice\nimage: /images/recipes/rice.jpg\ncourse: [Dinner]\ntotal_mins: 20\nserves: 2\ncalories: 300";
  const build = () => execFileSync("node", ["node_modules/astro/bin/astro.mjs", "build"], { cwd: dir, env: { ...process.env, BUILD_OUT_DIR: join(dir, "dist") }, stdio: "pipe" }).toString();
  writeFileSync(join(dir, "recipes/rice.md"), `---\n${fm}\ningredients:\n  - { amount: 200, unit: g, name: rice, item: rice }\n---\n\n## Instructions\n\n1. Cook the **rice**.\n`);
  assert.match(build(), /4 page\(s\) built/);
  const html = readFileSync(join(dir, "dist/recipes/rice.html"), "utf8");
  assert.match(html, /<li><span class="qty" data-qty="200">200<\/span>g <strong>rice<\/strong><\/li>/);
  assert.match(html, /class="servings-picker"/);
  writeFileSync(join(dir, "recipes/rice.md"), `---\n${fm}\ningredients:\n  - { amount: 200, unit: g, name: rice, item: basmati }\n---\n\n## Instructions\n\n1. Cook the **rice**.\n`);
  assert.throws(build, /item "basmati" isn't in data\/ingredients\.json/);
  writeFileSync(join(dir, "recipes/rice.md"), `---\n${fm}\ningredients: []\n---\n\n## Ingredients\n\n- 200g **rice**\n\n## Instructions\n\n1. Cook the **rice**.\n`);
  assert.throws(build, /remove the "## Ingredients" section/);
});

test("the write-time checks keep the sections of a line list", () => {
  const list = [{ amount: 2, name: "chicken breasts" }, { amount: 1, unit: "tbsp", name: "soy sauce", section: "Marinade" }, { amount: 2, unit: "tbsp", name: "soy sauce", section: "Sauce" }, { amount: 1, unit: "tsp", name: "honey", section: "Sauce" }];
  const split = [{ name: "a", section: "Sauce" }, { name: "b", section: "Pickle" }, { name: "c", section: "Sauce" }];
  const { ingredients, errors } = checkIngredients(list, catalogue);
  assert.deepEqual(errors, []);
  assert.deepEqual(ingredients.map((i) => i.section), [undefined, "Marinade", "Sauce", "Sauce"]);
  assert.deepEqual(Object.keys(ingredients[1]), ["amount", "unit", "name", "section", "item"]);
  assert.match(checkIngredients(split.map((i) => ({ ...i, name: "salt", note: "to taste" })), catalogue).errors.join(), /must sit together/);
});
