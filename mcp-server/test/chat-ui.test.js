// The chat's UI tools: show_recipes, offer_navigation and action chips. Cards and URLs come from our data, never from model text,
// and only ever point at the site's own origin.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";
process.env.PUBLIC_SITE_URL = "https://site.test/favourite-recipes";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_ANON_KEY = "anon-test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
process.env.EDITORS = "owner@example.com";
process.env.OPENROUTER_CHAT_PUBLIC_KEY = "or-public-test";
process.env.CHAT_PUBLIC_MODEL = "test/model";
process.env.CHAT_PUBLIC_HOURLY_LIMIT = "1000";
process.env.CHAT_PUBLIC_DAILY_LIMIT = "1000";

const { createFakeGitHub, createFakeSupabase } = await import("../scripts/fakes.js");
const github = createFakeGitHub({ clean: true });
// A known book: avocado-toast is in this week, steamed-rice is a draft in next week, the rest are plain.
const flag = (slug, line) => {
  const path = `recipes/${slug}.md`;
  github.files.set(path, Buffer.from(github.files.get(path).toString().replace(/^---\n([\s\S]*?)\n---/, (_, fm) => `---\n${fm}\n${line}\n---`)));
};
flag("avocado-toast", "current: true");
const draftSlug = [...github.files.keys()].find((k) => k.startsWith("recipes/") && k !== "recipes/avocado-toast.md" && k.endsWith(".md")).slice(8, -3);
flag(draftSlug, "draft: true\nnext: true");

