// Phase 4: editors' writes through the household plan tray. Staging validates with a dry run and never commits; Save is its own request
// (fresh token + EDITORS), re-validates, commits once with the photos and empties the tray; Finalise builds the shopping list first;
// clashes stop a Save; expired trays and their photos are purged; photo fetching refuses private addresses.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearCache } from "../lib/cache.js";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";
process.env.PUBLIC_SITE_URL = "https://site.test/favourite-recipes";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_ANON_KEY = "anon-test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
process.env.EDITORS = "owner@example.com, Partner@Example.com";
process.env.OPENROUTER_CHAT_PUBLIC_KEY = "or-public-test";
process.env.OPENROUTER_CHAT_EDITOR_KEY = "or-editor-test";
process.env.OPENROUTER_API_KEY = "or-image-test";
process.env.CHAT_PUBLIC_HOURLY_LIMIT = "100000";
process.env.CHAT_EDITOR_HOURLY_LIMIT = "100000";
process.env.CHAT_EDITOR_DAILY_LIMIT = "100000";
process.env.CHAT_PUBLIC_TOTAL_HOURLY_LIMIT = "100000";

const { createFakeGitHub, createMockOpenRouter, createFakeSupabase, createFakeImageApi } = await import("../scripts/fakes.js");
let github, openrouter, supabase, images, pages;
const realFetch = globalThis.fetch;
let clock;

let chat, store, tools, tray, photos, config, background, planApply;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") return openrouter.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/images") return images.fetch(s, init);
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    if (s.startsWith("https://site.test/")) return pages(s, init);
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  store = await import("../lib/chat-store.js");
  tools = await import("../lib/tools.js");
  tray = await import("../lib/tray.js");
  photos = await import("../lib/tray-photos.js");
  background = await import("../lib/background.js");
  planApply = await import("../lib/plan-apply.js");
  ({ config } = await import("../lib/config.js"));
});

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const PARTNER = "00000000-0000-4000-8000-0000000000e2";
const STRANGER = "00000000-0000-4000-8000-0000000000a1";
beforeEach(async () => {
  clock = Date.now();
  store.clock.now = () => clock;
  clearCache();
  github = createFakeGitHub({ clean: true });
  openrouter = createMockOpenRouter({ delayMs: 0 });
  images = createFakeImageApi();
  pages = () => new Response(null, { status: 404 });
  supabase = createFakeSupabase({
    url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test", now: () => clock,
    users: { "owner-token": { id: OWNER, email: "owner@example.com" }, "partner-token": { id: PARTNER, email: "partner@example.com" }, "stranger-token": { id: STRANGER, email: "stranger@example.com" } },
  });
  config.shoppingEditors = ["owner@example.com", "partner@example.com"];
  config.supabaseServiceKey = "service-test";
  photos.deps.lookup = async () => [{ address: "93.184.216.34" }];
  photos.deps.get = (url, _address, init) => fetch(url, { redirect: "manual", ...init }); // the tests fake the network through the global fetch
});

