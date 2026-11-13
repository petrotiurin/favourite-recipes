// Phase 3: signed-in editors on /chat. Verified-token roles, server-owned history in (fake) Supabase tables, the chats endpoints,
// feedback, retention, and the registry-wide check that no write or stage tool can run for anyone through /chat.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";
process.env.PUBLIC_SITE_URL = "https://site.test/favourite-recipes";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_ANON_KEY = "anon-test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
process.env.EDITORS = "owner@example.com, Partner@Example.com";
process.env.OPENROUTER_CHAT_PUBLIC_KEY = "or-public-test";
process.env.OPENROUTER_CHAT_EDITOR_KEY = "or-editor-test";
process.env.CHAT_PUBLIC_MODEL = "test/public-model";
process.env.CHAT_EDITOR_MODEL = "test/editor-model";
process.env.CHAT_PUBLIC_HOURLY_LIMIT = "1000";
process.env.CHAT_EDITOR_HOURLY_LIMIT = "5";

const { createFakeGitHub, createMockOpenRouter, createFakeSupabase } = await import("../scripts/fakes.js");
const github = createFakeGitHub({ clean: true });
let openrouter;
let supabase;
let langfuseCalls = []; // the score API (fetch)
const spans = new InMemorySpanExporter(); // the traces (the SDK's exporter)
const realFetch = globalThis.fetch;

let chat, config, langfuse, store, tools;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") return openrouter.fetch(s, init);
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    if (s.startsWith("https://langfuse.test/")) {
      const raw = init?.body ?? (url instanceof Request ? await url.clone().text() : undefined);
      langfuseCalls.push({ url: s, method: init?.method || (url instanceof Request ? url.method : "GET"), body: raw ? JSON.parse(raw) : null });
      return init?.method === "DELETE" ? Response.json({ message: "deleted" }) : Response.json({ accepted: 1, rejected: 0, errors: [] });
    }
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  ({ config } = await import("../lib/config.js"));
  langfuse = await import("../lib/langfuse.js");
  langfuse.useTestExporter(spans);
  store = await import("../lib/chat-store.js");
  tools = await import("../lib/tools.js");
});

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const PARTNER = "00000000-0000-4000-8000-0000000000e2";
const STRANGER = "00000000-0000-4000-8000-0000000000a1";
let clock;
beforeEach(() => {
  clock = Date.now();
  store.clock.now = () => clock;
  openrouter = createMockOpenRouter({ delayMs: 0 });
  supabase = createFakeSupabase({
    url: "https://sb.test",
    anonKey: "anon-test",
    serviceKey: "service-test",
    now: () => clock,
    users: {
      "owner-token": { id: OWNER, email: "owner@example.com" },
      "partner-token": { id: PARTNER, email: "partner@example.com" },
      "stranger-token": { id: STRANGER, email: "stranger@example.com" },
    },
  });
  langfuseCalls = [];
  spans.reset();
  github.commitLog.length = 0;
  config.langfusePublicKey = config.langfuseSecretKey = undefined;
  config.langfuseBaseUrl = "";
  config.supabaseServiceKey = "service-test";
  config.chatEditorHourlyLimit = 5;
  store.resetPurgeThrottle();
});

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;
const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});

