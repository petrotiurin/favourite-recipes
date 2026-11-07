// The tool registry, its dispatcher and the commit guards (docs/chatbot-design.md 4.1 layers 3 and 7),
// plus search_recipes and the catalogue, against a tiny fake GitHub.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";

const { TOOLS, dispatch, makeCaller, accessOf, toolDefinitions } = await import("../lib/tools.js");
const { commitChanges, ChangeSet } = await import("../lib/github.js");
const { saveStocktake } = await import("../lib/shopping-list.js");
const { createRecipe, promoteRecipe, searchRecipes, catalogue, catalogueText } = await import("../lib/recipes.js");
const { clearCache } = await import("../lib/cache.js");

const PUBLIC = makeCaller({ role: "public", ip: "203.0.113.9" });
const EDITOR = makeCaller({ role: "editor", email: "owner@example.com", userId: "u1" });
const AGENT = makeCaller({ role: "agent" });

// --- fake GitHub: recipes/*.md in a Map; counts every call so "never reached" can be asserted ----------------
const recipe = (fm, ingredients) =>
  `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`).join("\n")}\n---\n\n## Ingredients\n\n${ingredients
    .map((i) => `- 1 **${i}**`)
    .join("\n")}\n\n## Instructions\n\n1. Cook the **${ingredients[0]}** until golden.\n`;

const FILES = {
  "recipes/lemon-chicken.md": recipe({ title: "Lemon Chicken", slug: "lemon-chicken", image: "/images/recipes/lemon-chicken.jpg", course: ["Dinner"], tags: ["High Protein"], total_mins: 35, serves: 4, calories: 280, current: true }, ["chicken breasts", "lemon", "olive oil", "salt"]),
  "recipes/chicken-nut-salad.md": recipe({ title: "Chicken Nut Salad", slug: "chicken-nut-salad", image: "/images/recipes/x.jpg", course: ["Lunch"], tags: ["High Protein", "Low Carb"], total_mins: 15, serves: 2, calories: 450, draft: true, next: true }, ["Chicken thighs", "peanuts", "lettuce"]),
  "recipes/tomato-soup.md": recipe({ title: "Tomato Soup", slug: "tomato-soup", image: "/images/recipes/y.jpg", course: ["Lunch", "Dinner"], tags: [], total_mins: 25, serves: 4, calories: 150 }, ["tomatoes", "basil", "salt", "black pepper"]),
  "recipes/porridge.md": recipe({ title: "Porridge", slug: "porridge", image: "/images/recipes/z.jpg", course: ["Breakfast"], tags: ["Vegetarian"], total_mins: 10, serves: 1, calories: 220, draft: true, current: true, next: true }, ["oats", "milk"]),
};
let calls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  clearCache();
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    const path = decodeURI(new URL(url).pathname.replace("/repos/petrotiurin/favourite-recipes", ""));
    if (path === "/contents/recipes") return Response.json(Object.keys(FILES).map((k) => ({ type: "file", name: k.split("/").pop() })));
    const p = path.replace("/contents/", "");
    return FILES[p] ? new Response(FILES[p]) : Response.json({}, { status: 404 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const text = (r) => r.content.map((c) => c.text).join("\n");
const slugs = async (filters) => (await searchRecipes(filters)).map((r) => r.slug);

// --- dispatcher ------------------------------------------------------------------------------------------------

test("every registry entry declares an access level, reads are the known four plus search", () => {
  const reads = TOOLS.filter((t) => accessOf(t) === "read").map((t) => t.name).sort();
  assert.deepEqual(reads, ["get_recipe", "get_shopping_list", "get_workflow_guide", "list_recipes", "search_recipes"]);
  for (const t of TOOLS) assert.ok(["read", "stage", "write"].includes(t.access), `${t.name} has an access level`);
});

test("a public caller is refused every non-read tool, and neither the handler nor GitHub is reached", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const writers = TOOLS.filter((x) => accessOf(x) !== "read");
  assert.ok(writers.length >= 9);
  for (const tool of writers) {
    let reached = false;
    const original = tool.handler;
    tool.handler = async () => {
      reached = true;
      return { content: [] };
    };
    try {
      const res = await dispatch(tool.name, {}, PUBLIC);
      assert.equal(res.isError, true, `${tool.name} refused`);
      assert.match(text(res), /Not allowed/);
      assert.equal(reached, false, `${tool.name} handler not reached`);
    } finally {
      tool.handler = original;
    }
  }
  assert.deepEqual(calls, [], "nothing was sent to GitHub");
  assert.equal(warn.mock.callCount(), writers.length, "each refusal is logged");
  assert.match(String(warn.mock.calls[0].arguments[0]), /role=public ip=203\.0\.113\.9/);
});

test("refusals are refused even with a forged-looking caller, and no caller at all", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const caller of [undefined, null, {}, { role: "admin" }, { role: "Public" }]) {
    const res = await dispatch("create_recipe", {}, caller);
    assert.equal(res.isError, true);
    assert.match(text(res), /Not allowed/);
  }
  // an unknown role isn't a writer even for stage/write; reads need a role string too
  assert.equal((await dispatch("list_recipes", {}, {})).isError, true);
});