let ip = 0;
const call = (method, path, { token, body } = {}) => {
  const [route, qs] = path.replace(/^\/chat\/?/, "").split("?");
  const real = route ? `https://mcp.test/api/chat?route=${route}${qs ? `&${qs}` : ""}` : "https://mcp.test/chat";
  return chat[method](new Request(real, { method, headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
};
async function events(res) {
  const out = [];
  for (const block of (await res.text()).split("\n\n").filter(Boolean)) out.push({ name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
  return out;
}
const say = async (message, { token = "owner-token", conversation_id, page, action, answers } = {}) => {
  const res = await call("POST", "/chat", { token, body: { message, conversation_id, page: page || { page: "index" }, ...(action ? { action } : {}), ...(answers ? { answers } : {}) } });
  assert.equal(res.status, 200, message);
  const evs = await events(res);
  await background.backgroundIdle();
  return { evs, conversation_id: evs.find((e) => e.name === "meta")?.data.conversation_id || conversation_id };
};
const plan = async (token = "owner-token") => (await (await call("GET", "/chat/plan", { token })).json()).tray;
const trayRow = () => supabase.tables.trays[0];
const recipePath = (slug) => `recipes/${slug}.md`;
const anySlug = (n = 0) => [...github.files.keys()].filter((p) => p.startsWith("recipes/")).map((p) => p.slice(8, -3)).sort()[n];
const setFlag = (slug, flags) => {
  let md = github.files.get(recipePath(slug)).toString().replace(/^(draft|current|next): true\n/gm, "");
  md = md.replace(/^---\n([\s\S]*?)\n---/, (m, fm) => `---\n${fm}\n${flags}\n---`);
  github.files.set(recipePath(slug), Buffer.from(md));
  clearCache(); // changed behind the server's back: drop its branch snapshot
};
const pageOf = (slug) => ({ page: "recipe", slug });

// --- staging ---------------------------------------------------------------------------------------------------------------

test("an editor stages a new recipe: it goes in the tray (not the repo), with a photo made in the background and shown by a signed URL", async () => {
  const { evs } = await say("add a new recipe: test pasta");
  assert.ok(evs.some((e) => e.name === "tray"), "the panel is told the tray changed");
  assert.equal(github.commitLog.length, 0, "staging never commits");
  assert.ok(!github.files.has(recipePath("test-pasta")));

  const t = await plan();
  assert.equal(t.count, 1);
  const card = t.items[0];
  assert.equal(card.kind, "new");
  assert.equal(card.title, "Test Pasta");
  assert.equal(card.added_by, "Owner");
  assert.equal(card.error, null);
  assert.deepEqual(card.detail.ingredients.slice(0, 2), ["200g pasta", "2 garlic cloves"]);
  assert.equal(card.photo.status, "ready", "the background job finished");
  assert.equal(images.requests.length, 1, "generated, since no link was given");
  assert.equal(images.requests[0].auth, "Bearer or-image-test");
  assert.match(card.photo.url, /^https:\/\/sb\.test\/storage\/v1\/object\/sign\/tray-photos\/.+\/test-pasta\.jpg\?token=/);
  const img = await supabase.fetch(card.photo.url, {});
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal([...supabase.objects.keys()].length, 1);
  assert.equal(t.needs_list, true, "a new recipe in next week changes the list");
  assert.equal(t.can_save, false);
  assert.equal(t.state, "collecting");
  assert.ok(Math.abs(Date.parse(t.expires_at) - clock - 7 * 86400_000) < 5000, "expires 7 days after the first item");
});

test("the dry run reports problems on the card at once, and re-staging the same title replaces it", async () => {
  const slug = anySlug();
  const out = await tools.dispatch("stage_create_recipe", { title: "Bad One", course: ["Dinner"], total_mins: 10, serves: 2, calories: 100, ingredients: [{ name: "salt" }], instructions: ["Do the **salt**."] }, tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER }), { chat: { emit() {}, trace: {} } });
  assert.match(out.content[0].text, /PROBLEM on the card/);
  assert.match(out.content[0].text, /quantity/);
  const t = await plan();
  assert.match(t.items[0].error, /quantity/);
  assert.equal(t.can_save, false);
  assert.equal(slug.length > 0, true);
  const again = await tools.dispatch("stage_create_recipe", { title: "Bad One", course: ["Dinner"], total_mins: 10, serves: 2, calories: 100, ingredients: [{ quantity: "1 tsp", name: "salt" }], instructions: ["Do the **salt**."] }, tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER }), { chat: { emit() {}, trace: {} } });
  assert.doesNotMatch(again.content[0].text, /PROBLEM/);
  await background.backgroundIdle();
  const t2 = await plan();
  assert.equal(t2.count, 1, "replaced, not duplicated");
  assert.equal(t2.items[0].error, null);
});

test("stage tools and the tray writes refuse a public caller, whatever called them", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const pub = tools.makeCaller({ role: "public" });
    for (const t of tools.TOOLS.filter((x) => tools.accessOf(x) === "stage")) {
      const out = await tools.dispatch(t.name, {}, pub, { chat: { emit() {} } });
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /Not allowed/);
    }
    await assert.rejects(() => tray.stageOp({ op: { action: "promote_recipe", slug: "x" } }, pub), /only an editor/);
    await assert.rejects(() => tray.dropItem("abcdef12", pub), /only an editor/);
    await assert.rejects(() => tray.mutate(pub, async () => ({ result: 1 })), /only an editor/);
    await assert.rejects(() => planApply.applyPlan({ caller: pub }), /only an editor or the MCP agent/);
    // an editor caller outside the chat (no chat context) can't use a stage tool either
    const noChat = await tools.dispatch("stage_promote_recipe", { slug: "x" }, tools.makeCaller({ role: "editor", userId: OWNER }));
    assert.match(noChat.content[0].text, /only works inside the chat/);
  } finally {
    console.warn = quiet;
  }
  assert.equal(supabase.tables.trays.length, 0);
});

test("the MCP server does not expose the stage tools, and its write tools are unchanged", async () => {
  const { buildServer } = await import("../lib/server.js");
  const server = buildServer({ origin: "https://mcp.test" });
  const names = Object.keys(server._registeredTools);
  assert.ok(names.includes("create_recipe") && names.includes("batch_changes"));
  assert.ok(!names.some((n) => n.startsWith("stage_") || ["get_tray", "drop_tray_item", "resolve_clash"].includes(n)));
});

// --- Save --------------------------------------------------------------------------------------------------------------

async function stagedPastaAndList() {
  const { conversation_id } = await say("add a new recipe: test pasta");
  const finalise = await say("ignored", { conversation_id, action: "finalise" });
  return { conversation_id, finalise };
}