function call(method, path, { token, body, ip = freshIp() } = {}) {
  const url = new URL(`https://mcp.test${path}`);
  const route = path.replace(/^\/chat\/?/, "").split("?")[0];
  // what Vercel's rewrite does: /chat/<route> -> /api/chat?route=<route>
  const real = route ? `https://mcp.test/api/chat?route=${route}` : "https://mcp.test/chat";
  const fn = chat[method];
  return fn(new Request(real, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...auth(token) }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
const turn = (token, body, opts) => call("POST", "/chat", { token, body, ...opts });

async function events(res) {
  const out = [];
  for (const block of (await res.text()).split("\n\n").filter(Boolean)) {
    out.push({ name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
  }
  return out;
}
const textOf = (evs) => evs.filter((e) => e.name === "text").map((e) => e.data.delta).join("");

// --- who is calling ---------------------------------------------------------------------------------------------

test("/chat/me: no token is a visitor, an editor's email in EDITORS is an editor, a stranger is a signed-in visitor, a bad token is 401", async () => {
  assert.deepEqual(await (await call("GET", "/chat/me")).json(), { role: "public", signedIn: false, public_enabled: true });
  assert.deepEqual(await (await call("GET", "/chat/me", { token: "owner-token" })).json(), { role: "editor", signedIn: true, public_enabled: true, email: "owner@example.com" });
  assert.deepEqual(await (await call("GET", "/chat/me", { token: "stranger-token" })).json(), { role: "public", signedIn: true, public_enabled: true, email: "stranger@example.com" });
  assert.equal((await call("GET", "/chat/me", { token: "nope" })).status, 401);
});

test("an editor's turn uses the editor key, model and the read + UI tools, and is stored under their user id", async () => {
  const res = await turn("owner-token", { message: "something with chicken", page: { page: "index" } });
  assert.equal(res.status, 200);
  const evs = await events(res);
  const meta = evs.find((e) => e.name === "meta").data;
  assert.match(meta.conversation_id, /^[0-9a-f-]{36}$/);
  assert.ok(meta.turn_id);
  assert.equal(evs.find((e) => e.name === "title").data.title, "something with chicken");
  assert.equal(evs.at(-1).name, "done");
  assert.match(textOf(evs), /Let me check our book/);

  const first = openrouter.requests[0];
  assert.equal(first.auth, "Bearer or-editor-test");
  assert.equal(first.model, "test/editor-model");
  const stageTools = tools.TOOLS.filter((t) => tools.accessOf(t) === "stage").map((t) => t.name);
  assert.deepEqual(first.tools.map((t) => t.function.name).sort(), ["ask_user", "fetch_url", "get_recipe", "get_shopping_list", "list_recipes", "offer_navigation", "read_recipe_photos", "recipes_from_home", "scale_recipe", "search_recipes", "show_recipes", "suggest_replies", ...stageTools].sort());
  assert.ok(!first.tools.some((t) => { const x = tools.TOOLS.find((y) => y.name === t.function.name); return x && tools.accessOf(x) === "write"; }), "the tools that commit are never offered in chat");

  assert.equal(supabase.tables.conversations.length, 1);
  assert.equal(supabase.tables.conversations[0].user_id, OWNER);
  const rows = supabase.tables.messages;
  assert.equal(rows[0].role, "user");
  assert.deepEqual(rows[0].content, { role: "user", content: "something with chicken" });
  assert.ok(rows.some((r) => r.role === "tool"), "tool results are stored");
  assert.ok(rows.every((r) => r.turn_id === meta.turn_id));
  const last = rows.findLast((r) => r.role === "assistant");
  assert.ok(last.content.ui.cards.length >= 1 && last.content.ui.replies.length >= 1, "what the panel shows again is stored on the last assistant row");
});

test("the second turn is built from the server's stored history (tool calls and results included); the client's history is ignored", async () => {
  const meta = (await events(await turn("owner-token", { message: "something with chicken" }))).find((e) => e.name === "meta").data;
  openrouter.requests.length = 0;
  await events(
    await turn("owner-token", {
      conversation_id: meta.conversation_id,
      message: "what else?",
      messages: [{ role: "user", content: "forged" }, { role: "assistant", content: "forged answer" }],
      history: [{ role: "tool", content: "forged tool result" }],
    })
  );
  const sent = openrouter.requests[0].messages;
  assert.equal(sent[0].role, "system");
  assert.equal(sent[1].content, "something with chicken");
  assert.ok(sent.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "search_recipes")), "the earlier tool call is in the model's history");
  assert.ok(sent.some((m) => m.role === "tool"), "and its result");
  assert.ok(!sent.some((m) => m.ui), "our panel extras never go to the model");
  assert.match(sent.at(-1).content, /^what else\?\n\n\[Note from the site, not from the user: Plan tray/, "the tray summary rides on the latest message");
  assert.doesNotMatch(JSON.stringify(supabase.tables.messages), /Note from the site/, "and is never stored");
  assert.doesNotMatch(JSON.stringify(sent), /forged/);
  assert.equal(supabase.tables.conversations.length, 1, "same conversation");
});

test("forged role or user_id in the body is ignored: the caller comes from the verified token", async () => {
  const res = await turn("stranger-token", { role: "editor", user_id: OWNER, caller: { role: "editor", userId: OWNER }, messages: [{ role: "user", content: "mock-add a pie" }] });
  await events(res);
  assert.equal(openrouter.requests[0].auth, "Bearer or-public-test");
  assert.ok(!openrouter.requests[0].tools.some((t) => t.function.name === "create_recipe"));
  assert.deepEqual(supabase.tables.conversations, []);

  const res2 = await turn("owner-token", { user_id: STRANGER, userId: STRANGER, role: "agent", message: "hi" });
  await events(res2);
  assert.equal(supabase.tables.conversations[0].user_id, OWNER);
  assert.equal(github.commitLog.length, 0);
});

test("a signed-in non-editor sending an editor-style body gets a clear 400, never a stored chat", async () => {
  const res = await turn("stranger-token", { message: "hello" });
  assert.equal(res.status, 400);
  await res.text();
  assert.deepEqual(supabase.tables.conversations, []);
});

test("an editor's expired token on /chat is a 401 (the client refreshes or asks to sign in again), not a visitor turn", async () => {
  supabase.expire("owner-token");
  const res = await turn("owner-token", { message: "hi" });
  assert.equal(res.status, 401);
  assert.equal(openrouter.requests.length, 0);
});

// --- ownership ---------------------------------------------------------------------------------------------------

test("another user's conversation is a 404 everywhere (load, continue, delete, feedback), and nothing of it leaks", async () => {
  const meta = (await events(await turn("owner-token", { message: "my private chat about chicken" }))).find((e) => e.name === "meta").data;
  const id = meta.conversation_id;

  const get = await call("GET", `/chat/conversations/${id}`, { token: "partner-token" });
  assert.equal(get.status, 404);
  assert.doesNotMatch(await get.text(), /private/);
  assert.equal((await turn("partner-token", { conversation_id: id, message: "hi" })).status, 404);
  assert.equal((await call("DELETE", `/chat/conversations/${id}`, { token: "partner-token" })).status, 404);
  assert.equal((await call("POST", "/chat/feedback", { token: "partner-token", body: { conversation_id: id, turn_id: meta.turn_id, value: 1 } })).status, 404);
  assert.equal(supabase.tables.conversations.length, 1, "still there");
  assert.equal(supabase.tables.messages.filter((m) => m.role === "user").length, 1, "nothing was appended");
  // an id that doesn't exist looks the same as someone else's
  assert.equal((await call("GET", "/chat/conversations/00000000-0000-4000-8000-000000000999", { token: "owner-token" })).status, 404);
  assert.equal((await call("GET", "/chat/conversations/not-a-uuid", { token: "owner-token" })).status, 404);
  // the owner still can
  assert.equal((await call("GET", `/chat/conversations/${id}`, { token: "owner-token" })).status, 200);
});

test("the chats endpoints need an editor: 401 without a token or with a bad one, 403 for a signed-in non-editor", async () => {
  for (const [method, path] of [["GET", "/chat/conversations"], ["GET", "/chat/conversations/00000000-0000-4000-8000-000000000001"], ["DELETE", "/chat/conversations/00000000-0000-4000-8000-000000000001"], ["POST", "/chat/feedback"]]) {
    const body = method === "POST" ? { conversation_id: "x", turn_id: "y", value: 1 } : undefined;
    assert.equal((await call(method, path, { body })).status, 401, `${method} ${path} without a token`);
    assert.equal((await call(method, path, { token: "nope", body })).status, 401, `${method} ${path} with a bad token`);
    assert.equal((await call(method, path, { token: "stranger-token", body })).status, 403, `${method} ${path} as a non-editor`);
  }
});

test("conversations: listed newest first with title and expiry, loaded as the panel shows them, deleted with their messages", async () => {
  await events(await turn("owner-token", { message: "first chat" }));
  clock += 60_000;
  const second = (await events(await turn("owner-token", { message: "something with chicken" }))).find((e) => e.name === "meta").data;
  await events(await turn("partner-token", { message: "partner's chat" }));

  const list = (await (await call("GET", "/chat/conversations", { token: "owner-token" })).json()).conversations;
  assert.deepEqual(list.map((c) => c.title), ["something with chicken", "first chat"], "only my own, newest first");
  assert.ok(Math.abs(new Date(list[0].expires_at) - new Date(list[0].updated_at) - 14 * 86400_000) < 1000);

  const loaded = await (await call("GET", `/chat/conversations/${second.conversation_id}`, { token: "owner-token" })).json();
  assert.equal(loaded.messages[0].role, "user");
  const bot = loaded.messages[1];
  assert.equal(bot.role, "assistant");
  assert.equal(bot.turn_id, second.turn_id);
  assert.match(bot.content, /Let me check our book\./);
  assert.ok(bot.cards.length >= 1 && bot.replies.length >= 1);
  assert.equal(loaded.messages.length, 2, "one assistant message per turn, tool rows hidden");

  assert.equal((await call("DELETE", `/chat/conversations/${second.conversation_id}`, { token: "owner-token" })).status, 200);
  assert.equal(supabase.tables.conversations.length, 2);
  assert.ok(!supabase.tables.messages.some((m) => m.conversation_id === second.conversation_id), "messages cascade");
});

test("the tables are server-only: the public anon key can't read them", async () => {
  await events(await turn("owner-token", { message: "hello there" }));
  const res = await supabase.fetch("https://sb.test/rest/v1/messages?select=*", { headers: { apikey: "anon-test", Authorization: "Bearer anon-test" } });
  assert.equal(res.status, 401);
});

// --- retention ---------------------------------------------------------------------------------------------------

test("retention: a chat is gone 2 weeks after its last message; listing purges, and an expired chat can't be loaded", async () => {
  const old = (await events(await turn("owner-token", { message: "old chat" }))).find((e) => e.name === "meta").data;
  clock += 10 * 86400_000;
  await events(await turn("owner-token", { message: "newer chat" }));
  clock += 5 * 86400_000; // the old one is now 15 days past its last message, the newer one 5
  assert.equal((await call("GET", `/chat/conversations/${old.conversation_id}`, { token: "owner-token" })).status, 404, "expired chats can't be loaded even before a purge");
  const list = (await (await call("GET", "/chat/conversations", { token: "owner-token" })).json()).conversations;
  assert.deepEqual(list.map((c) => c.title), ["newer chat"]);
  assert.equal(supabase.tables.conversations.length, 1, "opening the list ran purge_old_chats");
  assert.ok(!supabase.tables.messages.some((m) => m.conversation_id === old.conversation_id), "its messages went with it");
  assert.ok(supabase.calls.some((c) => c.purged === 1));
});

test("the migration defines the tables, locks them down and the purge function (14 days)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => /chat_conversations/.test(f));
  const sql = readFileSync(new URL(file, dir), "utf8");
  assert.match(sql, /create table if not exists public\.conversations/);
  assert.match(sql, /create table if not exists public\.messages/);
  assert.match(sql, /references public\.conversations \(id\) on delete cascade/);
  assert.match(sql, /alter table public\.conversations enable row level security/);
  assert.match(sql, /alter table public\.messages enable row level security/);
  assert.doesNotMatch(sql, /create policy/i, "no policies: only the service role can reach the tables");
  assert.match(sql, /interval '14 days'/);
  assert.equal(store.RETENTION_DAYS, 14);
  assert.match(sql, /pg_cron/);
});

// --- rate limits -------------------------------------------------------------------------------------------------

test("editors get their own, higher limit keyed by user id (not IP)", async () => {
  for (let i = 0; i < 5; i++) {
    const res = await turn("owner-token", { message: `m${i}` }, { ip: "198.51.100.1" });
    assert.equal(res.status, 200);
    await events(res); // let the stream finish before the next test swaps the fakes
  }
  const limited = await turn("owner-token", { message: "one too many" }, { ip: "198.51.100.2" });
  assert.equal(limited.status, 429, "a different IP doesn't help: it's the same user");
  assert.ok([...supabase.counters.keys()].some((k) => k.startsWith(`editor:${OWNER}:hour`)));
  const other = await turn("partner-token", { message: "hi" }, { ip: "198.51.100.1" });
  assert.equal(other.status, 200, "another editor is unaffected");
  await events(other);
});

// --- history cap -------------------------------------------------------------------------------------------------

test("long chats: only the last messages go to the model, never starting mid tool exchange; failed turns' user messages are merged", () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ content: { role: "user", content: `q${i}` } });
    rows.push({ content: { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "search_recipes", arguments: "{}" } }] } });
    rows.push({ content: { role: "tool", tool_call_id: `c${i}`, content: "[]" } });
    rows.push({ content: { role: "assistant", content: `a${i}`, ui: { cards: [] } } });
  }
  const h = store.historyForModel(rows, 40);
  assert.ok(h.length <= 40);
  assert.equal(h[0].role, "user");
  assert.equal(h.at(-1).content, "a29");
  assert.ok(h.every((m) => !("ui" in m)));
  const merged = store.historyForModel([{ content: { role: "user", content: "one" } }, { content: { role: "user", content: "two" } }]);
  assert.deepEqual(merged, [{ role: "user", content: "one\n\ntwo" }]);
});

