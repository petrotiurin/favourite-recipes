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