test("Finalise builds the list, then Save commits ONCE with the photo, empties the tray, deletes the staged photo and posts a summary with a Publishing card", async () => {
  const { conversation_id } = await stagedPastaAndList();
  const t = await plan();
  assert.equal(t.state, "ready");
  assert.equal(t.list_current, true);
  assert.equal(t.can_save, true);
  assert.deepEqual(t.items.map((i) => i.kind), ["new", "list"], "Save order: new recipes, then the list");
  assert.match(t.items[1].title, /^\d+ items for 1 recipe$/);
  assert.equal(github.commitLog.length, 0, "nothing committed yet");

  const res = await call("POST", "/chat/plan/apply", { token: "owner-token", body: { conversation_id } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.saved, 2);
  assert.equal(github.commitLog.length, 1, "one commit");
  assert.deepEqual(github.commitLog[0].paths.sort(), ["images/recipes/test-pasta.jpg", "recipes/test-pasta.md", "shopping-list.json"]);
  assert.match(github.files.get(recipePath("test-pasta")).toString(), /draft: true/);
  assert.match(github.files.get(recipePath("test-pasta")).toString(), /next: true/);
  assert.ok(github.files.get("images/recipes/test-pasta.jpg").length > 1000, "the photo bytes went into the commit");
  assert.equal(JSON.parse(github.files.get("shopping-list.json")).recipes[0], "test-pasta");
  assert.equal(supabase.tables.trays.length, 0, "the tray is empty");
  assert.equal(supabase.objects.size, 0, "the staged photo is gone");
  assert.deepEqual(out.cards.map((c) => [c.slug, c.publishing]), [["test-pasta", true]]);
  assert.match(out.summary, /Saved 2 changes/);
  const convo = await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json();
  const last = convo.messages.at(-1);
  assert.match(last.content, /Saved 2 changes/);
  assert.equal(last.cards[0].publishing, true, "the panel shows it as Publishing until the page is live");
  assert.equal((await plan()), null);
});

test("Save needs a fresh token AND EDITORS: no token 401, expired 401, a non-editor 403, an editor removed from the list 403, and nothing is committed", async () => {
  await stagedPastaAndList();
  const apply = (token) => call("POST", "/chat/plan/apply", { token, body: {} });
  assert.equal((await apply(undefined)).status, 401);
  assert.equal((await apply("nope")).status, 401);
  assert.equal((await apply("stranger-token")).status, 403);
  supabase.expire("partner-token");
  assert.equal((await apply("partner-token")).status, 401, "a token that expired mid-session means signing in again");
  config.shoppingEditors = ["partner@example.com"]; // the owner is taken off the list while their session is still valid
  assert.equal((await apply("owner-token")).status, 403, "removal takes effect at once");
  assert.equal(github.commitLog.length, 0);
  assert.equal(supabase.tables.trays[0].items.length, 2, "the tray is untouched");
  config.shoppingEditors = ["owner@example.com"];
  assert.equal((await apply("owner-token")).status, 200, "an editor who is on the list can");
});

test("a visitor's request body can't Save: forged roles are ignored (the token decides)", async () => {
  await stagedPastaAndList();
  const res = await call("POST", "/chat/plan/apply", { body: { role: "editor", caller: { role: "editor" } } });
  assert.equal(res.status, 401);
  assert.equal(github.commitLog.length, 0);
});

test("Save is refused while the list is missing or out of date: any later change to the tray marks it out of date (hash of the items)", async () => {
  await stagedPastaAndList();
  let t = await plan();
  assert.equal(t.can_save, true);
  const before = trayRow().list_hash;
  // add another change to the tray after the list was built
  const slug = anySlug(3);
  await say("add this to next week", { page: pageOf(slug) });
  t = await plan();
  assert.equal(t.list_current, false, "the list is out of date now");
  assert.equal(t.can_save, false);
  assert.equal(t.state, "collecting");
  assert.equal(t.needs_list, true);
  assert.equal(trayRow().list_hash, before, "the stored hash is of the older items");
  const list = t.items.find((i) => i.kind === "list");
  assert.equal(list.sub, "Out of date");
  const res = await call("POST", "/chat/plan/apply", { token: "owner-token", body: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Finalise the list first/);
  assert.equal(github.commitLog.length, 0);
  // finalising again makes it current
  await say("ignored", { action: "finalise" });
  t = await plan();
  assert.equal(t.list_current, true);
  assert.equal(t.can_save, true);
});

test("a tray that doesn't change next week needs no list: Save is available straight away", async () => {
  const slug = anySlug();
  setFlag(slug, "draft: true");
  const { conversation_id } = await say("hello", {});
  await tools.dispatch("stage_promote_recipe", { slug }, tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER }), { chat: { emit() {} } });
  const t = await plan();
  assert.equal(t.needs_list, false);
  assert.equal(t.can_save, true);
  assert.equal(t.state, "ready");
  const finalise = await call("POST", "/chat", { token: "owner-token", body: { action: "finalise", conversation_id, page: {} } });
  assert.equal(finalise.status, 409, "no Finalise when no list is needed");
  await finalise.text();
  const res = await call("POST", "/chat/plan/apply", { token: "owner-token", body: {} });
  assert.equal(res.status, 200);
  assert.doesNotMatch(github.files.get(recipePath(slug)).toString(), /draft: true/);
  assert.equal(github.commitLog.length, 1);
});

// --- Save now ----------------------------------------------------------------------------------------------------------------

test("Save now: a quick fix commits alone; new recipes and next-week changes can't be saved on their own; ingredient edits to a next-week recipe wait", async () => {
  const slug = anySlug(1);
  const other = anySlug(2);
  setFlag(other, "next: true");
  await say("it's 35 minutes", { page: pageOf(slug) });
  await say("add a new recipe: test pasta");
  const ed = tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER });
  await tools.dispatch("stage_update_recipe", { slug: other, ingredients: [{ quantity: "1", name: "egg" }] }, ed, { chat: { emit() {} } });
  let t = await plan();
  const byKind = (kind, s) => t.items.find((i) => i.kind === kind && (!s || i.recipe?.url.includes(s)));
  const fix = byKind("edit", slug);
  assert.equal(fix.save_now, true, "time is a quick fix");
  assert.equal(byKind("new").save_now, false);
  assert.equal(byKind("edit", other).save_now, false, "ingredients of a next-week recipe change the list");

  const refused = await call("POST", "/chat/plan/apply", { token: "owner-token", body: { item_id: byKind("new").id } });
  assert.equal(refused.status, 409);
  assert.equal(github.commitLog.length, 0);

  const res = await call("POST", "/chat/plan/apply", { token: "owner-token", body: { item_id: fix.id } });
  assert.equal(res.status, 200);
  assert.equal(github.commitLog.length, 1);
  assert.deepEqual(github.commitLog[0].paths, [recipePath(slug)], "just that item");
  assert.match(github.files.get(recipePath(slug)).toString(), /total_mins: 35/);
  t = await plan();
  assert.equal(t.count, 2, "the rest of the tray waits");
  assert.ok(!t.items.some((i) => i.id === fix.id));
});

// --- clashes -------------------------------------------------------------------------------------------------------------------