test("titles are short and come from the first message", () => {
  assert.equal(store.titleFrom("  hello   there "), "hello there");
  const t = store.titleFrom("What can I cook tonight with leftover chicken and some rice and nothing else at all");
  assert.ok(t.length <= 50 && t.endsWith("…"));
});

// --- the registry-wide auth test ---------------------------------------------------------------------------------

test("every stage/write tool in the registry is refused through /chat for a visitor, an expired token and a non-editor; for an editor only stage tools are offered and nothing commits", async () => {
  config.chatEditorHourlyLimit = 1000;
  const gated = tools.TOOLS.filter((t) => tools.accessOf(t) !== "read");
  assert.ok(gated.length >= 8, "the registry has write tools to check");
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const tool of gated) {
      const ask = `mock-call:${tool.name}`;
      for (const [label, token, body] of [
        ["no token", undefined, { messages: [{ role: "user", content: ask }] }],
        ["non-editor", "stranger-token", { messages: [{ role: "user", content: ask }] }],
        ["editor", "owner-token", { message: ask }],
      ]) {
        openrouter.requests.length = 0;
        const res = await turn(token, body);
        assert.equal(res.status, 200, `${tool.name} (${label})`);
        await events(res);
        const offered = openrouter.requests[0].tools.some((t) => t.function.name === tool.name);
        const toolMsg = openrouter.requests[1].messages.findLast((m) => m.role === "tool");
        if (label === "editor" && tools.accessOf(tool) === "stage") {
          assert.ok(offered, `${tool.name} is offered to an editor`);
          assert.doesNotMatch(toolMsg.content, /not available here/, `${tool.name} reaches the dispatcher for an editor`);
        } else {
          assert.ok(!offered, `${tool.name} isn't offered to ${label}`);
          assert.match(toolMsg.content, /not available here/, `${tool.name} is refused for ${label}`);
        }
      }
      // an expired token never even reaches the model
      supabase.expire("owner-token");
      openrouter.requests.length = 0;
      assert.equal((await turn("owner-token", { message: ask })).status, 401, `${tool.name} with an expired token`);
      assert.equal(openrouter.requests.length, 0);
      supabase.tokens.get("owner-token").exp = Infinity;
    }
    assert.equal(github.commitLog.length, 0, "nothing was ever committed");
  } finally {
    console.warn = warn;
  }
  // and the dispatcher itself, whatever the layers above did: a visitor can't run them either
  for (const tool of gated) {
    const out = await tools.dispatch(tool.name, {}, tools.makeCaller({ role: "public" }));
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /Not allowed/);
  }
});

