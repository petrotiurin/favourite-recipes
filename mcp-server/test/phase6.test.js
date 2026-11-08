// Phase 6 extras: cooking help (scale_recipe), what can I make from what's at home, stocktake by chat, week balance.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { clearCache } from "../lib/cache.js";

Object.assign(process.env, {
  GITHUB_TOKEN: "gh-test", MCP_AUTH_TOKEN: "secret", PUBLIC_SITE_URL: "https://site.test/favourite-recipes", SUPABASE_URL: "https://sb.test",
  SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", EDITORS: "owner@example.com", OPENROUTER_CHAT_PUBLIC_KEY: "or-public-test",
  OPENROUTER_CHAT_EDITOR_KEY: "or-editor-test", OPENROUTER_API_KEY: "or-image-test", CHAT_PUBLIC_HOURLY_LIMIT: "100000", CHAT_EDITOR_HOURLY_LIMIT: "100000",
  CHAT_EDITOR_DAILY_LIMIT: "100000", CHAT_PUBLIC_TOTAL_HOURLY_LIMIT: "100000",
});
const { createFakeGitHub, createMockOpenRouter, createFakeSupabase, createFakeImageApi } = await import("../scripts/fakes.js");
let github, openrouter, supabase, images;
const realFetch = globalThis.fetch;
let chat, tools, scaling, background, config, photos;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") return openrouter.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/images") return images.fetch(s, init);
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  tools = await import("../lib/tools.js");
  scaling = await import("../lib/scaling.js");
  background = await import("../lib/background.js");
  photos = await import("../lib/tray-photos.js");
  ({ config } = await import("../lib/config.js"));
});
const OWNER = "00000000-0000-4000-8000-0000000000e1";
const editor = () => tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER });
beforeEach(() => {
  clearCache();
  github = createFakeGitHub({ clean: true });
  openrouter = createMockOpenRouter({ delayMs: 0 });
  images = createFakeImageApi();
  supabase = createFakeSupabase({ url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test", users: { "owner-token": { id: OWNER, email: "owner@example.com" } } });
  config.shoppingEditors = ["owner@example.com"];
  config.supabaseServiceKey = "service-test";
  photos.deps.lookup = async () => [{ address: "93.184.216.34" }];
});
let ip = 0;
const post = (body, token) => chat.POST(new Request("https://mcp.test/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
async function events(res) {
  const out = [];
  for (const block of (await res.text()).split("\n\n").filter(Boolean)) out.push({ name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
  return out;
}
const textOf = (evs) => evs.filter((e) => e.name === "text").map((e) => e.data.delta).join("");
const slugs = () => [...github.files.keys()].filter((p) => p.startsWith("recipes/")).map((p) => p.slice(8, -3)).sort();

// --- 1. cooking help --------------------------------------------------------------------------------------------------------

test("scaling uses the same numbers and rounding as the recipe page", () => {
  const require = createRequire(import.meta.url);
  const { markQuantityText, markScalableQuantities } = require("../../templates/quantities.js");
  const lines = ["- 150g **Greek yogurt**, diced", "- 2 x 150g **chicken breasts**", "- ½ **lemon** (0% or full-fat)", "- 1–2 tsp **paprika**", "- 3 **eggs (about 50g each)**", "- 2 **peppers (about 100g each)**, sliced", "- ¼ tsp **salt**", "- Juice of 2 **limes**", "- 100ml + 3 tbsp **milk**"];
  for (const line of lines) {
    const html = markScalableQuantities(`<h2>Ingredients</h2><ul><li>${line.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li></ul>`).html;
    const site = [...html.matchAll(/data-qty="([^"]+)"/g)].map((m) => parseFloat(m[1]));
    assert.deepEqual(scaling.scalableNumbers(line), site, line);
  }
  assert.equal(scaling.scaleLine("- 150g **Greek yogurt**, diced", 1.5), "- 225g **Greek yogurt**, diced");
  assert.equal(scaling.scaleLine("- ½ **lemon**", 3), "- 1½ **lemon**");
  assert.equal(scaling.scaleLine("- 2 x 150g **chicken**", 2), "- 4 x 150g **chicken**");
  assert.equal(scaling.scaleLine("- 1 **onion**", 1), "- 1 **onion**");
  assert.equal(scaling.formatQuantity(0.1), "⅛");
  assert.equal(scaling.formatQuantity(12.4), "12");
  assert.equal(scaling.formatQuantity(2.66), "2⅔");
  void markQuantityText;
});

test("scale_recipe is a read tool for everyone, scales to N, and refuses to multiply a non-scalable list", async () => {
  const slug = slugs()[0];
  const { data } = await (await import("../lib/recipes.js")).getRecipe(slug);
  const res = await tools.dispatch("scale_recipe", { slug, servings: 6 }, tools.makeCaller({ role: "public" }));
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, new RegExp(`serves ${data.serves} as written, scaled to 6`));
  assert.ok(res.content[0].text.split("\n").filter((l) => l.startsWith("- ")).length > 2);
  assert.equal((await tools.dispatch("scale_recipe", { slug, servings: 0 }, editor())).isError, true);
  assert.equal((await tools.dispatch("scale_recipe", { slug: "nope-nope", servings: 2 }, editor())).isError, true);
});

test("cooking help on a recipe page: swap, scale and 'what's step 2' read the recipe first", async () => {
  const slug = slugs()[0];
  const ask = async (content) => {
    openrouter.requests.length = 0;
    const res = await post({ messages: [{ role: "user", content }], page: { page: "recipe", slug, servings: 4 } });
    return { evs: await events(res), calls: openrouter.requests.map((r) => r.messages.findLast((m) => m.role === "tool")?.content).filter(Boolean) };
  };
  let r = await ask("scale it for 6");
  assert.match(r.calls[0], /scaled to 6/);
  assert.match(textOf(r.evs), /For 6 people/);
  r = await ask("what's step 2");
  assert.match(r.calls[0], /## Instructions/, "get_recipe was read");
  assert.match(textOf(r.evs), /Step 2: /);
  r = await ask("swap the crème fraîche");
  assert.match(r.calls[0], /^---/m);
  assert.match(textOf(r.evs), /swap/);
  assert.match(openrouter.requests[0].messages.at(-1).content, /4 servings selected/);
  assert.match(openrouter.requests[0].messages[0].content, /Cooking help/);
});

// --- 2. what's at home ------------------------------------------------------------------------------------------------------

const putStocktake = async (haveNames, extra = []) => {
  const list = { updated: "2026-11-01", recipes: [], servings: {}, stocktake: "2026-11-02T10:00:00.000Z", sections: [{ name: "Everything", items: [...haveNames.map((name) => ({ name, quantity: "1", have: true, recipes: [] })), ...extra] }] };
  github.files.set("shopping-list.json", Buffer.from(JSON.stringify(list)));
  clearCache();
};

test("ingredient matching: same words or whole-word containment, plurals folded, nothing looser", async () => {
  const { sameIngredient } = await import("../lib/at-home.js");
  assert.ok(sameIngredient("Eggs", "egg"));
  assert.ok(sameIngredient("cherry tomatoes", "Tomatoes"));
  assert.ok(sameIngredient("Basmati rice", "rice"));
  assert.ok(!sameIngredient("rice", "licorice"), "whole words only");
  assert.ok(!sameIngredient("pea", "peanut butter"));
  assert.ok(!sameIngredient("", "rice"));
});

test("recipes_from_home ranks the book by what the stocktake says is at home, and says so when there is no stocktake", async () => {
  github.files.set("shopping-list.json", Buffer.from(JSON.stringify({ updated: "2026-11-01", recipes: [], servings: {}, sections: [{ name: "x", items: [{ name: "Milk", quantity: "1", recipes: [] }] }] })));
  clearCache();
  const none = await tools.dispatch("recipes_from_home", {}, tools.makeCaller({ role: "public" }));
  assert.match(none.content[0].text, /No stocktake is saved/);
  const { recipeIngredients } = await import("../lib/recipes.js");
  const { STAPLES } = await import("../lib/recipes.js");
  const book = await recipeIngredients();
  const target = book.find((r) => r.ingredients.filter((n) => !STAPLES.test(n)).length >= 3);
  const names = [...new Set(target.ingredients.filter((n) => !STAPLES.test(n)).map((n) => n.toLowerCase()))];
  await putStocktake(names);
  const out = await tools.dispatch("recipes_from_home", { limit: 5 }, tools.makeCaller({ role: "public" }));
  const rows = out.content[0].text.split("\n").filter((l) => / \| \d+\/\d+ \| /.test(l));
  assert.ok(rows.length >= 1 && rows.length <= 5);
  assert.match(rows[0], new RegExp(`^${target.slug} \\| .* \\| ${names.length}/${names.length} \\| nothing$`) , "a recipe with everything at home comes first with nothing missing");
  // partly at home counts; an item marked 0 or not at home doesn't
  await putStocktake([names[0]], [{ name: names[1], quantity: "4", have: 0, recipes: [] }]);
  const part = (await tools.dispatch("recipes_from_home", { limit: 12 }, editor())).content[0].text;
  assert.match(part, new RegExp(`At home \\(stocktake .*\\): ${names[0].replace(/[()]/g, ".")}\\.`, "i"));
  // no stocktake at all vs. a stocktake with nothing at home
  github.files.set("shopping-list.json", Buffer.from(JSON.stringify({ updated: "2026-11-01", recipes: [], servings: {}, stocktake: "2026-11-02T10:00:00.000Z", sections: [{ name: "x", items: [{ name: "Milk", quantity: "1", recipes: [] }] }] })));
  clearCache();
  assert.match((await tools.dispatch("recipes_from_home", {}, editor())).content[0].text, /nothing marked as at home/);
});

test("the shopping page's starter and the chat flow: ask what can be made, get cards", async () => {
  const { recipeIngredients, STAPLES } = await import("../lib/recipes.js");
  const target = (await recipeIngredients()).find((r) => r.ingredients.filter((n) => !STAPLES.test(n)).length >= 3);
  await putStocktake(target.ingredients.filter((n) => !STAPLES.test(n)));
  const res = await post({ messages: [{ role: "user", content: "What can I make from what's at home?" }], page: { page: "shopping" } });
  const evs = await events(res);
  assert.ok(evs.some((e) => e.name === "cards" && e.data.cards.some((c) => c.slug === target.slug)));
  assert.ok(openrouter.requests[0].tools.some((t) => t.function.name === "recipes_from_home"));
});

// --- 3. stocktake by chat -----------------------------------------------------------------------------------------------------

const STOCK_LIST = { updated: "2026-11-01", recipes: [], servings: {}, sections: [{ name: "Pantry", items: [{ name: "Eggs", quantity: "12", recipes: [] }, { name: "Basmati rice", quantity: "500g", recipes: [] }, { name: "Parsley", recipes: [] }] }] };
const putList = (list) => { github.files.set("shopping-list.json", Buffer.from(JSON.stringify(list))); clearCache(); };
const say = async (message, conversation_id) => {
  const res = await post({ message, conversation_id, page: { page: "shopping" } }, "owner-token");
  assert.equal(res.status, 200);
  const evs = await events(res);
  await background.backgroundIdle();
  return { evs, conversation_id: evs.find((e) => e.name === "meta")?.data.conversation_id };
};
const planGet = async () => (await (await chat.GET(new Request("https://mcp.test/api/chat?route=plan", { headers: { authorization: "Bearer owner-token", "x-forwarded-for": "198.51.100.77" } }))).json()).tray;
const apply = (body) => chat.POST(new Request("https://mcp.test/api/chat?route=plan/apply", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner-token", "x-forwarded-for": "198.51.100.78" }, body: JSON.stringify(body) }));

test("stocktake by chat: 'we've got 6 eggs and plenty of rice' becomes one At home card that Save now commits with the page's validation", async () => {
  putList(STOCK_LIST);
  await say("we've got 6 eggs and plenty of rice");
  let t = await planGet();
  assert.equal(t.count, 1);
  const card = t.items[0];
  assert.equal(card.kind, "stocktake");
  assert.equal(card.title, "At home: 2 items");
  assert.deepEqual(card.preview[0].items, ["Eggs: 6", "Basmati rice: enough"]);
  assert.equal(card.error, null);
  assert.equal(t.needs_list, false, "it doesn't change next week");
  assert.equal(t.can_save, true);
  assert.equal(card.save_now, true);
  assert.equal(github.commitLog.length, 0, "staging commits nothing");
  const res = await apply({ item_id: card.id });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(github.commitLog.length, 1);
  assert.deepEqual(github.commitLog[0].paths, ["shopping-list.json"]);
  const saved = JSON.parse(github.files.get("shopping-list.json").toString());
  assert.ok(saved.stocktake);
  const by = Object.fromEntries(saved.sections[0].items.map((i) => [i.name, i.have]));
  assert.deepEqual(by, { Eggs: 6, "Basmati rice": true, Parsley: undefined });
  assert.equal((await planGet())?.count ?? 0, 0, "the card is gone after Save");
});

test("a second 'we've got' merges into the same card; items not on the list are said so and nothing is staged for them", async () => {
  putList(STOCK_LIST);
  const { conversation_id } = await say("we've got 6 eggs");
  await say("we have plenty of parsley", conversation_id);
  const t = await planGet();
  assert.equal(t.count, 1);
  assert.equal(t.items[0].preview[0].items.length, 2);
  const none = await say("we've got caviar", conversation_id);
  assert.match(textOf(none.evs), /None of that is on the shopping list/);
  assert.equal((await planGet()).count, 1);
});

test("the stocktake rules of the shopping page apply: an amount on an item with no amount, or a list that changed since, is refused", async () => {
  putList(STOCK_LIST);
  const r = await tools.dispatch("stage_stocktake", { items: [{ name: "Parsley", have: 3 }] }, editor(), { chat: { emit() {} } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /can only be marked as at home/);
  assert.equal(await planGet(), null, "nothing was staged");
  // unknown names are refused with the list's names for the model
  const bad = await tools.dispatch("stage_stocktake", { items: [{ name: "Caviar", have: true }] }, editor(), { chat: { emit() {} } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Not on the shopping list: "Caviar"\. The list's items are: Eggs, Basmati rice, Parsley/);
  // the list changes on the site after staging: Save refuses (nothing committed) and the card says why
  const ok1 = await tools.dispatch("stage_stocktake", { items: [{ name: "Eggs", have: 6 }, { name: "Parsley", have: true }] }, editor(), { chat: { emit() {} } });
  assert.doesNotMatch(ok1.content[0].text, /PROBLEM/);
  putList({ ...STOCK_LIST, sections: [{ name: "Pantry", items: [{ name: "Eggs", quantity: "6", recipes: [] }] }] });
  const saved = await apply({});
  assert.equal(saved.status, 409);
  assert.match((await saved.json()).error, /shopping list changed/);
  assert.equal(github.commitLog.length, 0);
});

test("stage_stocktake is a stage tool: refused for the public and for the agent role's /mcp surface", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const res = await tools.dispatch("stage_stocktake", { items: [{ name: "Eggs", have: true }] }, tools.makeCaller({ role: "public" }), { chat: { emit() {} } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Not allowed/);
  } finally { console.warn = warn; }
  assert.equal(tools.accessOf(tools.TOOLS.find((t) => t.name === "stage_stocktake")), "stage");
});

// --- 4. week balance ------------------------------------------------------------------------------------------------------------

test("weekBalance: recipes, dinners, average kcal and total time, from recipe data", async () => {
  const { weekBalance } = await import("../lib/tray.js");
  assert.equal(weekBalance([]), null);
  assert.deepEqual(weekBalance([{ course: ["Dinner"], calories: 500, total_mins: 30 }, { course: ["Lunch", "Dinner"], calories: 301, total_mins: 45 }, { course: ["Snack"], calories: 100, total_mins: 5 }]), { recipes: 3, dinners: 2, avg_kcal: 300, total_mins: 80 });
  assert.deepEqual(weekBalance([{ course: [], total_mins: 10 }]), { recipes: 1, dinners: 0, avg_kcal: null, total_mins: 10 });
});

test("the tray reports next week as it will be after Save (staged recipes included), computed on the server", async () => {
  const slug = slugs().find((s) => s);
  await tools.dispatch("stage_set_week_recipes", { slugs: [slug], add: true }, editor(), { chat: { emit() {} } });
  await say("add a new recipe: balance pasta");
  const t = await planGet();
  assert.equal(t.balance.recipes, 2);
  assert.ok(t.balance.avg_kcal > 0 && t.balance.total_mins >= 20);
  assert.ok(t.balance.dinners >= 1, "the staged pasta is a dinner");
  const chatJs = createRequire(import.meta.url)("../../templates/chat.js");
  assert.match(chatJs.balanceLine({ recipes: 5, dinners: 3, avg_kcal: 420, total_mins: 135 }), /^Next week after Save: 5 recipes · 3 dinners · ~420 kcal each · 2 h 15 min in all$/);
  assert.equal(chatJs.balanceLine(null), "");
  assert.equal(chatJs.cleanTray({ items: [], balance: { recipes: "5", dinners: -1, avg_kcal: 1e9, total_mins: 12 } }, "https://x", "").balance.recipes, 0, "non-numbers are dropped");
});