test("a clash (the recipe changed on the site since staging) stops Save: nothing committed, the card flagged, and the bot resolves it", async () => {
  const slug = anySlug(1);
  await say("it's 35 minutes", { page: pageOf(slug) });
  // someone changes the same recipe elsewhere (e.g. through the MCP)
  github.files.set(recipePath(slug), Buffer.from(github.files.get(recipePath(slug)).toString().replace(/total_mins: \d+/, "total_mins: 20")));
  clearCache();
  const res = await call("POST", "/chat/plan/apply", { token: "owner-token", body: {} });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.clash.length, 1);
  assert.match(body.clash[0].reason, /changed on the site since this was staged/);
  assert.match(body.clash[0].details[0], /total_mins: you set 35, the site now has 20/);
  assert.equal(github.commitLog.length, 0, "nothing committed");
  const t = await plan();
  assert.match(t.items[0].clash.reason, /changed on the site/);
  assert.equal(t.can_save, false);
  assert.equal(t.items[0].save_now, false);

  // the bot is told about it (the tray note) and resolves it with chips: Keep yours
  const { conversation_id } = await say("there was a clash, help me resolve it");
  const q = openrouter.requests.at(-1).messages;
  assert.ok(JSON.stringify(q).includes("CLASH"), "the model's note carries the clash");
  await say("Keep yours", { conversation_id });
  assert.equal((await plan()).items[0].clash, null, "kept yours: rebased on the site's version");
  const again = await call("POST", "/chat/plan/apply", { token: "owner-token", body: {} });
  assert.equal(again.status, 200);
  assert.match(github.files.get(recipePath(slug)).toString(), /total_mins: 35/, "yours overwrote theirs");
});

test("a clash resolved with Keep theirs / Drop it removes the item", async () => {
  const slug = anySlug(1);
  await say("it's 35 minutes", { page: pageOf(slug) });
  github.files.set(recipePath(slug), Buffer.from(github.files.get(recipePath(slug)).toString().replace(/total_mins: \d+/, "total_mins: 20")));
  clearCache();
  await call("POST", "/chat/plan/apply", { token: "owner-token", body: {} });
  const { conversation_id } = await say("there was a clash, help me resolve it");
  await say("Keep theirs", { conversation_id });
  assert.equal(await plan(), null);
  assert.equal(github.commitLog.length, 0);
});