// --- feedback ----------------------------------------------------------------------------------------------------

async function startedTurn(token = "owner-token") {
  return (await events(await turn(token, { message: "something with chicken" }))).find((e) => e.name === "meta").data;
}
const feedbackRow = () => supabase.tables.messages.findLast((m) => m.role === "assistant");

test("feedback: thumbs up and down are stored on the turn, down keeps reasons and note, clearing removes them", async () => {
  const meta = await startedTurn();
  const post = (body, token = "owner-token") => call("POST", "/chat/feedback", { token, body: { conversation_id: meta.conversation_id, turn_id: meta.turn_id, ...body } });
  assert.equal((await post({ value: 1 })).status, 200);
  assert.deepEqual(feedbackRow().feedback, { value: 1 });
  assert.equal((await post({ value: 0 })).status, 200);
  assert.deepEqual(feedbackRow().feedback, { value: 0, reasons: [], note: "" });
  assert.equal((await post({ value: 0, reasons: ["Wrong amounts", "made up", "Too slow"], note: "  too much\nsalt  " })).status, 200);
  assert.deepEqual(feedbackRow().feedback, { value: 0, reasons: ["Wrong amounts", "Too slow"], note: "too much salt" });
  // it comes back when the chat is loaded
  const loaded = await (await call("GET", `/chat/conversations/${meta.conversation_id}`, { token: "owner-token" })).json();
  assert.equal(loaded.messages[1].feedback.value, 0);
  assert.equal((await post({ value: null })).status, 200);
  assert.equal(feedbackRow().feedback, null);
  assert.equal((await post({ value: 5 })).status, 400);
  assert.equal((await post({ value: 1, turn_id: "no-such-turn" })).status, 404);
});