let scripted; // the model's turns: array of { text?, calls? }
const sse = (events) => new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode(`data: ${e === "[DONE]" ? e : JSON.stringify(e)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const modelTurn = ({ text = "", calls = [] }) => {
  const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const ev = [chunk({ role: "assistant", content: text })];
  calls.forEach((c, index) => ev.push(chunk({ tool_calls: [{ index, id: `c${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }] })));
  ev.push(chunk({}, calls.length ? "tool_calls" : "stop"), "[DONE]");
  return sse(ev);
};
const toolResults = [];
const realFetch = globalThis.fetch;
let supabase;
let chat, chatLib, ui;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(init.body);
      toolResults.push(body.messages.filter((m) => m.role === "tool").map((m) => m.content));
      return modelTurn(scripted.shift() || {});
    }
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  chatLib = await import("../lib/chat.js");
  ui = await import("../lib/chat-ui.js");
  (await import("../lib/cache.js")).clearCache();
});
beforeEach(() => {
  supabase = createFakeSupabase({ url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test" });
  toolResults.length = 0;
});

let n = 0;
async function turn(turns, content = "hi") {
  scripted = turns;
  const res = await chat.POST(new Request("https://mcp.test/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}` }, body: JSON.stringify({ messages: [{ role: "user", content }] }) }));
  const out = [];
  for (const block of (await res.text()).split("\n\n").filter(Boolean)) out.push({ name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
  return out;
}
const SITE = "https://site.test/favourite-recipes";

test("show_recipes: cards are built from the repo, unknown slugs are dropped", async () => {
  const evs = await turn([
    { calls: [{ name: "show_recipes", arguments: { slugs: ["avocado-toast", "no-such-recipe", draftSlug, "avocado-toast", "../../etc/passwd", "https://evil.test/x"], reason: "mock" } }] },
    { text: "Enjoy." },
  ]);
  const cards = evs.find((e) => e.name === "cards").data.cards;
  assert.deepEqual(cards.map((c) => c.slug), ["avocado-toast", draftSlug]);
  const toast = cards[0];
  assert.equal(toast.title, "Avocado Toast");
  assert.equal(toast.url, `${SITE}/recipes/avocado-toast.html`);
  assert.equal(toast.image, `${SITE}/images/recipes/avocado-toast.jpg`);
  assert.deepEqual(toast.kicker, { kind: "this", label: "This week" });
  assert.match(toast.meta, /^\d+ min · \d+ kcal$/);
  assert.deepEqual(cards[1].kicker, { kind: "next", label: "Next week" }, "week wins over draft");
  const result = JSON.parse(toolResults.at(-1).at(-1));
  assert.equal(result.shown, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.ignored_unknown_slugs, ["no-such-recipe", "../../etc/passwd", "https://evil.test/x"]);
});

test("show_recipes: a draft that is in no week is marked as a draft; when nothing is known nothing is sent", async () => {
  const book = await ui.loadBook();
  assert.deepEqual(ui.cardFor({ ...book.get("avocado-toast"), current: false, next: false, draft: true }).kicker, { kind: "draft", label: "Draft" });
  assert.deepEqual(ui.cardFor({ ...book.get("avocado-toast"), current: false, next: false, draft: false }).kicker.kind, "");
  const evs = await turn([{ calls: [{ name: "show_recipes", arguments: { slugs: ["nope"] } }] }, { text: "Sorry, nothing." }]);
  assert.ok(!evs.some((e) => e.name === "cards"));
  assert.equal(JSON.parse(toolResults.at(-1).at(-1)).shown, false);
});

test("offer_navigation: a recipe or a site page resolves to a site URL; anything else is refused", async () => {
  let evs = await turn([{ text: "That one.", calls: [{ name: "offer_navigation", arguments: { slug: "avocado-toast", label: "Open Avocado Toast" } }] }, { text: "" }]);
  assert.deepEqual(evs.find((e) => e.name === "navigation").data, { label: "Open Avocado Toast", url: `${SITE}/recipes/avocado-toast.html` });
  evs = await turn([{ calls: [{ name: "offer_navigation", arguments: { page: "shopping", label: "" } }] }, {}]);
  assert.deepEqual(evs.find((e) => e.name === "navigation").data, { label: "Open the shopping list", url: `${SITE}/shopping-list.html` });
  for (const bad of [{ slug: "nope", label: "x" }, { slug: "https://evil.test/", label: "x" }, { slug: "javascript:alert(1)", label: "x" }, { page: "https://evil.test", label: "x" }, { label: "x" }]) {
    evs = await turn([{ calls: [{ name: "offer_navigation", arguments: bad }] }, {}]);
    assert.ok(!evs.some((e) => e.name === "navigation"), JSON.stringify(bad));
    assert.match(toolResults.at(-1).at(-1), /shown|Invalid/);
  }
  // one button per answer
  evs = await turn([{ calls: [{ name: "offer_navigation", arguments: { page: "index", label: "A" } }, { name: "offer_navigation", arguments: { page: "next-week", label: "B" } }] }, {}]);
  assert.equal(evs.filter((e) => e.name === "navigation").length, 1);
});

test("the label of a navigation button is tidied and never carries a URL's power", async () => {
  const evs = await turn([{ calls: [{ name: "offer_navigation", arguments: { slug: "avocado-toast", label: "🍞 Open <b>it</b> now\nplease " + "x".repeat(80) } }] }, {}]);
  const { label, url } = evs.find((e) => e.name === "navigation").data;
  assert.ok(label.length <= 40 && !/[\n🍞]/u.test(label));
  assert.equal(url, `${SITE}/recipes/avocado-toast.html`);
});

test("action chips resolve to site URLs; unknown slugs, URLs and schemes drop the chip", async () => {
  const book = await ui.loadBook();
  const out = chatLib.cleanReplies(
    {
      replies: [
        "Plain one",
        { label: "Open toast", action: { navigate: "avocado-toast" } },
        { label: "Next week", action: { navigate: "next-week" } },
        { label: "Evil", action: { navigate: "https://evil.test/" } },
        { label: "Script", action: { navigate: "javascript:alert(1)" } },
        { label: "Ghost", action: { navigate: "no-such-recipe" } },
        { label: "No action" },
        { label: "Shop", action: { navigate: "shopping" } },
      ],
    },
    book
  );
  assert.deepEqual(out, ["Plain one", { label: "Open toast", url: `${SITE}/recipes/avocado-toast.html` }, { label: "Next week", url: `${SITE}/next-week.html` }, { label: "Shop", url: `${SITE}/shopping-list.html` }]);
  assert.ok(out.every((r) => typeof r === "string" || new URL(r.url).origin === "https://site.test"));
  // without a book only plain replies survive
  assert.deepEqual(chatLib.cleanReplies({ replies: ["a", { label: "b", action: { navigate: "index" } }] }), ["a"]);
});

test("the SSE stream carries suggestions with action chips, cards and navigation in one turn", async () => {
  const evs = await turn([
    { text: "Here.", calls: [{ name: "show_recipes", arguments: { slugs: ["avocado-toast"] } }, { name: "offer_navigation", arguments: { slug: "avocado-toast", label: "Open Avocado Toast" } }, { name: "suggest_replies", arguments: { replies: ["More", { label: "Open it", action: { navigate: "avocado-toast" } }] } }] },
    {},
  ]);
  const names = evs.map((e) => e.name);
  for (const name of ["cards", "navigation", "suggestions"]) assert.ok(names.includes(name), name);
  assert.equal(names.at(-1), "done");
  assert.deepEqual(evs.find((e) => e.name === "suggestions").data.replies[1], { label: "Open it", url: `${SITE}/recipes/avocado-toast.html` });
});

test("the siteUrl helper stays on the site's origin", () => {
  assert.equal(ui.siteUrl(), `${SITE}/`);
  assert.equal(ui.siteUrl("next-week.html"), `${SITE}/next-week.html`);
  assert.equal(new URL(ui.siteUrl("//evil.test/x")).origin, "https://site.test", "a path can never change the host");
});
