// Round-2 hardening: the tray's dry runs read the branch from a snapshot (bounded GitHub calls), the panel's requests are rate limited,
// action chips that commit carry fixed labels, and the URL fetcher pins the connection to the checked address.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { clearCache } from "../lib/cache.js";

Object.assign(process.env, {
  GITHUB_TOKEN: "gh-test", MCP_AUTH_TOKEN: "secret", PUBLIC_SITE_URL: "https://site.test/favourite-recipes", SUPABASE_URL: "https://sb.test",
  SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", EDITORS: "owner@example.com", OPENROUTER_CHAT_PUBLIC_KEY: "or-public-test",
  OPENROUTER_CHAT_EDITOR_KEY: "or-editor-test", OPENROUTER_API_KEY: "or-image-test", CHAT_PUBLIC_HOURLY_LIMIT: "100000", CHAT_EDITOR_HOURLY_LIMIT: "100000",
  CHAT_EDITOR_DAILY_LIMIT: "100000", CHAT_PUBLIC_TOTAL_HOURLY_LIMIT: "100000",
});
const { createFakeGitHub, createMockOpenRouter, createFakeSupabase } = await import("../scripts/fakes.js");
let github, supabase, ghCalls;
const realFetch = globalThis.fetch;
let chat, tools, config, photos, chatUi, rateLimit;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) { ghCalls++; return github.fetch(s, init); }
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  tools = await import("../lib/tools.js");
  photos = await import("../lib/tray-photos.js");
  chatUi = await import("../lib/chat-ui.js");
  rateLimit = await import("../lib/rate-limit.js");
  ({ config } = await import("../lib/config.js"));
});
const OWNER = "00000000-0000-4000-8000-0000000000e1";
const editor = () => tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER });
beforeEach(() => {
  clearCache();
  rateLimit.resetRateLimitWarning();
  ghCalls = 0;
  github = createFakeGitHub({ clean: true });
  supabase = createFakeSupabase({ url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test", users: { "owner-token": { id: OWNER, email: "owner@example.com" } } });
  config.shoppingEditors = ["owner@example.com"];
  config.supabaseServiceKey = "service-test";
});
let ip = 0;
const get = (path, token = "owner-token") => chat.GET(new Request(`https://mcp.test/api/chat?route=${path}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `198.51.100.${++ip % 250}` } }));
const slugs = () => [...github.files.keys()].filter((p) => p.startsWith("recipes/")).map((p) => p.slice(8, -3)).sort();
const stage = (slug, n) => tools.dispatch("stage_update_recipe", { slug, total_mins: n }, editor(), { chat: { emit() {} } });

test("the tray's dry runs and the panel's reads cost a small constant number of GitHub calls, however many items are staged", async () => {
  const all = slugs();
  assert.ok(all.length >= 40);
  await stage(all[0], 31); // cold: reads the book once
  const cold = ghCalls;
  assert.ok(cold > 20, "the first read loads the book");
  ghCalls = 0;
  await stage(all[1], 32);
  assert.ok(ghCalls <= 2, `a warm stage costs ${ghCalls} GitHub calls`);
  for (let i = 2; i < 20; i++) await stage(all[i], 30 + i);
  await get("plan"); // loads the cached recipe index (once a minute per instance, however many requests)
  ghCalls = 0;
  let res = await get("plan");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).tray.count, 20);
  const with20 = ghCalls;
  assert.ok(with20 <= 2, `GET /chat/plan with 20 items: ${with20} GitHub calls`);
  for (let i = 20; i < 40; i++) await stage(all[i], 30 + i);
  ghCalls = 0;
  res = await get("plan");
  assert.equal((await res.json()).tray.count, 40);
  assert.equal(ghCalls, with20, "the cost doesn't grow with the tray");
  ghCalls = 0;
  for (let i = 0; i < 10; i++) await stage(all[i], 50 + i); // ten more stages in one go (re-staging merges into the cards)
  assert.ok(ghCalls <= 10 * 2, `ten stages cost ${ghCalls} GitHub calls`);
});

test("a commit drops the snapshot: the next dry run sees the new branch", async () => {
  const all = slugs();
  await stage(all[0], 31);
  const { commitChanges } = await import("../lib/github.js");
  await commitChanges([{ path: `recipes/${all[2]}.md`, content: github.files.get(`recipes/${all[2]}.md`) }], "touch", editor());
  ghCalls = 0;
  await stage(all[1], 33);
  assert.ok(ghCalls > 20, "re-read after our own commit");
});

test("the panel's plan and status requests are rate limited per editor", async () => {
  config.chatPanelHourlyLimit = 3;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get("status&slugs=a")).status, 200);
    const res = await get("plan");
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
  } finally {
    config.chatPanelHourlyLimit = 600;
  }
});

test("action chips carry fixed labels, whatever the model wrote", () => {
  const out = chatUi.cleanReplyList([{ label: "No thanks", action: "apply_plan" }, { label: "Totally harmless", action: "finalise_plan" }, { label: "Dup", action: "apply_plan" }, "Other"], new Map(), { editor: true });
  assert.deepEqual(out, [{ label: "Save to site", action: "apply_plan" }, { label: "Finalise list", action: "finalise_plan" }, "Other"]);
  assert.deepEqual(chatUi.cleanReplyList([{ label: "Save", action: "apply_plan" }], new Map(), { editor: false }), [], "a visitor never gets one");
});

test("private IPv6 forms are refused: IPv4-compatible, NAT64, site-local, 6to4, Teredo, mapped, documentation", () => {
  for (const a of ["::", "::1", "::7f00:1", "::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "fec0::1", "feb0::1", "2002:7f00:1::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::ffff:127.0.0.1", "::ffff:7f00:1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "not-an-ip"]) {
    assert.ok(photos.isPrivateAddress(a), a);
  }
  for (const a of ["2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "93.184.216.34", "::ffff:93.184.216.34"]) assert.ok(!photos.isPrivateAddress(a), a);
});

test("the fetcher connects to the checked address, not to whatever the name resolves to later", async () => {
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/plain", "x-host": req.headers.host }).end("pinned ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = new URL(`http://rebind.example:${server.address().port}/x`);
    // the name would resolve elsewhere (nowhere reachable): the request still lands on the pinned address and keeps the Host header
    const res = await photos.pinnedGet(url, "127.0.0.1", { headers: {}, timeoutMs: 3000 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-host"), `rebind.example:${server.address().port}`);
    assert.equal(await res.text(), "pinned ok");
    // redirects come back as a Response with no body, for fetchPublic to check and pin again
    const redirect = http.createServer((req, res) => res.writeHead(302, { location: "http://127.0.0.1/" }).end());
    await new Promise((r) => redirect.listen(0, "127.0.0.1", r));
    const r2 = await photos.pinnedGet(new URL(`http://x.example:${redirect.address().port}/`), "127.0.0.1", { headers: {} });
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.get("location"), "http://127.0.0.1/");
    redirect.close();
  } finally {
    server.close();
  }
});

test("fetchPublic re-checks and re-pins every redirect hop", async () => {
  const calls = [];
  const saved = [photos.deps.lookup, photos.deps.get];
  photos.deps.lookup = async (host) => (host === "evil.example" ? [{ address: "10.0.0.5" }] : [{ address: "93.184.216.34" }]);
  photos.deps.get = async (url, address) => {
    calls.push([url.hostname, address]);
    return url.hostname === "good.example" ? new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) : new Response("never");
  };
  try {
    await assert.rejects(() => photos.fetchPublic("https://good.example/a", { maxBytes: 1000 }), /isn't public/);
    assert.deepEqual(calls, [["good.example", "93.184.216.34"]]);
  } finally {
    [photos.deps.lookup, photos.deps.get] = saved;
  }
});