test("feedback goes to Langfuse as the score user-feedback on that turn's trace; clearing deletes it; off means a quiet no-op", async () => {
  config.langfusePublicKey = "pk-lf-test";
  config.langfuseSecretKey = "sk-lf-test";
  config.langfuseBaseUrl = "https://langfuse.test";
  const meta = await startedTurn();
  await langfuse.idle();
  const exported = spans.getFinishedSpans();
  const root = exported.find((sp) => !sp.parentSpanContext?.spanId);
  assert.equal(root.attributes["user.id"], OWNER, "the Supabase user id, not the email");
  assert.deepEqual(root.attributes["langfuse.trace.tags"], ["editor"]);
  assert.equal(root.attributes["session.id"], meta.conversation_id);
  assert.equal(JSON.parse(root.attributes["langfuse.observation.metadata.model"]), "test/editor-model");
  assert.ok(!JSON.stringify(exported.map((sp) => sp.attributes)).includes("owner@example.com"));
  const traceId = root.spanContext().traceId;
  assert.equal(feedbackRow().trace_id, traceId, "the trace id is stored per assistant turn");

  langfuseCalls.length = 0;
  const post = (body) => call("POST", "/chat/feedback", { token: "owner-token", body: { conversation_id: meta.conversation_id, turn_id: meta.turn_id, ...body } });
  await post({ value: 0, reasons: ["Wrong recipe"], note: "pasta, not chicken" });
  assert.equal(langfuseCalls[0].url, "https://langfuse.test/api/public/scores", "the scores API, not the legacy ingestion endpoint");
  const score = langfuseCalls[0].body[0];
  assert.equal(score.name, "user-feedback");
  assert.equal(score.value, 0);
  assert.equal(score.traceId, traceId);
  assert.match(score.comment, /Wrong recipe/);
  assert.match(score.comment, /pasta, not chicken/);
  await post({ value: 1 });
  assert.equal(langfuseCalls[1].body[0].id, score.id, "same score id, so it replaces the earlier one");
  assert.equal(langfuseCalls[1].body[0].value, 1);
  await post({ value: null });
  assert.equal(langfuseCalls[2].method, "DELETE");
  assert.ok(langfuseCalls[2].url.endsWith(`/scores/${encodeURIComponent(score.id)}`));

  config.langfusePublicKey = undefined;
  langfuseCalls.length = 0;
  assert.equal((await post({ value: 1 })).status, 200, "with Langfuse off the UI still works");
  assert.equal(langfuseCalls.length, 0);
  assert.equal(feedbackRow().feedback.value, 1);
});

test("visitors have no feedback controls to call: the endpoint refuses them", async () => {
  const meta = await startedTurn();
  const res = await call("POST", "/chat/feedback", { body: { conversation_id: meta.conversation_id, turn_id: meta.turn_id, value: 1 } });
  assert.equal(res.status, 401);
  assert.equal(feedbackRow().feedback, null);
});