test("a tool without access is treated as write: denied to public, allowed to editor and agent", async (t) => {
  t.mock.method(console, "warn", () => {});
  let ran = 0;
  const tool = { name: "no_access_declared", description: "x", inputSchema: {}, handler: async () => (ran++, { content: [{ type: "text", text: "ran" }] }) };
  TOOLS.push(tool);
  try {
    assert.equal(accessOf(tool), "write");
    assert.equal((await dispatch("no_access_declared", {}, PUBLIC)).isError, true);
    assert.equal(ran, 0);
    assert.equal(text(await dispatch("no_access_declared", {}, EDITOR)), "ran");
    assert.equal(text(await dispatch("no_access_declared", {}, AGENT)), "ran");
    // a typo'd level is no better than none
    tool.access = "reed";
    assert.equal((await dispatch("no_access_declared", {}, PUBLIC)).isError, true);
    assert.deepEqual(toolDefinitions("public").map((d) => d.function.name).includes("no_access_declared"), false);
  } finally {
    TOOLS.pop();
  }
});

test("an unknown tool name is an error", async () => {
  const res = await dispatch("drop_all_recipes", {}, AGENT);
  assert.equal(res.isError, true);
  assert.match(text(res), /Unknown tool/);
});

test("dispatch validates arguments and runs reads for a public caller", async () => {
  const bad = await dispatch("search_recipes", { max_calories: "lots" }, PUBLIC);
  assert.equal(bad.isError, true);
  assert.match(text(bad), /max_calories/);
  const ok = await dispatch("search_recipes", { include_ingredients: ["chicken"] }, PUBLIC);
  assert.notEqual(ok.isError, true);
  assert.deepEqual(JSON.parse(text(ok)).map((r) => r.slug), ["lemon-chicken", "chicken-nut-salad"]);
  assert.equal(text(await dispatch("search_recipes", { text: "zzz" }, PUBLIC)), "No recipes match those filters.");
});

test("toolDefinitions: plain JSON Schema, filtered by role", () => {
  const names = (role) => toolDefinitions(role).map((d) => d.function.name);
  assert.deepEqual(names("public").sort(), ["get_recipe", "get_shopping_list", "get_workflow_guide", "list_recipes", "search_recipes"]);
  assert.equal(names("editor").length, TOOLS.length);
  assert.equal(names("agent").length, TOOLS.length);
  assert.deepEqual(names("nobody"), names("public"));
  for (const def of toolDefinitions("editor")) {
    assert.equal(def.type, "function");
    assert.ok(def.function.description);
    assert.equal(def.function.parameters.type, "object");
    assert.equal(def.function.parameters.$schema, undefined);
    assert.doesNotMatch(JSON.stringify(def), /\$ref/);
  }
  const search = toolDefinitions("public").find((d) => d.function.name === "search_recipes").function.parameters;
  assert.equal(search.properties.max_calories.type, "number");
  assert.deepEqual(search.properties.week.enum, ["this", "next", "none"]);
  assert.equal(search.required, undefined);
  const create = toolDefinitions("editor").find((d) => d.function.name === "create_recipe").function.parameters;
  assert.ok(create.required.includes("title"));
});

// --- commit guards -----------------------------------------------------------------------------------------------

test("the functions that commit throw for a public caller (or none), before touching GitHub", async (t) => {
  t.mock.method(console, "warn", () => {});
  const change = [{ path: "recipes/a.md", content: Buffer.from("x") }];
  for (const caller of [PUBLIC, undefined, {}]) {
    await assert.rejects(() => commitChanges(change, "m", caller), /Refusing to commit/);
    const cs = new ChangeSet();
    cs.write("recipes/a.md", Buffer.from("x"));
    await assert.rejects(() => cs.commit("m", caller), /Refusing to commit/);
    await assert.rejects(() => saveStocktake([], caller), /Refusing to commit/);
    await assert.rejects(() => createRecipe({}, undefined, caller), /Refusing to commit/);
    await assert.rejects(() => promoteRecipe("lemon-chicken", undefined, caller), /Refusing to commit/);
  }
  assert.deepEqual(calls, []);
});

test("commit guard lets editors and agents through to the commit itself", async () => {
  const cs = new ChangeSet();
  // an empty change set gets past the role check and stops at "Nothing to commit"
  for (const caller of [EDITOR, AGENT]) await assert.rejects(() => cs.commit("m", caller), /Nothing to commit/);
});

