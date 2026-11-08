// The chat's on/off switches: CHAT_ENABLED (everything off) and CHAT_PUBLIC_ENABLED (editors only), read per request.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, { GITHUB_TOKEN: "gh-test", MCP_AUTH_TOKEN: "secret", PUBLIC_SITE_URL: "https://site.test/favourite-recipes", SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", EDITORS: "owner@example.com", OPENROUTER_CHAT_PUBLIC_KEY: "or-public-test", OPENROUTER_CHAT_EDITOR_KEY: "or-editor-test", CHAT_PUBLIC_HOURLY_LIMIT: "1000", CHAT_EDITOR_HOURLY_LIMIT: "1000", CHAT_PUBLIC_TOTAL_HOURLY_LIMIT: "100000" });
const { createFakeGitHub, createMockOpenRouter, createFakeSupabase } = await import("../scripts/fakes.js");
const github = createFakeGitHub({ clean: true });
let openrouter, supabase, outside; // outside: every call that left the handler
const realFetch = globalThis.fetch;
let chat;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    outside.push(s);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") return openrouter.fetch(s, init);
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
});
beforeEach(() => {
  outside = [];
  openrouter = createMockOpenRouter({ delayMs: 0 });
  supabase = createFakeSupabase({ url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test", users: { "owner-token": { id: "00000000-0000-4000-8000-0000000000e1", email: "owner@example.com" }, "stranger-token": { id: "00000000-0000-4000-8000-0000000000a1", email: "stranger@example.com" } } });
});
afterEach(() => {
  delete process.env.CHAT_ENABLED;
  delete process.env.CHAT_PUBLIC_ENABLED;
});
let n = 0;
const req = (method, route, { token, body } = {}) => {
  const url = route ? `https://mcp.test/api/chat?route=${route}` : "https://mcp.test/chat";
  return chat[method](new Request(url, { method, headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++n % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
};
const visitor = { messages: [{ role: "user", content: "hi" }] };

test("CHAT_ENABLED=false: every /chat route answers 503 { disabled: true } before any work, whoever asks", async () => {
  for (const value of ["false", "0", "off", "FALSE", " no "]) {
    process.env.CHAT_ENABLED = value;
    const calls = [
      ["POST", "", { body: visitor }],
      ["POST", "", { token: "owner-token", body: { message: "hi" } }],
      ["POST", "feedback", { token: "owner-token", body: {} }],
      ["POST", "plan/apply", { token: "owner-token", body: {} }],
      ["POST", "plan/items/abcdef12/photo", { token: "owner-token" }],
      ["GET", "me", {}],
      ["GET", "me", { token: "owner-token" }],
      ["GET", "conversations", { token: "owner-token" }],
      ["GET", "conversations/abc", { token: "owner-token" }],
      ["GET", "plan", { token: "owner-token" }],
      ["GET", "status&slugs=a", { token: "owner-token" }],
      ["DELETE", "conversations/abc", { token: "owner-token" }],
      ["DELETE", "plan/items/abcdef12", { token: "owner-token" }],
    ];
    for (const [method, route, opts] of calls) {
      const res = await req(method, route, opts);
      assert.equal(res.status, 503, `${method} ${route} (${value})`);
      assert.deepEqual(await res.json(), { error: "The chat is switched off.", disabled: true });
    }
    assert.deepEqual(outside, [], "no GitHub, Supabase or model call was made");
  }
  // preflight still answers, so the browser can read the 503
  const pre = await chat.OPTIONS(new Request("https://mcp.test/chat", { method: "OPTIONS", headers: { origin: "https://site.test" } }));
  assert.equal(pre.status, 204);
});

test("the switches are read on every request: flipping the variable needs no restart", async () => {
  assert.equal((await req("GET", "me", {})).status, 200);
  process.env.CHAT_ENABLED = "false";
  assert.equal((await req("GET", "me", {})).status, 503);
  process.env.CHAT_ENABLED = "true";
  assert.equal((await req("GET", "me", {})).status, 200);
  delete process.env.CHAT_ENABLED;
  assert.equal((await req("GET", "me", {})).status, 200, "on by default");
});

test("CHAT_PUBLIC_ENABLED=false: visitors and non-editor accounts get 403 { signin: true } before the rate limit and the model; editors carry on", async () => {
  process.env.CHAT_PUBLIC_ENABLED = "false";
  for (const token of [undefined, "stranger-token"]) {
    outside = [];
    const res = await req("POST", "", { token, body: visitor });
    assert.equal(res.status, 403, String(token));
    assert.deepEqual(await res.json(), { error: "The chat is only for signed-in editors.", signin: true });
    assert.ok(!outside.some((u) => u.includes("openrouter") || u.includes("rate_limit_hit") || u.startsWith("https://api.github.com")), `no model, rate limit or GitHub call (${outside.join(", ")})`);
  }
  const editor = await req("POST", "", { token: "owner-token", body: { message: "hi" } });
  assert.equal(editor.status, 200);
  assert.match(await editor.text(), /event: done/);
  assert.ok(openrouter.requests.length >= 1);
  // /me tells the panel
  assert.equal((await (await req("GET", "me", {})).json()).public_enabled, false);
  assert.equal((await (await req("GET", "me", { token: "owner-token" })).json()).public_enabled, false);
  assert.equal((await (await req("GET", "me", { token: "owner-token" })).json()).role, "editor");
  delete process.env.CHAT_PUBLIC_ENABLED;
  assert.equal((await (await req("GET", "me", {})).json()).public_enabled, true);
  assert.equal((await req("POST", "", { body: visitor })).status, 200, "visitors are back");
});

test("the build adds data-public=\"false\" to the chat script only with CHAT_PUBLIC=false, and no chat script without CHAT_API_URL", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const root = new URL("../../", import.meta.url).pathname;
  const html = (env) => {
    const out = mkdtempSync(`${tmpdir()}/recipes-dist-`);
    try {
      const clean = { ...process.env };
      for (const k of ["CHAT_API_URL", "CHAT_PUBLIC"]) delete clean[k];
      const r = spawnSync("node", ["build.js"], { cwd: root, env: { ...clean, BUILD_OUT_DIR: out, ...env }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(`${out}/index.html`, "utf8");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  };
  assert.match(html({ CHAT_API_URL: "http://x/chat" }), /<script src="chat\.js" data-api="http:\/\/x\/chat" defer>/);
  assert.match(html({ CHAT_API_URL: "http://x/chat", CHAT_PUBLIC: "false" }), /data-api="http:\/\/x\/chat" data-public="false" defer/);
  assert.doesNotMatch(html({ CHAT_API_URL: "http://x/chat", CHAT_PUBLIC: "true" }), /data-public/);
  assert.doesNotMatch(html({ CHAT_PUBLIC: "false" }), /chat\.js/);
});