test("an editor's turn carries on when the panel drops the stream (a phone switching apps): the answer and the tray change are stored, ended_turns says so", async () => {
  openrouter = createMockOpenRouter({ delayMs: 10 }); // slow enough that the stream is dropped mid-turn
  const res = await call("POST", "/chat", { token: "owner-token", body: { message: "add a new recipe: test pasta", page: { page: "index" } } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const meta = JSON.parse(first.match(/^event: meta\ndata: (.*)$/m)[1]);
  await reader.cancel(); // the browser went away
  await background.backgroundIdle();
  assert.equal((await plan()).count, 1, "the staged recipe is in the tray");
  const convo = await (await call("GET", `/chat/conversations/${meta.conversation_id}`, { token: "owner-token" })).json();
  assert.deepEqual(convo.ended_turns, { [meta.turn_id]: null }, "the turn ended with an answer");
  assert.ok(convo.messages.some((m) => m.role === "assistant" && m.turn_id === meta.turn_id && m.content), "the answer was saved");
});

test("an editor's turn that failed leaves a marker the panel can find, which the model never sees", async () => {
  const { conversation_id } = await say("mock-402");
  const convo = await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json();
  const [[, err]] = Object.entries(convo.ended_turns);
  assert.equal(typeof err, "string");
  assert.ok(err.length > 0, "the error the panel showed");
  assert.ok(!convo.messages.some((m) => m.role === "assistant"), "nothing to show in the chat itself");
  const { historyForModel, getMessages } = store;
  assert.ok(!historyForModel(await getMessages(conversation_id)).some((m) => m.role === "assistant"));
});

test("a Finalise turn that never ended (its function was killed) doesn't leave the tray without its button for good", async () => {
  await say("add a new recipe: test pasta");
  assert.equal((await plan()).state, "collecting");
  const row = trayRow();
  row.status = "finalising"; // what a killed Finalise turn leaves behind: startFinalise ran, settleFinalise never did
  row.updated_at = new Date(clock).toISOString();
  assert.equal((await plan()).state, "finalising", "while a turn could still be running, the button waits");
  clock += tray.FINALISE_STALE_MS + 1000;
  const t = await plan();
  assert.equal(t.state, "collecting", "past any turn's lifetime the flag no longer counts");
  assert.equal(tray.trayAction(t), "finalise_plan", "Finalise list is offered again");
});

// --- Finalise: asks to promote when next week has recipes ----------------------------------------------------------------------------

test("Finalise asks 'Is it ready to become this week?' when next week has recipes; 'Not yet' stages nothing and leaves the tray as it was", async () => {
  const nextOne = anySlug(4);
  setFlag(nextOne, "next: true");
  const { conversation_id } = await say("add a new recipe: test pasta");
  const fin = await say("x", { conversation_id, action: "finalise" });
  const q = fin.evs.find((e) => e.name === "question").data;
  assert.match(q.question, /Next week has 1 recipe\. Is it ready to become this week\?/);
  assert.deepEqual(q.options, ["Promote it", "Not yet"]);
  assert.equal((await plan()).state, "collecting", "no list was built");
  const not = await say("Not yet", { conversation_id });
  assert.match(not.evs.filter((e) => e.name === "text").map((e) => e.data.delta).join(""), /nothing changes/i);
  const t = await plan();
  assert.deepEqual(t.items.map((i) => i.kind), ["new"], "nothing staged, the tray as it was");
  assert.equal(github.commitLog.length, 0);
});

test("Finalise > Promote it: the server stages the switch and shows ONE review card (no model call); Done stages every answer at once, the model builds the list; Save applies them in one commit", async () => {
  const nextOne = anySlug(4);
  const draft = anySlug(5);
  setFlag(nextOne, "next: true");
  setFlag(draft, "current: true\ndraft: true");
  const { conversation_id } = await say("add a new recipe: test pasta");
  await say("x", { conversation_id, action: "finalise" });
  const calls = openrouter.requests.length;
  let r = await say("Promote it", { conversation_id });
  assert.equal(openrouter.requests.length, calls, "Promote it needs no model call");
  const card = r.evs.find((e) => e.name === "review").data;
  assert.deepEqual(card.drafts.map((d) => d.slug), [draft]);
  assert.equal(card.drafts[0].answer, undefined, "no thumb yet");
  assert.ok(!r.evs.some((e) => e.name === "question"), "no per-draft question");
  assert.deepEqual((await plan()).items.map((i) => i.kind), ["switch", "new"], "the switch is staged at once");
  const convo = await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json();
  assert.deepEqual(convo.messages.at(-1).review.drafts.map((d) => d.slug), [draft], "the card is stored with the turn");

  r = await say("ignored", { conversation_id, action: "review_drafts", answers: { [draft]: "liked" } });
  const user = (await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json()).messages.filter((m) => m.role === "user").at(-1);
  assert.match(user.content, /^Liked: /, "the answers are the editor's message, in words");
  const text = r.evs.filter((e) => e.name === "text").map((e) => e.data.delta).join("");
  assert.match(text, /In the tray: the switch to a new week\. .+ becomes a regular recipe\./);
  const t = await plan();
  assert.deepEqual(t.items.map((i) => i.kind), ["switch", "promote", "new", "list"], "Save order: switch, drafts, new, list");
  assert.equal(t.state, "ready");
  assert.equal(t.can_save, true);
  const res = await call("POST", "/chat/plan/apply", { token: "owner-token", body: { conversation_id } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(github.commitLog.length, 1);
  const files = Object.fromEntries([nextOne, draft, "test-pasta"].map((s) => [s, github.files.get(recipePath(s)).toString()]));
  assert.match(files[nextOne], /current: true/, "next week became this week");
  assert.doesNotMatch(files[nextOne], /next: true/);
  assert.doesNotMatch(files[draft], /draft: true/, "the liked draft was promoted");
  assert.doesNotMatch(files[draft], /current: true/, "and left this week");
  assert.match(files["test-pasta"], /next: true/, "the new recipe is in the fresh next week");
});

test("the review card: thumbs up promotes, thumbs down removes, no thumb keeps it for the coming week; a draft also in next week is kept; a second Done is refused", async () => {
  const [nextOne, a, b, c, e] = [0, 1, 2, 3, 5].map((n) => anySlug(n));
  setFlag(nextOne, "next: true");
  for (const s of [a, b, c]) setFlag(s, "current: true\ndraft: true");
  setFlag(e, "current: true\nnext: true\ndraft: true");
  const { conversation_id } = await say("add a new recipe: test pasta");
  await say("x", { conversation_id, action: "finalise" });
  const r = await say("yes", { conversation_id });
  const card = r.evs.find((ev) => ev.name === "review").data;
  assert.equal(card.drafts.length, 4);
  assert.equal(card.drafts.find((x) => x.slug === e).also_next, true);

  // only thumbs are answers; photos and a non-object are refused before anything is stored
  const bad = (body) => call("POST", "/chat", { token: "owner-token", body: { conversation_id, action: "review_drafts", page: { page: "index" }, ...body } });
  assert.equal((await bad({ answers: { [a]: "keep" } })).status, 400);
  assert.equal((await bad({ answers: { [a]: "book" } })).status, 400);
  assert.equal((await bad({ answers: "liked" })).status, 400);
  const answers = { [a]: "liked", [b]: "remove", [e]: "remove", "not-a-draft": "remove" }; // c: no thumb
  assert.equal((await call("POST", "/chat", { token: "partner-token", body: { conversation_id, action: "review_drafts", answers, page: {} } })).status, 404, "someone else's chat");

  const done = await say("x", { conversation_id, action: "review_drafts", answers });
  const text = done.evs.filter((ev) => ev.name === "text").map((ev) => ev.data.delta).join("");
  assert.match(text, /stays? for the coming week/);
  assert.match(text, /stays: it's on next week's plan/);
  const user = (await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json()).messages.filter((m) => m.role === "user").at(-1);
  assert.match(user.content, /^Liked: .+\. Not for us: .+\. Kept for the coming week: .+\.$/);
  const items = trayRow().items;
  assert.deepEqual(items.filter((i) => i.kind === "promote").map((i) => i.op.slug), [a]);
  assert.deepEqual(items.filter((i) => i.kind === "remove").map((i) => i.op.slug), [b], "only the draft that isn't planned for next week is removed");
  assert.deepEqual(items.find((i) => i.kind === "switch").op.carry_over, [c], "the draft with no thumb is carried over (the one also in next week needs no carry-over)");

  assert.equal((await bad({ answers })).status, 409, "answered once only");
  assert.equal(github.commitLog.length, 0, "nothing commits before Save");
});

test("Done with no thumbs at all keeps every draft for the coming week", async () => {
  const [nextOne, a, b] = [0, 1, 2].map((n) => anySlug(n));
  setFlag(nextOne, "next: true");
  setFlag(a, "current: true\ndraft: true");
  setFlag(b, "current: true\ndraft: true");
  const { conversation_id } = await say("add a new recipe: test pasta");
  await say("x", { conversation_id, action: "finalise" });
  await say("Promote it", { conversation_id });
  await say("x", { conversation_id, action: "review_drafts", answers: {} });
  const items = trayRow().items;
  assert.deepEqual([...items.find((i) => i.kind === "switch").op.carry_over].sort(), [a, b].sort());
  assert.ok(!items.some((i) => i.kind === "promote" || i.kind === "remove"));
});

test("the review card replaces earlier answers in the tray, starts on them, and the model can show it with review_drafts", async () => {
  const [nextOne, a, b] = [0, 1, 2].map((n) => anySlug(n));
  setFlag(nextOne, "next: true");
  setFlag(a, "current: true\ndraft: true");
  setFlag(b, "current: true\ndraft: true");
  const { reviewCard, thisWeeksDrafts, parseAnswers, answersText, reviewOpen, isPromoteIt } = await import("../lib/draft-review.js");
  const caller = tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER });
  await tray.stageMany([{ action: "start_next_week", carry_over: [a] }, { action: "promote_recipe", slug: b }], caller);
  const drafts = await thisWeeksDrafts();
  const card = reviewCard(drafts, trayRow().items);
  assert.deepEqual(Object.fromEntries(card.drafts.map((d) => [d.slug, d.answer])), { [a]: undefined, [b]: "liked" }, "the card starts on the thumbs the tray holds");
  assert.equal(reviewCard([], []), null);
  const { answers } = parseAnswers({ [a]: "liked" }, drafts);
  assert.match(answersText(drafts, answers), /^Liked: .+\. Kept for the coming week: .+\.$/);
  const { stageReview } = await import("../lib/draft-review.js");
  await stageReview(drafts, answers, caller);
  const items = trayRow().items;
  assert.deepEqual(items.filter((i) => i.kind === "promote").map((i) => i.op.slug), [a], "b's thumb was taken back (kept), a is promoted");
  assert.deepEqual(items.find((i) => i.kind === "switch").op.carry_over, [b], "b is carried over, a no longer is");
  assert.equal(items.filter((i) => i.kind === "switch").length, 1);
  assert.ok(reviewOpen([{ role: "user" }, { role: "assistant", content: { content: "x", ui: { review: card } } }]));
  assert.ok(!reviewOpen([{ role: "assistant", content: { ui: { review: card } } }, { role: "user" }]));
  for (const yes of ["Promote it", "promote it.", "Yes", "yes please", "Go ahead"]) assert.ok(isPromoteIt(yes), yes);
  for (const no of ["Not yet", "yes but add soup", ""]) assert.ok(!isPromoteIt(no), no);
});

test("asking to save while collecting: the bot explains and offers Finalise list / Not yet chips (it never saves)", async () => {
  await say("add a new recipe: test pasta");
  const r = await say("ok save it");
  const chips = r.evs.find((e) => e.name === "suggestions").data.replies;
  assert.deepEqual(chips, [{ label: "Finalise list", action: "finalise_plan" }, "Not yet"]);
  assert.equal(github.commitLog.length, 0);
});

test("the action chips for Save / Finalise exist only for editors: a visitor's suggest_replies drops them", async () => {
  const { cleanReplyList } = await import("../lib/chat-ui.js");
  assert.deepEqual(cleanReplyList([{ label: "Save to site", action: "apply_plan" }, "Ok"], new Map()), ["Ok"]);
  assert.deepEqual(cleanReplyList([{ label: "Save to site", action: "apply_plan" }, { label: "Evil", action: "drop_all" }], new Map(), { editor: true }), [{ label: "Save to site", action: "apply_plan" }]);
});

test("ask_user: solid options, multi, shown once, stored with the turn and returned with the chat", async () => {
  const { cleanQuestion } = await import("../lib/chat-ui.js");
  assert.equal(cleanQuestion({ question: " Which? ", options: ["A", "a", "x".repeat(40)] }), null, "needs two distinct usable options");
  assert.deepEqual(cleanQuestion({ question: "Which?", options: ["A", "a", "B"], multi: true }), { question: "Which?", options: ["A", "B"], multi: true });
  const nextOne = anySlug(4);
  setFlag(nextOne, "next: true");
  const { conversation_id } = await say("add a new recipe: test pasta");
  await say("x", { conversation_id, action: "finalise" });
  const convo = await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json();
  assert.deepEqual(convo.messages.at(-1).question.options, ["Promote it", "Not yet"]);
});

// --- expiry -------------------------------------------------------------------------------------------------------------------

test("a tray expires 7 days after its first item: touching it later deletes the items and their staged photos", async () => {
  await say("add a new recipe: test pasta");
  assert.equal(supabase.objects.size, 1);
  clock += 6 * 86400_000;
  assert.equal((await plan()).count, 1, "still there on day 6");
  clock += 2 * 86400_000;
  assert.equal(await plan(), null, "gone on day 8");
  assert.equal(supabase.tables.trays.length, 0);
  assert.equal(supabase.objects.size, 0, "its photo went too");
  // the next item starts a fresh 7-day tray
  await say("add a new recipe: second pasta");
  assert.ok(Math.abs(Date.parse(trayRow().expires_at) - clock - 7 * 86400_000) < 5000);
  assert.equal(trayRow().items.length, 1);
});

// --- dropping, photos --------------------------------------------------------------------------------------------------------------

test("dropping an item removes it and its photo; dropping the last item empties the tray; New photo remakes it", async () => {
  await say("add a new recipe: test pasta");
  let t = await plan();
  const id = t.items[0].id;
  const before = images.requests.length;
  assert.equal((await call("POST", `/chat/plan/items/${id}/photo`, { token: "owner-token" })).status, 200);
  await background.backgroundIdle();
  assert.equal(images.requests.length, before + 1, "regenerated");
  assert.equal((await plan()).items[0].photo.status, "ready");
  assert.equal((await call("DELETE", `/chat/plan/items/${id}`, { token: "partner-token" })).status, 200, "the other editor can drop it: the tray is the household's");
  assert.equal(await plan(), null);
  assert.equal(supabase.objects.size, 0);
  assert.equal((await call("DELETE", `/chat/plan/items/${id}`, { token: "owner-token" })).status, 404);
  assert.equal((await call("DELETE", "/chat/plan/items/not-an-id", { token: "owner-token" })).status, 404);
});

test("both editors see and add to the same tray", async () => {
  await say("add a new recipe: test pasta", { token: "owner-token" });
  await say("add a new recipe: second pasta", { token: "partner-token" });
  const t = await plan("partner-token");
  assert.deepEqual(t.items.map((i) => [i.title, i.added_by]).sort(), [["Second Pasta", "Partner"], ["Test Pasta", "Owner"]]);
  assert.equal(supabase.tables.trays.length, 1);
});

test("the tray endpoints are editors-only: 401 without or with a bad token, 403 for a signed-in non-editor", async () => {
  await say("add a new recipe: test pasta");
  const id = trayRow().items[0].id;
  for (const [method, path, body] of [["GET", "/chat/plan"], ["DELETE", `/chat/plan/items/${id}`], ["POST", `/chat/plan/items/${id}/photo`], ["POST", "/chat/plan/apply", {}], ["GET", "/chat/status?slugs=a"]]) {
    assert.equal((await call(method, path, { body })).status, 401, `${method} ${path} without a token`);
    assert.equal((await call(method, path, { token: "nope", body })).status, 401, `${method} ${path} with a bad token`);
    assert.equal((await call(method, path, { token: "stranger-token", body })).status, 403, `${method} ${path} as a non-editor`);
  }
  assert.equal(trayRow().items.length, 1, "nothing was touched");
  assert.equal(github.commitLog.length, 0);
});

test("the tray table and the photo bucket are server-only: the anon key reads neither", async () => {
  await say("add a new recipe: test pasta");
  const rows = await supabase.fetch("https://sb.test/rest/v1/trays?select=*", { headers: { apikey: "anon-test", Authorization: "Bearer anon-test" } });
  assert.equal(rows.status, 401);
  const key = [...supabase.objects.keys()][0].replace("tray-photos/", "");
  const obj = await supabase.fetch(`https://sb.test/storage/v1/object/tray-photos/${key}`, { headers: { apikey: "anon-test", Authorization: "Bearer anon-test" } });
  assert.equal(obj.status, 401);
});

test("status: which pages are live yet (a server-side HEAD to the Pages URL for validated slugs)", async () => {
  const seen = [];
  pages = (url, init) => { seen.push([init.method, url]); return new Response(null, { status: url.endsWith("/a-b.html") ? 200 : 404 }); };
  const res = await call("GET", "/chat/status?slugs=a-b,c-d,../etc/passwd", { token: "owner-token" });
  assert.deepEqual((await res.json()).live, { "a-b": true, "c-d": false });
  assert.deepEqual(seen.map((s) => s[0]), ["HEAD", "HEAD"]);
  assert.ok(seen.every(([, u]) => u.startsWith("https://site.test/favourite-recipes/recipes/")));
});

// --- photos from a link: SSRF guard -----------------------------------------------------------------------------------------------

test("photo links: only public http(s); private, loopback, link-local and mapped addresses, odd ports and credentials are refused", async () => {
  for (const bad of ["http://127.0.0.1/a.jpg", "http://localhost/a.jpg", "http://10.0.0.5/x", "http://192.168.1.1/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/x", "http://[::ffff:7f00:1]/x", "http://[fe80::1]/x", "http://100.64.0.1/x", "ftp://example.com/a.jpg", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/a.jpg", "https://example.com:8443/a.jpg", "http://printer.local/x", "http://db.internal/x", "not a url"]) {
    await assert.rejects(() => photos.assertPublicUrl(bad), photos.UnsafeUrlError, bad);
  }
  assert.equal((await photos.assertPublicUrl("https://example.com/a.jpg")).hostname, "example.com");
  photos.deps.lookup = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }];
  await assert.rejects(() => photos.assertPublicUrl("https://rebind.example/a.jpg"), /isn't public/, "a name that resolves to a private address");
  photos.deps.lookup = async () => { throw new Error("ENOTFOUND"); };
  await assert.rejects(() => photos.assertPublicUrl("https://nope.example/a.jpg"), /couldn't be found/);
});

test("a redirect to a private address is refused, and a failed link falls back to a generated photo", async () => {
  const hits = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://recipes.example/")) {
      hits.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }
    return orig(url, init);
  };
  try {
    await assert.rejects(() => photos.photoFromLink("https://recipes.example/pasta"), /isn't public/);
    assert.deepEqual(hits, ["https://recipes.example/pasta"], "the private address was never fetched");
    const made = await photos.makePhoto({ title: "Test Pasta", ingredients: [{ name: "pasta" }], imageUrl: "https://recipes.example/pasta" });
    assert.equal(made.source, "generated");
    assert.match(made.note, /couldn't use the link's photo/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("a recipe page's og:image (or JSON-LD Recipe image) is found and used; the staged photo comes from the link, not from generation", async () => {
  assert.equal(photos.pageImageUrl('<meta property="og:image" content="/img/p.jpg">', "https://r.example/x/y"), "https://r.example/img/p.jpg");
  assert.equal(photos.pageImageUrl('<script type="application/ld+json">{"@graph":[{"@type":"Recipe","image":[{"url":"https://r.example/ld.jpg"}]}]}</script>', "https://r.example/"), "https://r.example/ld.jpg");
  assert.equal(photos.pageImageUrl("<p>nothing</p>", "https://r.example/"), null);
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c0a080" } }).jpeg().toBuffer();
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s === "https://r.example/pasta") return new Response('<meta property="og:image" content="https://r.example/p.jpg">', { headers: { "content-type": "text/html" } });
    if (s === "https://r.example/p.jpg") return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    return orig(url, init);
  };
  try {
    const ed = tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER });
    await tools.dispatch("stage_create_recipe", { title: "Linked Pasta", course: ["Dinner"], total_mins: 10, serves: 2, calories: 300, ingredients: [{ quantity: "100g", name: "pasta" }], instructions: ["Cook the **pasta**."], image_url: "https://r.example/pasta" }, ed, { chat: { emit() {} } });
    await background.backgroundIdle();
    const t = await plan();
    assert.equal(t.items[0].photo.status, "ready");
    assert.equal(images.requests.length, 0, "no generation: the link's photo was used");
    assert.equal(trayRow().items[0].photo.source, "link");
  } finally {
    globalThis.fetch = orig;
  }
});

// --- the migrations ---------------------------------------------------------------------------------------------------------------------

test("migrations: trays (one row, RLS, no policies, 7 days) and the private tray-photos bucket", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const sql = (re) => readFileSync(new URL(readdirSync(dir).find((f) => re.test(f)), dir), "utf8");
  const trays = sql(/_trays\.sql$/);
  assert.match(trays, /create table if not exists public\.trays/);
  assert.match(trays, /unique index if not exists trays_one_per_household on public\.trays \(\(true\)\)/);
  assert.match(trays, /interval '7 days'/);
  assert.match(trays, /alter table public\.trays enable row level security/);
  assert.match(trays, /revoke all on public\.trays from anon, authenticated/);
  assert.doesNotMatch(trays, /create policy/i);
  const bucket = sql(/tray_photos_bucket\.sql$/);
  assert.match(bucket, /'tray-photos', 'tray-photos', false/);
  assert.doesNotMatch(bucket, /create policy/i);
  assert.match(sql(/rate_limits_revoke\.sql$/), /revoke all on public\.rate_limits from anon, authenticated/);
});

test("Finalise with next week empty on the site: no promote question, no questions about this week's drafts, the list is built; the switch card names carried-over recipes", async () => {
  const draft = anySlug(0);
  setFlag(draft, "draft: true\ncurrent: true");
  const { conversation_id } = await say("add a new recipe: empty week pasta");
  const r = await say("x", { conversation_id, action: "finalise" });
  assert.ok(!r.evs.some((e) => e.name === "question"), "no question at all");
  const t = await plan();
  assert.ok(t.items.some((i) => i.kind === "list"), "the list is staged");
  assert.ok(!t.items.some((i) => ["switch", "promote", "remove"].includes(i.kind)), "nothing about this week");
  // the switch card lists what is carried over
  await tools.dispatch("stage_start_next_week", { carry_over: [draft] }, tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER }), { chat: { emit() {} } });
  const sw = (await plan()).items.find((i) => i.kind === "switch");
  assert.match(sw.sub, /^Carried over in this week: /);
});