// --- search_recipes and the catalogue ------------------------------------------------------------------------------

test("search: ingredients match the bolded names, case-insensitively", async () => {
  assert.deepEqual(await slugs({ include_ingredients: ["CHICKEN"] }), ["lemon-chicken", "chicken-nut-salad"]);
  assert.deepEqual(await slugs({ include_ingredients: ["chicken", "lemon"] }), ["lemon-chicken"]);
  assert.deepEqual(await slugs({ include_ingredients: ["chicken"], exclude_ingredients: ["Peanuts"] }), ["lemon-chicken"]);
  assert.deepEqual(await slugs({ exclude_ingredients: ["salt"] }), ["porridge", "chicken-nut-salad"]);
  // only the bolded ingredient names count, not the surrounding text
  assert.deepEqual(await slugs({ include_ingredients: ["golden"] }), []);
});

test("search: text, course, tags, calories, minutes, draft and week", async () => {
  assert.deepEqual(await slugs({ text: "golden TOMATOES" }), ["tomato-soup"]);
  assert.deepEqual(await slugs({ text: "lemon chicken" }), ["lemon-chicken"]);
  assert.deepEqual(await slugs({ course: "Lunch" }).then((s) => s.sort()), ["chicken-nut-salad", "tomato-soup"]);
  assert.deepEqual(await slugs({ course: "Breakfast" }), ["porridge"]);
  assert.deepEqual(await slugs({ tags: ["high protein"] }).then((s) => s.sort()), ["chicken-nut-salad", "lemon-chicken"]);
  assert.deepEqual(await slugs({ tags: ["High Protein", "Low Carb"] }), ["chicken-nut-salad"]);
  assert.deepEqual(await slugs({ max_calories: 280 }).then((s) => s.sort()), ["lemon-chicken", "porridge", "tomato-soup"]);
  assert.deepEqual(await slugs({ include_ingredients: ["chicken"], max_calories: 300 }), ["lemon-chicken"]);
  assert.deepEqual(await slugs({ max_minutes: 15 }).then((s) => s.sort()), ["chicken-nut-salad", "porridge"]);
  assert.deepEqual(await slugs({ draft: true }).then((s) => s.sort()), ["chicken-nut-salad", "porridge"]);
  assert.deepEqual(await slugs({ draft: false }).then((s) => s.sort()), ["lemon-chicken", "tomato-soup"]);
  assert.deepEqual(await slugs({ week: "this" }), ["porridge", "lemon-chicken"]);
  assert.deepEqual(await slugs({ week: "next" }).then((s) => s.sort()), ["chicken-nut-salad", "porridge"]);
  assert.deepEqual(await slugs({ week: "none" }), ["tomato-soup"]);
  assert.deepEqual(await slugs({ week: "this", draft: false }), ["lemon-chicken"]);
});

test("search: compact rows, in the list_recipes order", async () => {
  const rows = await searchRecipes({});
  assert.deepEqual(rows.map((r) => r.slug), ["porridge", "lemon-chicken", "chicken-nut-salad", "tomato-soup"]);
  assert.deepEqual(rows[1], {
    slug: "lemon-chicken",
    title: "Lemon Chicken",
    course: ["Dinner"],
    tags: ["High Protein"],
    total_mins: 35,
    calories: 280,
    draft: false,
    current: true,
    next: false,
    url: "https://petrotiurin.github.io/favourite-recipes/recipes/lemon-chicken.html",
  });
});

test("the recipe index is cached for a minute and shared by search and the catalogue", async () => {
  await searchRecipes({});
  const first = calls.length;
  assert.ok(first > 0);
  await searchRecipes({ draft: true });
  const cat = await catalogue();
  assert.equal(calls.length, first, "no further GitHub reads");
  clearCache();
  await catalogue();
  assert.equal(calls.length, first * 2, "reads again once the cache is cleared");

  const soup = cat.find((r) => r.slug === "tomato-soup");
  assert.deepEqual(soup, { slug: "tomato-soup", title: "Tomato Soup", course: ["Lunch", "Dinner"], tags: [], mins: 25, kcal: 150, status: "regular", week: "none", ingredients: ["tomatoes", "basil"] });
  assert.equal(cat.find((r) => r.slug === "porridge").week, "both");
  assert.equal(cat.find((r) => r.slug === "chicken-nut-salad").status, "draft");
  assert.deepEqual(cat.find((r) => r.slug === "lemon-chicken").ingredients, ["chicken breasts", "lemon"], "pantry staples are left out");
  assert.match(catalogueText(cat), /^porridge \| Porridge \| Breakfast \| Vegetarian \| 10 min \| 220 kcal \| draft, this week \+ next week \| oats, milk$/m);
});
