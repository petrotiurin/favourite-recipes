// Structured ingredients and the ingredient catalogue (docs/structured-ingredients.md sections 1, 2, 4, 5): the line renderer (the site's
// and the server's copies agree), the write-time checks, catalogue changes, and the site build's check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import * as server from "../lib/ingredient-line.js";
import { checkIngredients, applyCatalogueChange, applyCatalogueChanges, parseCatalogue, factorFor, shopAmount, resolveItem } from "../lib/catalogue.js";

const require = createRequire(import.meta.url);
const site = require("../../templates/ingredients.js");
const ROOT = new URL("../../", import.meta.url);
const book = readdirSync(new URL("recipes/", ROOT)).map((f) => ({ slug: f.slice(0, -3), ...matter(readFileSync(new URL(`recipes/${f}`, ROOT), "utf8")).data }));
const catalogue = parseCatalogue(readFileSync(new URL("data/ingredients.json", ROOT), "utf8"));

test("the site and the server render every ingredient of the book the same", () => {
  assert.deepEqual(server.UNITS, site.UNITS);
  let n = 0;
  for (const r of book) {
    for (const ing of r.ingredients) {
      assert.equal(server.ingredientMarkdown(ing), site.ingredientMarkdown(ing), `${r.slug}: ${ing.name}`);
      assert.equal(server.ingredientHtml(ing), site.ingredientHtml(ing), `${r.slug}: ${ing.name}`);
      assert.equal(server.ingredientText(ing), site.ingredientText(ing));
      n++;
    }
  }
  assert.ok(n > 500, "the whole book was compared");
});

test("lines render the fixed way per unit", () => {
  const md = server.ingredientMarkdown;
  assert.equal(md({ amount: 200, unit: "g", name: "jasmine rice" }), "200g **jasmine rice**");
  assert.equal(md({ amount: 4, name: "salmon fillets", note: "about 140g each" }), "4 **salmon fillets**, about 140g each");
  assert.equal(md({ amount: [2, 3], unit: "tbsp", name: "red curry paste" }), "2–3 tbsp **red curry paste**");
  assert.equal(md({ amount: 0.75, unit: "can", name: "coconut milk" }), "¾ can **coconut milk**");
  assert.equal(md({ amount: 2, unit: "clove", name: "garlic", note: "minced" }), "2 cloves **garlic**, minced");
  assert.equal(md({ amount: 1, unit: "juice", name: "lime" }), "Juice of 1 **lime**");
  assert.equal(md({ amount: 0.5, unit: "zest", name: "lemon" }), "Zest of ½ **lemon**");
  assert.equal(md({ amount: 1, unit: "pinch", name: "salt" }), "Pinch of **salt**");
  assert.equal(md({ amount: 2, unit: "handful", name: "spinach" }), "2 handfuls of **spinach**");
  assert.equal(md({ amount: 0.33, unit: "cup", name: "oats" }), "⅓ cup **oats**");
  assert.equal(md({ amount: 1, unit: "sheet", name: "puff pastry" }), "1 sheet **puff pastry**");
  assert.equal(md({ amount: 2, unit: "stick", name: "celery" }), "2 sticks **celery**");
  assert.equal(md({ amount: 1, unit: "head", name: "broccoli" }), "1 head **broccoli**");
  assert.equal(md({ amount: 37.5, unit: "g", name: "sugar" }), "37.5g **sugar**");
  assert.equal(md({ name: "sesame seeds", note: "to serve", optional: true }), "**sesame seeds**, to serve, optional");
  assert.equal(md({ amount: 500, unit: "g", name: "Greek yogurt", note: "(0% or full-fat)" }), "500g **Greek yogurt** (0% or full-fat)");
  // the page tags every number for the servings selector, and the unit word for its plural
  assert.equal(server.ingredientHtml({ amount: 1, unit: "clove", name: "garlic" }), '<span class="qty" data-qty="1">1</span> <span class="qty-unit" data-one="clove" data-many="cloves">clove</span> <strong>garlic</strong>');
  assert.equal(server.ingredientHtml({ amount: 2, name: "<b>" }, { scalable: false }), "2 <strong>&lt;b&gt;</strong>");
});

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
  for (const p of ["build.js", "package.json", "templates", "styles"]) cpSync(new URL(p, ROOT), join(dir, p), { recursive: true });
  cpSync(new URL("node_modules", ROOT), join(dir, "node_modules"), { recursive: true, dereference: false });
  mkdirSync(join(dir, "recipes"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data/ingredients.json"), JSON.stringify({ rice: { name: "Rice", section: "Pantry", unit: "g" } }));
  const fm = "title: Rice\nslug: rice\nimage: /images/recipes/rice.jpg\ncourse: [Dinner]\ntotal_mins: 20\nserves: 2\ncalories: 300";
  const build = () => execFileSync("node", ["build.js"], { cwd: dir, env: { ...process.env, BUILD_OUT_DIR: join(dir, "dist") }, stdio: "pipe" }).toString();
  writeFileSync(join(dir, "recipes/rice.md"), `---\n${fm}\ningredients:\n  - { amount: 200, unit: g, name: rice, item: rice }\n---\n\n## Instructions\n\n1. Cook the **rice**.\n`);
  assert.match(build(), /Built 1 recipe/);
  const html = readFileSync(join(dir, "dist/recipes/rice.html"), "utf8");
  assert.match(html, /<li><span class="qty" data-qty="200">200<\/span>g <strong>rice<\/strong><\/li>/);
  assert.match(html, /class="servings-picker"/);
  writeFileSync(join(dir, "recipes/rice.md"), `---\n${fm}\ningredients:\n  - { amount: 200, unit: g, name: rice, item: basmati }\n---\n\n## Instructions\n\n1. Cook the **rice**.\n`);
  assert.throws(build, /item "basmati" isn't in data\/ingredients\.json/);
  writeFileSync(join(dir, "recipes/rice.md"), `---\n${fm}\ningredients: []\n---\n\n## Ingredients\n\n- 200g **rice**\n\n## Instructions\n\n1. Cook the **rice**.\n`);
  assert.throws(build, /remove the "## Ingredients" section/);
});