test("the tray note says which of this week's drafts already have an answer staged, so a capped history can't make Finalise re-ask", async () => {
  const [a, b, c] = [anySlug(0), anySlug(1), anySlug(2)];
  for (const s of [a, b, c]) setFlag(s, "draft: true\ncurrent: true");
  const caller = tools.makeCaller({ role: "editor", email: "owner@example.com", userId: OWNER });
  const stage = (name, args) => tools.dispatch(name, args, caller, { chat: { emit() {} } });
  await stage("stage_start_next_week", { carry_over: [c] });
  await stage("stage_promote_recipe", { slug: a });
  const note = await tray.trayNote(await tray.loadTray(), caller);
  const line = note.split("\n").find((l) => l.startsWith("Finalise progress:"));
  assert.ok(line, note);
  assert.match(line, new RegExp(`${a}, liked: promote staged`));
  assert.match(line, new RegExp(`${c}, kept this week: carry-over staged`));
  assert.match(line, new RegExp(`not yet answered in the tray: .*${b}`));
  assert.doesNotMatch(line.split("not yet answered")[1].split("(one answered")[0], new RegExp(`${a}|${c}`));
  // no switch staged: no progress line
  supabase.tables.trays.length = 0;
  assert.doesNotMatch(await tray.trayNote(await tray.loadTray(), caller), /Finalise progress/);
});

