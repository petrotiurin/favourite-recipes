// One request must not be able to fan out: tool calls per reply and per turn are capped, identical calls share one answer, replies have a
// max_tokens, and read tools are served from the shared cached recipe index, so even a model that asks for 25 reads at a time costs a small,
// bounded number of GitHub calls.
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";
process.env.PUBLIC_SITE_URL = "https://site.test/favourite-recipes";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_ANON_KEY = "anon-test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
process.env.EDITORS = "owner@example.com";
process.env.OPENROUTER_CHAT_PUBLIC_KEY = "or-public-test";
process.env.CHAT_PUBLIC_HOURLY_LIMIT = "1000";
process.env.CHAT_PUBLIC_TOTAL_HOURLY_LIMIT = "100000";

const { createFakeGitHub, createFakeSupabase } = await import("../scripts/fakes.js");
const github = createFakeGitHub({ clean: true });
const supabase = createFakeSupabase({ url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test" });
const realFetch = globalThis.fetch;
let ghCalls = 0;
let requests = [];
let script; // (body, n) -> events

const enc = new TextEncoder();
const sse = (events) =>
  new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const calls = (list) => [{ choices: [{ delta: { tool_calls: list.map((c, i) => ({ index: i, id: `c${requests.length}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) }, finish_reason: "tool_calls" }] }];
const say = (t) => [{ choices: [{ delta: { content: t }, finish_reason: "stop" }] }];

let chat, tools;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) { ghCalls++; return github.fetch(s, init); }
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(init.body);
      requests.push(body);
      return sse(body.tools ? script(body, requests.length) : say("done"));
    }
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  tools = await import("../lib/tools.js");
  const { clearCache } = await import("../lib/cache.js");
  clearCache();
});

const turn = async (text, ip) => {
  const res = await chat.POST(new Request("https://mcp.test/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ messages: [{ role: "user", content: text }], page: {} }) }));
  await res.text();
  return res;
};

test("a model asking for 25 reads per reply, round after round, costs a small bounded number of GitHub calls and gets capped answers", async () => {
  requests = [];
  ghCalls = 0;
  script = () => calls(Array.from({ length: 25 }, (_, i) => ({ name: i % 2 ? "list_recipes" : "get_shopping_list" })));
  const res = await turn("hi", "198.51.100.7");
  assert.equal(res.status, 200);
  const recipes = [...github.files.keys()].filter((p) => p.startsWith("recipes/")).length;
  assert.ok(ghCalls <= recipes + 8, `${ghCalls} GitHub calls for ${recipes} recipes: one cached index load (+ the list file), not one per call`);
  assert.ok(requests.length <= 8, `model calls bounded (${requests.length})`);
  const last = requests.at(-1).messages;
  const toolMsgs = last.filter((m) => m.role === "tool");
  assert.ok(toolMsgs.some((m) => /too many tool calls at once/.test(m.content)), "calls past the per-reply cap get an error result");
  assert.ok(toolMsgs.every((m, i) => m.tool_call_id), "every call still gets a result");
});

test("every model request has max_tokens (public and editor defaults)", async () => {
  requests = [];
  script = () => say("ok");
  await turn("hello", "198.51.100.8");
  assert.equal(requests[0].max_tokens, 1500);
  const { config } = await import("../lib/config.js");
  assert.equal(config.chatEditorMaxTokens, 4000);
});

test("identical calls in a turn are answered once; data calls per turn are capped; UI tools don't count", async () => {
  requests = [];
  let round = 0;
  script = () => {
    round++;
    if (round <= 6) return calls([{ name: "search_recipes", args: { text: `w${round}a` } }, { name: "search_recipes", args: { text: `w${round}b` } }, { name: "search_recipes", args: { text: `w${round}c` } }, { name: "search_recipes", args: { text: `w${round}a` } }]);
    return say("done");
  };
  await turn("go", "198.51.100.9");
  const msgs = requests.at(-1).messages.filter((m) => m.role === "tool");
  const errors = msgs.filter((m) => /too many tool calls in one turn/.test(m.content));
  assert.ok(errors.length > 0, "past 10 data calls the answers are errors");
  const thread = requests.at(-1).messages;
  const argsById = new Map(thread.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => [c.id, `${c.function.name}${c.function.arguments}`])));
  const ranDistinct = new Set(msgs.filter((m) => !/^Error:/.test(m.content)).map((m) => argsById.get(m.tool_call_id)));
  assert.ok(ranDistinct.size <= 10, `at most 10 distinct data calls ran (${ranDistinct.size})`);
});

test("a turn's total tool-result text is capped", async () => {
  requests = [];
  let round = 0;
  script = () => (++round <= 6 ? calls([{ name: "get_recipe", args: { slug: [...github.files.keys()].find((p) => p.startsWith("recipes/")).slice(8, -3) } }, { name: "list_recipes" }, { name: "get_shopping_list" }, { name: "search_recipes", args: { text: `x${round}` } }]) : say("done"));
  await turn("go", "198.51.100.10");
  const total = requests.at(-1).messages.filter((m) => m.role === "tool").reduce((n, m) => n + m.content.length, 0);
  const { MAX_RESULT_CHARS_PER_TURN } = await import("../lib/chat.js");
  assert.ok(total <= MAX_RESULT_CHARS_PER_TURN + 4 * 300, `${total} characters of tool results`);
});

test("an unexpected server error is generic for a visitor but detailed for the MCP agent", async () => {
  const realGh = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://api.github.com/") ? new Response("secret internal detail", { status: 500 }) : realGh(url, init));
  const quiet = console.error;
  console.error = () => {};
  try {
    const { clearCache } = await import("../lib/cache.js");
    clearCache();
    const pub = await tools.dispatch("get_recipe", { slug: "anything" }, tools.makeCaller({ role: "public" }));
    assert.equal(pub.isError, true);
    assert.doesNotMatch(pub.content[0].text, /GitHub|secret internal detail/);
    clearCache();
    const agent = await tools.dispatch("get_recipe", { slug: "anything" }, tools.makeCaller({ role: "agent" }));
    assert.match(agent.content[0].text, /^Server error: /);
  } finally {
    console.error = quiet;
    globalThis.fetch = realGh;
  }
});
