// The agent loop's guards: no repeated text within a turn, thinking never shown, a turn never ends in silence, provider errors made friendly.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, { GITHUB_TOKEN: "gh-test", MCP_AUTH_TOKEN: "secret", PUBLIC_SITE_URL: "https://site.test/favourite-recipes", SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", EDITORS: "owner@example.com", OPENROUTER_CHAT_PUBLIC_KEY: "or-public-test", CHAT_PUBLIC_MODEL: "test/model", CHAT_PUBLIC_HOURLY_LIMIT: "1000", CHAT_PUBLIC_DAILY_LIMIT: "1000", CHAT_PUBLIC_TOTAL_HOURLY_LIMIT: "100000" });
const { createFakeGitHub, createFakeSupabase } = await import("../scripts/fakes.js");
const github = createFakeGitHub({ clean: true });
let scripted;
let requests;
let failWith;
const sse = (events) => new Response(new ReadableStream({ start(c) { const enc = new TextEncoder(); for (const e of events) c.enqueue(enc.encode(`data: ${e === "[DONE]" ? e : JSON.stringify(e)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
const modelTurn = ({ text = "", chunks, reasoning, calls = [] }) => {
  const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const ev = [];
  if (reasoning) ev.push(chunk({ role: "assistant", content: "", reasoning }), chunk({ reasoning_content: reasoning }));
  for (const c of chunks || [text]) ev.push(chunk({ content: c }));
  calls.forEach((c, index) => ev.push(chunk({ tool_calls: [{ index, id: `c${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }] })));
  ev.push(chunk({}, calls.length ? "tool_calls" : "stop"), "[DONE]");
  return sse(ev);
};
const realFetch = globalThis.fetch;
let supabase, chat;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") {
      requests.push(JSON.parse(init.body));
      if (failWith) return new Response(failWith.body, { status: failWith.status });
      return modelTurn(scripted.shift() || {});
    }
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
});
beforeEach(() => {
  supabase = createFakeSupabase({ url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test" });
  requests = [];
  failWith = null;
});
let n = 0;
async function turn(turns, content = "hi") {
  scripted = turns;
  const res = await chat.POST(new Request("https://mcp.test/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n % 250}` }, body: JSON.stringify({ messages: [{ role: "user", content }] }) }));
  const out = [];
  for (const block of (await res.text()).split("\n\n").filter(Boolean)) out.push({ name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
  return out;
}
const textOf = (evs) => evs.filter((e) => e.name === "text").map((e) => e.data.delta).join("");
const REPLIES = { name: "suggest_replies", arguments: { replies: ["Quick ones", "Light ones"] } };

test("text plus UI-only tool calls ends the turn: the model isn't called again", async () => {
  const evs = await turn([{ text: "Here you go.", calls: [REPLIES] }, { text: "Here you go. (said again)" }]);
  assert.equal(requests.length, 1);
  assert.equal(textOf(evs), "Here you go.");
  assert.ok(evs.some((e) => e.name === "suggestions"));
  assert.equal(evs.at(-1).name, "done");
});

test("text plus a data tool: the follow-up is told what was already said, and a repeat of it is swallowed", async () => {
  const said = "Hello there, I'm the cooking helper and I will look through the book for you now.";
  const evs = await turn([
    { text: said, calls: [{ name: "search_recipes", arguments: { text: "soup" } }] },
    { text: `${said} Found three soups.`, calls: [{ name: "search_recipes", arguments: { text: "stew" } }] },
    { text: "Three soups and a stew are in the book.", calls: [REPLIES] },
  ], "soup or stew?");
  const text = textOf(evs);
  assert.equal(text.split("cooking helper").length, 2, `the greeting appears once: ${JSON.stringify(text)}`);
  assert.match(text, /Three soups and a stew are in the book\./);
  const lastTool = requests[1].messages.at(-1);
  assert.equal(lastTool.role, "tool");
  assert.match(lastTool.content, /you already told the user: "Hello there/);
  assert.match(lastTool.content, /don't repeat it/);
});

test("a greeting restated in every round is shown once", async () => {
  const greet = "Hi! Happy to help with dinner ideas.";
  const evs = await turn([
    { text: greet, calls: [{ name: "search_recipes", arguments: { text: "a" } }] },
    { text: greet, calls: [{ name: "search_recipes", arguments: { text: "b" } }] },
    { text: greet, calls: [{ name: "search_recipes", arguments: { text: "c" } }] },
    { text: "Here are some ideas.", calls: [REPLIES] },
  ]);
  const text = textOf(evs);
  assert.equal(text.split("Happy to help").length, 2);
  assert.match(text, /Here are some ideas/);
});

test("short, different follow-ups still stream; reasoning fields and <think> spans are never shown", async () => {
  const evs = await turn([
    { reasoning: "(no emoji though, just hello!)", chunks: ["<thi", "nk>secret plan", " here</think>Look", "ing now."], calls: [{ name: "search_recipes", arguments: { text: "x" } }] },
    { text: "Done.", calls: [REPLIES] },
  ]);
  assert.equal(textOf(evs), "Looking now.\n\nDone.");
  assert.ok(!JSON.stringify(evs).includes("secret plan") && !JSON.stringify(evs).includes("no emoji"));
});

test("a turn with no text and nothing shown ends with a short message, never silence", async () => {
  const evs = await turn([{}]);
  assert.match(textOf(evs), /didn't manage to answer/);
  assert.equal(evs.at(-1).name, "done");
  // UI alone is an answer
  const cards = await turn([{ calls: [{ name: "show_recipes", arguments: { slugs: ["nope"] } }] }, {}]);
  assert.ok(cards.some((e) => e.name === "text"), "nothing shown (unknown slug) still gets the line");
});

test("provider errors: out of credit, a text-only model asked to read a photo, anything else", async () => {
  const { friendlyOpenRouterError } = await import("../lib/chat.js");
  assert.equal(friendlyOpenRouterError(400, '{"error":{"message":"No endpoints found that support image input"}}').message, "This chat model can't read photos — paste the recipe text or a link instead.");
  assert.equal(friendlyOpenRouterError(404, "model does not support image_url content").kind, "no-vision");
  assert.equal(friendlyOpenRouterError(402, "Insufficient credits").kind, "out-of-credit");
  assert.equal(friendlyOpenRouterError(500, "boom").kind, "upstream");
  failWith = { status: 400, body: '{"error":{"message":"Model does not support image input (multimodal)"}}' };
  const err = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const evs = await turn([]);
    assert.equal(evs.filter((e) => e.name === "error").length, 1);
    assert.match(evs.find((e) => e.name === "error").data.message, /can't read photos/);
    assert.ok(logged.some((l) => /OpenRouter answered 400 \(model test\/model\)/.test(l) && /multimodal/.test(l)), "the provider's error is logged");
  } finally {
    console.error = err;
  }
});

test("a stream always ends with content or an error event, never empty", async () => {
  // the provider connection fails before anything is sent
  failWith = { status: 500, body: "" };
  const err = console.error;
  console.error = () => {};
  try {
    const evs = await turn([]);
    assert.ok(evs.some((e) => e.name === "error"));
  } finally {
    console.error = err;
  }
});