test("'Not yet' to the promote question is answered by the server: nothing staged, no model call, tray back to collecting, a Finalise chip", async () => {
  const [a] = [anySlug(0)];
  setFlag(a, "next: true");
  const { conversation_id } = await say("add a new recipe: not yet pasta");
  const first = await say("x", { conversation_id, action: "finalise" });
  assert.match(first.evs.find((e) => e.name === "question").data.question, /ready to become this week/);
  const before = openrouter.requests.length;
  const before_items = (await plan()).items.length;
  for (const word of ["Not yet", "not yet.", "No"]) {
    // each time the question is the newest thing in the chat
    const r = word === "Not yet" ? await say(word, { conversation_id }) : null;
    if (!r) continue;
    assert.equal(openrouter.requests.length, before, "the model wasn't called");
    assert.match(r.evs.filter((e) => e.name === "text").map((e) => e.data.delta).join(""), /next week stays as it is/);
    const chips = r.evs.find((e) => e.name === "suggestions")?.data.replies || [];
    assert.deepEqual(chips, [{ label: "Finalise list", action: "finalise_plan" }]);
    assert.equal(r.evs.at(-1).name, "done");
  }
  const t = await plan();
  assert.equal(t.items.length, before_items, "nothing was staged");
  assert.equal(t.state, "collecting");
  // a typed equivalent works the same; an unrelated message goes to the model as usual
  const { isNotYet } = await import("../lib/shortcuts.js");
  for (const yes of ["Not yet", "not yet.", "No", "nope", "Not now", "later"]) assert.ok(isNotYet(yes), yes);
  for (const no of ["not yet, but add soup", "yes", "Promote it", ""]) assert.ok(!isNotYet(no), no);
  const msgs = (await (await call("GET", `/chat/conversations/${conversation_id}`, { token: "owner-token" })).json()).messages;
  assert.equal(msgs.at(-1).content.startsWith("OK, next week stays as it is"), true, "the answer is in the stored chat");
});

test("a turn that staged something but said nothing gets a one-line confirmation built from the staged item, and chips", async () => {
  const slug = anySlug(1);
  const { evs } = await say("mock-silent-edit", { page: pageOf(slug) });
  const text = evs.filter((e) => e.name === "text").map((e) => e.data.delta).join("");
  const { data } = await (await import("../lib/recipes.js")).getRecipe(slug);
  assert.equal(text, `Added to the tray: ${data.title} — new time.`);
  const chips = evs.find((e) => e.name === "suggestions")?.data.replies;
  assert.ok(chips?.length >= 1, "chips follow");
  assert.equal(evs.at(-1).name, "done");
});
