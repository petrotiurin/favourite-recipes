// Reading several recipe photos at once (docs/parallel-photo-reading.md): a separate vision model reads them in the background on a Postgres
// queue, neighbouring screenshots are grouped, the report arrives as a note from the site and a follow-up turn stages from it with from_photo.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { clearCache } from "../lib/cache.js";

Object.assign(process.env, {
  GITHUB_TOKEN: "gh-test", MCP_AUTH_TOKEN: "secret", PUBLIC_SITE_URL: "https://site.test/favourite-recipes", SUPABASE_URL: "https://sb.test",
  SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", EDITORS: "owner@example.com,sam.smith@example.com", OPENROUTER_CHAT_PUBLIC_KEY: "or-public-test",
  OPENROUTER_CHAT_EDITOR_KEY: "or-editor-test", OPENROUTER_API_KEY: "or-image-test", CHAT_PUBLIC_HOURLY_LIMIT: "100000", CHAT_EDITOR_HOURLY_LIMIT: "100000",
  CHAT_EDITOR_DAILY_LIMIT: "100000", CHAT_PUBLIC_TOTAL_HOURLY_LIMIT: "100000", CHAT_VISION_MODEL: "vision/test-model", OPENROUTER_CHAT_VISION_KEY: "or-vision-test", CHAT_VISION_SETTLE_MS: "0",
});
const { createFakeGitHub, createMockOpenRouter, createFakeSupabase, createFakeImageApi, fakeRead } = await import("../scripts/fakes.js");
let github, openrouter, supabase, images;
const realFetch = globalThis.fetch;
let chat, tools, config, background, queue, reader, store, followUp, internalHits;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return github.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/chat/completions") return openrouter.fetch(s, init);
    if (s === "https://openrouter.ai/api/v1/images") return images.fetch(s, init);
    if (s.startsWith("https://sb.test/")) return supabase.fetch(s, init);
    if (s.startsWith("https://mcp.test/chat/internal/")) {
      // the server calling its own internal route: through the real handler, like Vercel would
      internalHits.push(s);
      const route = s.replace("https://mcp.test/chat/", "");
      return chat.POST(new Request(`https://mcp.test/api/chat?route=${route}`, { method: "POST", headers: init.headers, body: init.body }));
    }
    return realFetch(url, init);
  };
  chat = await import("../api/chat.js");
  tools = await import("../lib/tools.js");
  background = await import("../lib/background.js");
  queue = await import("../lib/photo-queue.js");
  reader = await import("../lib/photo-reader.js");
  store = await import("../lib/chat-store.js");
  followUp = await import("../lib/follow-up.js");
  ({ config } = await import("../lib/config.js"));
  queue.deps.sleep = () => new Promise((r) => setImmediate(r));
});
const OWNER = "00000000-0000-4000-8000-0000000000e1";
const SAM = "00000000-0000-4000-8000-0000000000e2";
const STRANGER = "00000000-0000-4000-8000-0000000000a1";
const caller = (who = "owner") => tools.makeCaller(who === "sam" ? { role: "editor", email: "sam.smith@example.com", userId: SAM } : { role: "editor", email: "owner@example.com", userId: OWNER });
const solid = (color) => sharp({ create: { width: 900, height: 1200, channels: 3, background: color } }).jpeg().toBuffer();
const asUrl = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;
const RED = "#c03020";
const GREEN = "#40a040";
const BLUE = "#3050c0";
const GREY = "#808080";
const YELLOW = "#e0c020";
let reads; // colour -> reader answer (the default when nothing matches is a whole recipe picked by colour)
beforeEach(() => {
  clearCache();
  github = createFakeGitHub({ clean: true });
  openrouter = createMockOpenRouter({ delayMs: 0 });
  images = createFakeImageApi();
  internalHits = [];
  supabase = createFakeSupabase({
    url: "https://sb.test", anonKey: "anon-test", serviceKey: "service-test",
    users: { "owner-token": { id: OWNER, email: "owner@example.com" }, "sam-token": { id: SAM, email: "sam.smith@example.com" }, "stranger-token": { id: STRANGER, email: "stranger@example.com" } },
  });
  config.shoppingEditors = ["owner@example.com", "sam.smith@example.com"];
  config.supabaseServiceKey = "service-test";
  config.chatVisionModel = "vision/test-model";
  config.chatVisionConcurrency = 8;
  config.chatInternalSecret = "";
  config.chatInternalUrl = "";
  reads = {};
  openrouter.readerFor = ({ colours, consecutive }) => (consecutive ? reads[`together:${colours.join(",")}`] : reads[colours[0]]) || null;
});
let ip = 0;
const post = (body, token = "owner-token") =>
  chat.POST(new Request("https://mcp.test/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
const get = (route, token = "owner-token") => chat.GET(new Request(`https://mcp.test/api/chat?route=${route}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `198.51.100.${++ip % 250}` } }));
async function events(res) {
  const out = [];
  for (const block of (await res.text()).split("\n\n").filter(Boolean)) out.push({ name: block.match(/^event: (.*)$/m)[1], data: JSON.parse(block.match(/^data: (.*)$/m)[1]) });
  return out;
}
const say = async (message, extra = {}, token = "owner-token") => {
  const res = await post({ message, page: { page: "index" }, ...extra }, token);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json().catch(() => "")));
  const evs = await events(res);
  await background.backgroundIdle();
  return { evs, conversation_id: evs.find((e) => e.name === "meta")?.data.conversation_id, text: evs.filter((e) => e.name === "text").map((e) => e.data.delta).join("") };
};
const trayItems = () => supabase.tables.trays[0]?.items || [];
const notes = (conv) => supabase.tables.messages.filter((m) => m.conversation_id === conv && m.role === "event");
const colourKey = async (color) => {
  // the colour the mock reader sees after the server re-encodes the photo
  const { channels } = await sharp(await sharp(await solid(color)).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer()).stats();
  return `#${channels.slice(0, 3).map((c) => (Math.round(c.mean / 16) * 16).toString(16).padStart(2, "0").slice(0, 2)).join("")}`;
};

// A long recipe scrolled over two screenshots: the first is cut off at the bottom, the second carries on at step 3 with the same line at the top.
const dalTop = fakeRead("Dal Makhani", { has_method: true, last_step: 2, cut_off_at_bottom: true, bottom_lines: ["2. Simmer the lentils and kidney beans for an hour, stirring now and then"], recipe: { instructions: ["Soak the **lentils**.", "Simmer the **lentils** for an hour."] } });
const dalBottom = fakeRead("", { has_title: false, has_ingredients: false, first_step: 3, last_step: 4, starts_mid_recipe: true, top_lines: ["2. Simmer the lentils and kidney beans for an hour, stirring now and then"], ingredient_names: [], step_ingredients: ["butter", "lentils"], recipe: { title: "", ingredients: [], instructions: ["Stir in the **butter**.", "Serve."] } });
const dalWhole = fakeRead("Dal Makhani", { recipe: { serves: 4, calories: 480 } });

// --- the whole flow ------------------------------------------------------------------------------------------------------------

test("six-ish photos: the model starts the read and ends its turn at once; the reader reads in parallel, joins scrolled screenshots, and the follow-up stages each recipe from_photo", async () => {
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  reads[await colourKey(GREEN)] = dalTop;
  reads[await colourKey(BLUE)] = dalBottom;
  reads[`together:${await colourKey(GREEN)},${await colourKey(BLUE)}`] = dalWhole;
  const { evs, conversation_id, text } = await say("add these for next week", { images: [asUrl(await solid(RED)), asUrl(await solid(GREEN)), asUrl(await solid(BLUE))] });
  // the user's turn: read_recipe_photos, a short line, done (it doesn't wait for the reads)
  assert.match(text, /reading your 3 photos/i);
  const firstTurn = openrouter.requests.filter((r) => r.messages.some((m) => m.role === "tool" && /"queued":3/.test(m.content)));
  assert.ok(firstTurn.length, "read_recipe_photos queued all three");
  assert.deepEqual(evs.find((e) => e.name === "photos").data.numbers, [1, 2, 3]);
  // the reader: three first-pass reads with ONE image each, then the joined pair once more, together
  const single = openrouter.readerRequests.filter((r) => r.messages[1].content.filter((p) => p.type === "image_url").length === 1);
  const together = openrouter.readerRequests.filter((r) => r.messages[1].content.filter((p) => p.type === "image_url").length === 2);
  assert.equal(single.length, 3);
  assert.equal(together.length, 1);
  assert.match(together[0].messages[1].content[0].text, /consecutive screenshots of ONE recipe/);
  // the report: a note from the site in the chat
  const [note] = notes(conversation_id);
  assert.ok(note, "the report is stored as an event message");
  assert.match(note.content.content, /photo-1: "Miso Aubergine" · serves 4 · 450 kcal \(estimated\) · 30 min · ok/);
  assert.match(note.content.content, /photo-2\+3: read together: "Dal Makhani" · serves 4 · 480 kcal/);
  assert.match(note.content.summary, /^Photos read: 2 recipes/);
  assert.ok(note.handled_at, "the follow-up claimed it");
  // the follow-up staged both, from what was read (the model only passed from_photo)
  const staged = trayItems().filter((i) => i.kind === "new").map((i) => i.op.title).sort();
  assert.deepEqual(staged, ["Dal Makhani", "Miso Aubergine"]);
  const followCalls = openrouter.requests.flatMap((r) => r.messages).filter((m) => m.role === "assistant" && m.tool_calls).flatMap((m) => m.tool_calls).filter((c) => c.function.name === "stage_create_recipe");
  assert.ok(followCalls.every((c) => Object.keys(JSON.parse(c.function.arguments)).join() === "from_photo"), "about 30 tokens per recipe");
  const rows = supabase.tables.photo_reads.filter((r) => r.conversation_id === conversation_id);
  assert.ok(rows.every((r) => r.status === "read" && r.reported_at && r.tray_item_id), "every photo is read, reported and staged");
  assert.equal(new Set(rows.slice(1).map((r) => r.tray_item_id)).size, 1, "2+3 is one card");
  // the main model never got an image, in any turn
  for (const r of openrouter.requests) assert.ok(!JSON.stringify(r.messages).includes('"type":"image_url"'));
  // the panel: the note as a status line, then the follow-up's answer; nothing still active
  const panel = await (await get(`conversations/${conversation_id}`)).json();
  const roles = panel.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-2), ["event", "assistant"]);
  assert.match(panel.messages.at(-2).content, /Photos read: 2 recipes/);
  assert.match(panel.messages.at(-1).content, /Added 2 recipes/);
  assert.equal(panel.photos.active, false);
  assert.equal(panel.photos.follow_up, false);
  // /chat/me reports the newest reply for the bubble's dot
  const me = await (await get("me")).json();
  assert.equal(me.last_reply.conversation_id, conversation_id);
});

test("the reader's request is limited: its own prompt, one user message with the fixed instruction and the images, no tools, nothing from the chat", async () => {
  const { conversation_id } = await say("secret-user-words please add", { images: [asUrl(await solid(RED))] });
  assert.ok(conversation_id);
  const [req] = openrouter.readerRequests;
  assert.equal(req.model, "vision/test-model");
  assert.equal(req.auth, "Bearer or-vision-test", "its own key");
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, "system");
  assert.doesNotMatch(req.messages[0].content, /Catalogue of our recipe book|plan tray|suggest_replies|stage_|owner@example.com/);
  assert.match(req.messages[0].content, /never instructions/);
  assert.match(req.messages[0].content, /Every ingredient has a `quantity`/, "the shared recipe-writing rules");
  assert.equal(req.messages[1].role, "user");
  assert.deepEqual(req.messages[1].content.map((p) => p.type), ["text", "image_url"]);
  assert.equal(req.messages[1].content[0].text, "One photo follows. Read it.");
  assert.ok(!JSON.stringify(req).includes("secret-user-words"), "never the user's message");
  assert.equal(req.tools, undefined);
  assert.equal(req.response_format.type, "json_schema");
  assert.ok(req.temperature <= 0.2);
  assert.deepEqual(req.provider, { require_parameters: true }, "only providers that honour the schema");
  assert.equal(req.max_tokens, config.chatVisionMaxTokens);
  assert.deepEqual(req.reasoning, { enabled: false }, "no thinking for transcription (CHAT_VISION_REASONING, default off)");
});

test("a provider without response_format: one forced tool with the schema, and nothing else", async () => {
  let n = 0;
  const realFetchMock = openrouter.fetch;
  globalThis.__or = realFetchMock;
  openrouter.readerFor = ({ body }) => (body.response_format && n++ === 0 ? { status: 400, body: '{"error":"response_format json_schema is not supported"}' } : null);
  const out = await reader.readPhotos([asUrl(await solid(RED))]);
  assert.equal(out.read.kind, "recipe");
  const last = openrouter.readerRequests.at(-1);
  assert.equal(last.tools.length, 1);
  assert.equal(last.tool_choice.function.name, "recipe_read");
  assert.equal(last.response_format, undefined);
});

test("one photo failing doesn't sink the others: a 503 or a malformed answer is retried once, then the photo is reported as unreadable", async (t) => {
  t.mock.method(console, "warn", () => {});
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  const g = await colourKey(GREEN);
  const y = await colourKey(YELLOW);
  let greenTries = 0;
  let yellowTries = 0;
  openrouter.readerFor = ({ colours }) => {
    if (colours[0] === g) return (greenTries++, { status: 503 });
    if (colours[0] === y) return (yellowTries++, "this is not json");
    return reads[colours[0]] || null;
  };
  const { conversation_id } = await say("add these", { images: [asUrl(await solid(RED)), asUrl(await solid(GREEN)), asUrl(await solid(YELLOW))] });
  assert.equal(greenTries, 2, "a 503 is tried twice");
  assert.equal(yellowTries, 2, "a malformed answer is tried once more (another provider), then given up");
  const content = notes(conversation_id)[0].content.content;
  assert.match(content, /photo-2: couldn't be read/);
  assert.match(content, /photo-3: couldn't be read \(the reader's answer didn't make sense\)/);
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Miso Aubergine"], "the good one is staged anyway");
});

// --- grouping -------------------------------------------------------------------------------------------------------------------

test("grouping: overlap alone joins, two signs join, one sign is unsure, a new title keeps them apart, only neighbours, user corrections win", () => {
  const r = (n, read, extra = {}) => ({ n, status: "read", result: read, ...extra });
  const whole = (t) => fakeRead(t);
  const { groupPhotos, pairDecision } = reader;
  assert.equal(pairDecision({ overlap: true, signals: [], newTitle: true }), "joined");
  assert.equal(pairDecision({ overlap: false, signals: ["cut_off", "next_step"], newTitle: false }), "joined");
  assert.equal(pairDecision({ overlap: false, signals: ["cut_off"], newTitle: false }), "unsure");
  assert.equal(pairDecision({ overlap: false, signals: ["cut_off"], newTitle: true }), "separate");
  assert.equal(pairDecision({ overlap: false, signals: [], newTitle: false }), "separate");
  // overlap: 2+3 joined; 1 and 4 whole recipes alone
  let g = groupPhotos([r(1, whole("Miso Aubergine")), r(2, dalTop), r(3, dalBottom), r(4, whole("Pea Soup"))]);
  assert.deepEqual(g.groups.map((x) => x.id), ["1", "2+3", "4"]);
  // neighbours only: the same pair with a photo between them is never joined automatically
  g = groupPhotos([r(1, dalTop), r(2, whole("Pea Soup")), r(3, dalBottom)]);
  assert.deepEqual(g.groups.map((x) => x.id), ["1", "2", "3"]);
  // one sign only (cut off, nothing else): unsure, kept apart, and the reason names what each lacks
  const cut = fakeRead("Tart", { cut_off_at_bottom: true, has_method: false, recipe: { instructions: [] } });
  const noTitle = fakeRead("", { has_title: false, first_step: 1 });
  g = groupPhotos([r(4, cut), r(5, noTitle)]);
  assert.deepEqual(g.groups.map((x) => x.id), ["4", "5"]);
  assert.equal(g.pairs[0].decision, "unsure");
  assert.match(g.pairs[0].why, /4 has no method, 5 has no title/);
  // the user's word: joined_to joins (even across a skipped photo), split_from_prev splits an overlap
  g = groupPhotos([r(4, cut), r(5, noTitle, { joined_to: 4 })]);
  assert.deepEqual(g.groups.map((x) => x.id), ["4+5"]);
  g = groupPhotos([r(1, dalTop), r(2, { kind: "recipe" }, { status: "skipped" }), r(3, dalBottom, { joined_to: 1 })]);
  assert.deepEqual(g.groups.map((x) => x.id), ["1+3"]);
  g = groupPhotos([r(2, dalTop), r(3, dalBottom, { split_from_prev: true })]);
  assert.deepEqual(g.groups.map((x) => x.id), ["2", "3"]);
  // a dish photo is never joined
  g = groupPhotos([r(1, dalTop), r(2, { ...dalBottom, kind: "dish" })]);
  assert.deepEqual(g.groups.map((x) => x.id), ["1", "2"]);
  assert.deepEqual(reader.parsePhotoId("photo-4+3"), [3, 4]);
  assert.equal(reader.parsePhotoId("photo-x"), null);
});

test("an unsure pair is asked about; 'Same recipe' joins them, they are read again together and staged as one card", async () => {
  const cut = fakeRead("Plum Tart", { cut_off_at_bottom: true, has_method: false, recipe: { instructions: [] } });
  const rest = fakeRead("", { has_title: false, has_ingredients: false, ingredient_names: [], step_ingredients: ["plum"], first_step: 1, recipe: { title: "", ingredients: [] } });
  reads[await colourKey(RED)] = cut;
  reads[await colourKey(GREEN)] = rest;
  reads[`together:${await colourKey(RED)},${await colourKey(GREEN)}`] = fakeRead("Plum Tart");
  const { conversation_id } = await say("add these", { images: [asUrl(await solid(RED)), asUrl(await solid(GREEN))] });
  const first = notes(conversation_id)[0].content.content;
  assert.match(first, /unsure: photo-1 and photo-2 may be one recipe \(1 has no method, 2 has no title/);
  assert.match(first, /photo-1: "Plum Tart"[^\n]*incomplete: no method/);
  assert.equal(trayItems().length, 0, "nothing incomplete is staged");
  const asked = supabase.tables.messages.filter((m) => m.role === "assistant").flatMap((m) => m.content.tool_calls || []).find((c) => c.function.name === "ask_user");
  assert.match(JSON.parse(asked.function.arguments).question, /Photos 1 and 2 may be one recipe/);
  await say("Same recipe", { conversation_id });
  const second = notes(conversation_id)[1].content.content;
  assert.match(second, /photo-1\+2: read together: "Plum Tart"[^\n]*· ok/);
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Plum Tart"]);
  const rows = supabase.tables.photo_reads;
  assert.equal(rows[1].joined_to, 1);
  assert.equal(rows[0].tray_item_id, rows[1].tray_item_id);
});

test("a photo that carries on an already staged one is joined and REPLACES its card, whatever its title", async () => {
  reads[await colourKey(RED)] = fakeRead("Dal", { cut_off_at_bottom: true, last_step: 2, bottom_lines: ["2. Simmer the lentils and kidney beans for an hour, stirring now and then"] });
  reads[await colourKey(GREEN)] = dalBottom;
  reads[`together:${await colourKey(RED)},${await colourKey(GREEN)}`] = dalWhole;
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(RED))] });
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Dal"]);
  await say("and the rest of it", { conversation_id, images: [asUrl(await solid(GREEN))] });
  const second = notes(conversation_id)[1].content.content;
  assert.match(second, /photo-1\+2 \(photo-2 carries on photo-1\): read together: "Dal Makhani"[^\n]*replaces its card/);
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Dal Makhani"], "the old card is gone");
});

test("skip: a photo still waiting is never read; a staged one has its card dropped", async () => {
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(RED))] });
  assert.equal(trayItems().length, 1);
  await say("skip photo 1", { conversation_id });
  assert.equal(trayItems().length, 0);
  assert.equal(supabase.tables.photo_reads[0].status, "skipped");
});

// --- from_photo -------------------------------------------------------------------------------------------------------------------

test("from_photo: other fields override what was read; another conversation's ids are 'not in this chat'; a photo still being read is refused", async () => {
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  const a = await say("keep it", { images: [asUrl(await solid(RED))] });
  supabase.tables.trays.length = 0;
  const chatCtx = (conversationId) => ({ chat: { emit() {}, conversationId, photos: [], userText: "" } });
  const ok = await tools.dispatch("stage_create_recipe", { from_photo: "photo-1", course: ["Lunch"], serves: 2 }, caller(), chatCtx(a.conversation_id));
  assert.ok(!ok.isError, ok.content[0].text);
  assert.match(ok.content[0].text, /estimated \(not in the photo\): calories/);
  const item = trayItems()[0];
  assert.deepEqual(item.op.course, ["Lunch"]);
  assert.equal(item.op.serves, 2);
  assert.equal(item.op.title, "Miso Aubergine");
  assert.equal(item.photo.status === "pending" || item.photo.status === "ready", true, "a photo is made (a screenshot isn't the recipe's photo)");
  // the same id from another of the owner's conversations (or anyone else's) resolves nothing
  const b = await say("hello");
  const other = await tools.dispatch("stage_create_recipe", { from_photo: "photo-1" }, caller(), chatCtx(b.conversation_id));
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /isn't a photo that was read in this chat/);
  const none = await tools.dispatch("stage_create_recipe", { from_photo: "photo-1" }, caller(), chatCtx(undefined));
  assert.equal(none.isError, true);
  // still reading
  supabase.tables.photo_reads[0].status = "reading";
  const busy = await tools.dispatch("stage_create_recipe", { from_photo: "photo-1" }, caller(), chatCtx(a.conversation_id));
  assert.match(busy.content[0].text, /still being read/);
  // without from_photo the old rules hold: every field is needed
  const bare = await tools.dispatch("stage_create_recipe", { title: "Bare" }, caller(), chatCtx(a.conversation_id));
  assert.equal(bare.isError, true);
  assert.match(bare.content[0].text, /Invalid arguments/);
});

// --- two editors -------------------------------------------------------------------------------------------------------------------

test("two editors: a recipe Sam already put in the tray is flagged in the report and refused unless keep_both; the tray shows what each has in flight", async () => {
  // Sam stages Miso Aubergine through their own chat first
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  await say("add this", { images: [asUrl(await solid(RED))] }, "sam-token");
  assert.equal(trayItems().length, 1);
  assert.equal(trayItems()[0].added_by.name, "Sam Smith");
  // the owner sends the same recipe (a different screenshot of it)
  reads[await colourKey(GREEN)] = fakeRead("Miso Aubergines");
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(GREEN))] });
  const content = notes(conversation_id)[0].content.content;
  assert.match(content, /looks like "Miso Aubergine" already in the tray \(added by Sam Smith\)/);
  assert.equal(trayItems().length, 1, "the follow-up didn't add a second card");
  const ctx = { chat: { emit() {}, conversationId: conversation_id, photos: [], userText: "" } };
  const refused = await tools.dispatch("stage_create_recipe", { from_photo: "photo-1" }, caller(), ctx);
  assert.match(refused.content[0].text, /Not staged[\s\S]*"duplicate_of":"[a-f0-9]{8}","added_by":"Sam Smith"/);
  const kept = await tools.dispatch("stage_create_recipe", { from_photo: "photo-1", keep_both: true }, caller(), ctx);
  assert.ok(!kept.isError);
  assert.equal(trayItems().length, 2);
  // grouping never crosses people: each conversation numbers its own photos from 1
  assert.deepEqual(supabase.tables.photo_reads.map((r) => r.n), [1, 1]);
  // reading entries: while the owner's photos are queued, Sam's tray strip says so (by name, never the photos)
  supabase.tables.photo_reads.push({ ...supabase.tables.photo_reads[1], id: crypto.randomUUID(), n: 2, path: `${conversation_id}/${crypto.randomUUID()}.jpg`, status: "queued", reported_at: null });
  const plan = await (await get("plan", "sam-token")).json();
  assert.deepEqual(plan.reading, [{ name: "Owner", count: 1, mine: false }]);
  const mine = await (await get("plan")).json();
  assert.deepEqual(mine.reading, [{ name: "Owner", count: 1, mine: true }]);
  assert.ok(!JSON.stringify(plan).includes(conversation_id), "nothing of the other chat");
});

test("a recipe already in the book is flagged and refused: add it to next week instead", async () => {
  const [slug] = [...github.files.keys()].filter((p) => p.startsWith("recipes/")).map((p) => p.slice(8, -3));
  const md = github.files.get(`recipes/${slug}.md`).toString();
  const title = md.match(/^title: (.*)$/m)[1].replace(/^["']|["']$/g, "");
  const names = [...md.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]).slice(0, 4);
  reads[await colourKey(RED)] = fakeRead(title, { recipe: { ingredients: names.map((name) => ({ quantity: "1", name, note: "" })) } });
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(RED))] });
  assert.match(notes(conversation_id)[0].content.content, new RegExp(`already in the book \\(${slug}\\)`));
  assert.equal(trayItems().length, 0);
});

// --- the queue ---------------------------------------------------------------------------------------------------------------------

async function seedPhotos(n, { user = caller() } = {}) {
  const convo = await store.createConversation({ userId: user.userId, title: "seeded" });
  const photos = [];
  for (let i = 1; i <= n; i++) {
    const path = `${convo.id}/${crypto.randomUUID()}.jpg`;
    supabase.objects.set(`chat-uploads/${path}`, { bytes: await solid(RED), type: "image/jpeg" });
    photos.push({ n: i, path });
  }
  await store.appendMessages(convo.id, [{ role: "user", content: "photos", images: photos.map((p) => ({ path: p.path })) }]);
  return { convo, photos };
}

test("no photo is read twice with several drainers, and the household cap holds across them", async () => {
  config.chatVisionConcurrency = 3;
  let inFlight = 0;
  let most = 0;
  openrouter.readerFor = async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  };
  const { convo, photos } = await seedPhotos(7);
  const other = await seedPhotos(3);
  // enqueue without starting the automatic drainer by hand-inserting, then race several drainers on both conversations
  const insert = async (c, ps) => supabase.tables.photo_reads.push(...ps.map((p) => ({ id: crypto.randomUUID(), conversation_id: c.id, user_id: OWNER, name: "Owner", n: p.n, path: p.path, status: "queued", attempts: 0, lease_until: null, result: null, group_id: null, recipe: null, joined_to: null, split_from_prev: false, tray_item_id: null, error: null, created_at: new Date().toISOString(), read_at: null, report_lease_until: null, reported_at: null })));
  await insert(convo, photos);
  await insert(other.convo, other.photos);
  await Promise.all([queue.drain(convo.id), queue.drain(convo.id), queue.drain(convo.id), queue.drain(other.convo.id), queue.drain(other.convo.id)]);
  await background.backgroundIdle();
  const firstPass = openrouter.readerRequests.filter((r) => r.messages[1].content.length === 2);
  assert.equal(firstPass.length, 10, "every photo read exactly once");
  assert.ok(most <= 3, `at most 3 reading at once across the household (saw ${most})`);
  assert.equal(notes(convo.id).length, 1, "exactly one report per idle point");
  assert.equal(notes(other.convo.id).length, 1);
});

test("a lease that ran out (the instance died) goes back on the queue and is read; after two attempts it is failed", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { convo, photos } = await seedPhotos(2);
  const past = new Date(Date.now() - 1000).toISOString();
  supabase.tables.photo_reads.push(
    { id: crypto.randomUUID(), conversation_id: convo.id, user_id: OWNER, name: "Owner", n: 1, path: photos[0].path, status: "reading", attempts: 1, lease_until: past, created_at: past, reported_at: null, report_lease_until: null },
    { id: crypto.randomUUID(), conversation_id: convo.id, user_id: OWNER, name: "Owner", n: 2, path: photos[1].path, status: "reading", attempts: 2, lease_until: past, created_at: past, reported_at: null, report_lease_until: null }
  );
  await queue.kick(convo.id, { force: true });
  await background.backgroundIdle();
  const [a, b] = supabase.tables.photo_reads;
  assert.equal(a.status, "read");
  assert.equal(b.status, "failed");
  assert.match(b.error, /cut off twice/);
  assert.match(notes(convo.id)[0].content.content, /photo-2: couldn't be read/);
});

test("at most 30 photos can wait to be read in one conversation", async () => {
  const { convo, photos } = await seedPhotos(31);
  openrouter.readerFor = () => new Promise(() => {}); // never answers: nothing gets reported while we count
  const out = await queue.enqueuePhotos({ conversationId: convo.id, caller: caller(), photos, origin: "https://mcp.test" });
  assert.equal(out.queued.length, 30);
  assert.equal(out.refused, 1);
  // stop the hung drainers from keeping the test alive: mark everything read
  for (const r of supabase.tables.photo_reads) Object.assign(r, { status: "skipped" });
});

test("photos sent with no words while others are being read join the queue with no model call", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  openrouter.readerFor = async () => (await gate, null);
  const res = await post({ message: "add these", page: { page: "index" }, images: [asUrl(await solid(RED))] });
  const first = await events(res);
  const conversation_id = first.find((e) => e.name === "meta").data.conversation_id;
  const modelCalls = openrouter.requests.length;
  const second = await events(await post({ conversation_id, message: "", page: { page: "index" }, images: [asUrl(await solid(GREEN)), asUrl(await solid(BLUE))] }));
  assert.equal(openrouter.requests.length, modelCalls, "no model call");
  assert.match(second.filter((e) => e.name === "text").map((e) => e.data.delta).join(""), /^Added 2 more photos: reading 3 in all\. I'll come back when they're all read\.$/);
  assert.deepEqual(second.find((e) => e.name === "photos").data.numbers, [2, 3]);
  // while they are read, the panel reports progress and the turn's note says so
  const panel = await (await get(`conversations/${conversation_id}`)).json();
  assert.equal(panel.photos.active, true);
  assert.equal(panel.photos.reading, 3);
  release();
  await background.backgroundIdle();
  assert.equal(notes(conversation_id).length, 1, "one report covers all three");
  assert.match(notes(conversation_id)[0].content.content, /new since last time: photo-1 to photo-3/);
});

test("while photos are being read every turn's note says so, and the model answers other questions as usual", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  openrouter.readerFor = async () => (await gate, null);
  const first = await events(await post({ message: "add this", page: { page: "index" }, images: [asUrl(await solid(RED))] }));
  const conversation_id = first.find((e) => e.name === "meta").data.conversation_id;
  openrouter.requests.length = 0;
  await events(await post({ conversation_id, message: "what's quick tonight?", page: { page: "index" } }));
  const last = openrouter.requests[0].messages.findLast((m) => m.role === "user");
  assert.match(last.content, /\[photos still being read: 0 of 1 done/);
  release();
  await background.backgroundIdle();
});

// --- hand-over, locks, the internal routes -------------------------------------------------------------------------------------------

test("exactly once: a note the user's own turn picked up is not run again by the follow-up", async () => {
  const convo = await store.createConversation({ userId: OWNER, title: "x" });
  await store.appendMessages(convo.id, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  const id = await store.appendEvent(convo.id, { content: "photos read.\nnew since last time: photo-1", summary: "Photos read: 1 recipe" });
  await say("what now?", { conversation_id: convo.id });
  const event = supabase.tables.messages.find((m) => m.id === id);
  assert.ok(event.handled_at, "the user's turn claimed it");
  const before = openrouter.requests.length;
  assert.equal((await followUp.runFollowUp(id)).status, "handled");
  assert.equal(openrouter.requests.length, before, "no second model call");
  // and the user's turn handed the note to the model, before their message
  const turn = openrouter.requests.find((r) => JSON.stringify(r.messages).includes("what now?"));
  assert.match(turn.messages.findLast((m) => m.role === "user").content, /photos read\.[\s\S]*what now\?/);
});

test("the turn lock: a turn while another runs gets 409 busy; a follow-up that finds the lock taken leaves the note for the running turn, which starts it when it ends", async () => {
  const convo = await store.createConversation({ userId: OWNER, title: "x" });
  await store.appendMessages(convo.id, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  assert.equal(await store.takeTurnLock(convo.id, "u:other", 60_000), true);
  const res = await post({ conversation_id: convo.id, message: "again", page: {} });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).busy, true);
  const id = await store.appendEvent(convo.id, { content: "photos read.\nnew since last time: photo-1\nunsure: none", summary: "Photos read: 0 recipes" });
  assert.equal((await followUp.runFollowUp(id)).status, "busy");
  assert.equal(supabase.tables.messages.find((m) => m.id === id).handled_at, null);
  // the running turn ends: it releases the lock, then starts the follow-up for the note
  await followUp.afterTurn(convo.id, "u:other");
  await background.backgroundIdle();
  assert.ok(supabase.tables.messages.find((m) => m.id === id).handled_at, "the follow-up ran");
  assert.equal(supabase.tables.conversations.find((c) => c.id === convo.id).turn_lock_until, null, "and released the lock");
});

test("the follow-up runs as the conversation's owner only while they are in EDITORS; otherwise the note stays a note", async (t) => {
  t.mock.method(console, "warn", () => {});
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  config.shoppingEditors = ["owner@example.com"];
  const res = await post({ message: "add this", page: {}, images: [asUrl(await solid(RED))] });
  const conversation_id = (await events(res)).find((e) => e.name === "meta").data.conversation_id;
  config.shoppingEditors = []; // removed while the photos were being read
  await background.backgroundIdle();
  const [note] = notes(conversation_id);
  assert.ok(note, "the report is still stored");
  assert.equal(note.handled_at, null, "but no turn ran with it");
  assert.equal(trayItems().length, 0);
});

test("the internal routes refuse without the server's secret (404) and take only ids; with it, they run the work after a 202", async (t) => {
  t.mock.method(console, "warn", () => {});
  const call = (route, body, secret) => chat.POST(new Request(`https://mcp.test/api/chat?route=${route}`, { method: "POST", headers: { "content-type": "application/json", ...(secret !== undefined ? { "x-chat-internal-secret": secret } : {}) }, body: JSON.stringify(body) }));
  const convo = await store.createConversation({ userId: OWNER, title: "x" });
  await store.appendMessages(convo.id, [{ role: "user", content: "hi" }]);
  const id = await store.appendEvent(convo.id, { content: "photos read.\nunsure: none", summary: "Photos read" });
  // no secret configured: everything is refused, whatever is sent
  assert.equal((await call("internal/continue", { event_id: id }, "")).status, 404);
  config.chatInternalSecret = "s3cret-value";
  assert.equal((await call("internal/continue", { event_id: id })).status, 404);
  assert.equal((await call("internal/continue", { event_id: id }, "wrong-value!")).status, 404);
  assert.equal((await call("internal/continue", { event_id: "not-a-uuid" }, "s3cret-value")).status, 400);
  assert.equal(supabase.tables.messages.find((m) => m.id === id).handled_at, null);
  const ok = await call("internal/continue", { event_id: id, role: "agent", user_id: STRANGER }, "s3cret-value");
  assert.equal(ok.status, 202);
  await background.backgroundIdle();
  assert.ok(supabase.tables.messages.find((m) => m.id === id).handled_at);
  // a note already handled is refused (nothing runs again)
  const before = openrouter.requests.length;
  assert.equal((await call("internal/continue", { event_id: id }, "s3cret-value")).status, 202);
  await background.backgroundIdle();
  assert.equal(openrouter.requests.length, before);
});

test("with the secret and a reachable origin, the report hands the follow-up to the internal route (a fresh function run)", async () => {
  config.chatInternalSecret = "s3cret-value";
  config.chatInternalUrl = "https://mcp.test";
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  await say("add this", { images: [asUrl(await solid(RED))] });
  assert.ok(internalHits.some((u) => u.endsWith("/chat/internal/continue")));
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Miso Aubergine"]);
});

test("a missing CHAT_VISION_MODEL is a clear error, never a silent fallback to the chat model", async (t) => {
  t.mock.method(console, "error", () => {});
  config.chatVisionModel = "";
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(RED))] });
  const tool = supabase.tables.messages.find((m) => m.conversation_id === conversation_id && m.role === "tool");
  assert.match(tool.content.content, /Photo reading isn't set up/);
  assert.equal(openrouter.readerRequests.length, 0);
  assert.equal(supabase.tables.photo_reads.length, 0);
});

test("read_recipe_photos is for editors only: not offered to visitors, refused by the dispatcher and by the handler", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { offeredTools } = await import("../lib/chat.js");
  assert.ok(!offeredTools("public").some((d) => d.function.name === "read_recipe_photos"));
  assert.ok(offeredTools("editor").some((d) => d.function.name === "read_recipe_photos"));
  for (const role of ["public", "agent"]) assert.match((await tools.dispatch("read_recipe_photos", {}, tools.makeCaller({ role }))).content[0].text, /Not allowed/);
  const tool = tools.TOOLS.find((x) => x.name === "read_recipe_photos");
  assert.match((await tool.handler({}, { caller: tools.makeCaller({ role: "public" }) })).content[0].text, /Not allowed/);
});

// --- uploads on pick --------------------------------------------------------------------------------------------------------------

test("photos uploaded on pick: the first upload makes the (hidden) conversation, the message sends image_paths in picked order; foreign or reused paths are refused", async (t) => {
  t.mock.method(console, "warn", () => {});
  const up = (body, token = "owner-token") => chat.POST(new Request("https://mcp.test/api/chat?route=uploads", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify(body) }));
  assert.equal((await up({ image: asUrl(await solid(RED)) }, "stranger-token")).status, 403);
  const a = await (await up({ image: asUrl(await solid(RED)) })).json();
  assert.match(a.path, new RegExp(`^${a.conversation_id}/[0-9a-f-]{36}\\.jpg$`));
  const b = await (await up({ image: asUrl(await solid(GREEN)), conversation_id: a.conversation_id })).json();
  assert.equal(b.conversation_id, a.conversation_id);
  // an untitled conversation isn't in the chats list yet
  assert.equal((await (await get("conversations")).json()).conversations.length, 0);
  // a path from another conversation can't be attached
  const c = await (await up({ image: asUrl(await solid(BLUE)) })).json();
  assert.equal((await post({ conversation_id: a.conversation_id, message: "x", image_paths: [c.path] })).status, 400);
  assert.equal((await post({ conversation_id: a.conversation_id, message: "x", image_paths: ["../../etc/passwd"] })).status, 400);
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  reads[await colourKey(GREEN)] = fakeRead("Pea Soup Bowl");
  const { evs } = await say("add these", { conversation_id: a.conversation_id, image_paths: [b.path, a.path] });
  assert.ok(evs.some((e) => e.name === "title"), "the first message names the conversation");
  assert.deepEqual(supabase.tables.photo_reads.sort((x, y) => x.n - y.n).map((r) => r.path), [b.path, a.path], "numbered in picked order");
  assert.deepEqual(trayItems().map((i) => i.op.title).sort(), ["Miso Aubergine", "Pea Soup Bowl"]);
  // reusing an already-attached photo is refused
  assert.equal((await post({ conversation_id: a.conversation_id, message: "again", image_paths: [a.path] })).status, 400);
  assert.equal((await (await get("conversations")).json()).conversations.length, 1);
});

test("a report that is ready while the user's own turn is still answering waits for it: the note comes after the reply and the follow-up still runs", async () => {
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  const convo = await store.createConversation({ userId: OWNER, title: "slow turn" });
  await store.appendMessages(convo.id, [{ role: "user", content: "add this", images: [{ path: `${convo.id}/${crypto.randomUUID()}.jpg` }] }]);
  const path = supabase.tables.messages.at(-1).content.images[0].path;
  supabase.objects.set(`chat-uploads/${path}`, { bytes: await solid(RED), type: "image/jpeg" });
  // a user turn holds the lock while the photo is read and the report is due
  assert.equal(await store.takeTurnLock(convo.id, "u:slow", 60_000), true);
  const drained = queue.enqueuePhotos({ conversationId: convo.id, caller: caller(), photos: [{ n: 1, path }], origin: "https://mcp.test" });
  await drained;
  for (let i = 0; i < 20 && !supabase.tables.photo_reads.every((r) => r.status === "read"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(notes(convo.id).length, 0, "no report while the turn is running");
  // the turn writes its reply and ends
  await store.appendMessages(convo.id, [{ role: "assistant", content: "I'm reading your photo now." }]);
  await followUp.afterTurn(convo.id, "u:slow");
  await background.backgroundIdle();
  const rows = supabase.tables.messages.filter((m) => m.conversation_id === convo.id).map((m) => m.role);
  assert.deepEqual(rows.slice(0, 3), ["user", "assistant", "event"], "the note comes after the reply");
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Miso Aubergine"], "and the follow-up staged it");
});

test("the follow-up hands over its notes last even if a reply was stored after them", async () => {
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(RED))] });
  // a stored note, then an assistant row after it (two turns overlapping): the follow-up must still answer the note
  supabase.tables.trays.length = 0;
  const id = await store.appendEvent(conversation_id, { content: notes(conversation_id)[0].content.content, summary: "Photos read: 1 recipe" });
  await store.appendMessages(conversation_id, [{ role: "assistant", content: "something else" }]);
  assert.equal((await followUp.runFollowUp(id)).status, "done");
  const req = openrouter.requests.at(-1);
  assert.match(req.messages.findLast((m) => m.role === "user").content, /photos read\./);
});

test("the status line says what is left to check, in words", async () => {
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  reads[await colourKey(GREEN)] = "garbage";
  const { conversation_id } = await say("add these", { images: [asUrl(await solid(RED)), asUrl(await solid(GREEN))] });
  assert.equal(notes(conversation_id)[0].content.summary, "Photos read: 1 recipe · 1 unreadable");
});

// --- fixes from the adversarial review --------------------------------------------------------------------------------------------

test("a joined group whose second pass fails is pieced together from the first reads, AND can be staged", async (t) => {
  t.mock.method(console, "warn", () => {});
  const g = await colourKey(GREEN);
  const b = await colourKey(BLUE);
  openrouter.readerFor = ({ colours, consecutive }) => (consecutive ? { status: 500 } : colours[0] === g ? dalTop : colours[0] === b ? dalBottom : null);
  const { conversation_id } = await say("add these", { images: [asUrl(await solid(GREEN)), asUrl(await solid(BLUE))] });
  assert.match(notes(conversation_id)[0].content.content, /photo-1\+2: read together \(pieced together from the separate reads\)[^\n]*· ok/);
  const item = trayItems().find((i) => i.op.title === "Dal Makhani");
  assert.ok(item, "staged from the pieced-together recipe");
  assert.equal(item.op.instructions.length, 4, "both screenshots' steps");
});

test("the 'use my photo' gate reads what the editor typed, never a site note merged into their message", async () => {
  const convo = await store.createConversation({ userId: OWNER, title: "x" });
  await store.appendMessages(convo.id, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  await store.appendEvent(convo.id, { content: "photo-1: a photo of a dish. Use it as a recipe's photo (photo_from_attachment: 1) only if the user asks.", summary: "Photos read" });
  const tool = tools.TOOLS.find((x) => x.name === "read_recipe_photos");
  const original = tool.handler;
  let seen;
  tool.handler = async (args, ctx) => ((seen = ctx.chat.userText), { content: [{ type: "text", text: "{}" }] });
  try {
    await say("mock-call:read_recipe_photos", { conversation_id: convo.id });
  } finally {
    tool.handler = original;
  }
  assert.equal(seen, "mock-call:read_recipe_photos");
  assert.ok(tools.asksToUsePhoto("photo-1: a photo of a dish. Use it as a recipe's photo (photo_from_attachment: 1) only if the user asks."), "the note alone would have passed the gate");
});

test("the user's join wins even when one photo was read as 'other' on its own; a split of a photo with itself is refused clearly", async () => {
  const r = (n, read, extra = {}) => ({ n, status: "read", result: read, ...extra });
  const g = reader.groupPhotos([r(3, dalTop), r(4, { ...dalBottom, kind: "other" }, { joined_to: 3 })]);
  assert.deepEqual(g.groups.map((x) => x.id), ["3+4"]);
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  const { conversation_id } = await say("add this", { images: [asUrl(await solid(RED))] });
  const lines = await queue.applyCorrections(conversation_id, { split: [[1, 1]] }, { caller: caller() });
  assert.deepEqual(lines, ["Can't split photo-1 from itself: give two different photos."]);
});

test("a follow-up turn can't read again or correct on its own: it asks the user instead", async () => {
  const res = await tools.dispatch("read_recipe_photos", { join: [[1, 2]] }, caller(), { chat: { emit() {}, conversationId: crypto.randomUUID(), followUp: true } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ask the user with ask_user/);
});

test("Finalise on a chat that is busy is refused without leaving the tray 'finalising'", async () => {
  const ctx = { chat: { emit() {}, photos: [], userText: "" } };
  const staged = await tools.dispatch("stage_create_recipe", { title: "Busy Day Soup", course: ["Lunch"], total_mins: 20, serves: 2, calories: 300, ingredients: [{ quantity: "1", name: "onion" }], instructions: ["Cook the **onion**."] }, caller(), ctx);
  assert.ok(!staged.isError, staged.content[0].text);
  await background.backgroundIdle();
  const convo = await store.createConversation({ userId: OWNER, title: "x" });
  await store.takeTurnLock(convo.id, "u:other", 60_000);
  const res = await post({ conversation_id: convo.id, action: "finalise", page: {} });
  assert.equal(res.status, 409);
  assert.notEqual(supabase.tables.trays[0].status, "finalising");
});

test("the internal secret is only ever sent to CHAT_INTERNAL_URL, never to the request's host; without it the work runs in place", async () => {
  config.chatInternalSecret = "s3cret-value";
  config.chatInternalUrl = "";
  reads[await colourKey(RED)] = fakeRead("Miso Aubergine");
  await say("add this", { images: [asUrl(await solid(RED))] });
  assert.deepEqual(internalHits, [], "no call to a host taken from headers");
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Miso Aubergine"], "the follow-up still ran");
});

test("joining photos takes their earlier cards out of the tray at once, even when the joined recipe isn't staged (it's a duplicate)", async () => {
  reads[await colourKey(RED)] = fakeRead("Mushroom Risotto");
  reads[await colourKey(BLUE)] = fakeRead("Pea And Mint Soup");
  reads[await colourKey(YELLOW)] = fakeRead("Lemon Chicken Orzo");
  reads[`together:${await colourKey(BLUE)},${await colourKey(YELLOW)}`] = fakeRead("Mushroom Risotto"); // the re-read matches photo 1's card
  const { conversation_id } = await say("add these", { images: [asUrl(await solid(RED)), asUrl(await solid(BLUE)), asUrl(await solid(YELLOW))] });
  assert.deepEqual(trayItems().map((i) => i.op.title).sort(), ["Lemon Chicken Orzo", "Mushroom Risotto", "Pea And Mint Soup"]);
  await say("2 and 3 are one recipe", { conversation_id });
  assert.deepEqual(trayItems().map((i) => i.op.title), ["Mushroom Risotto"], "the two halves' cards are gone; the duplicate isn't added twice");
  assert.match(notes(conversation_id).at(-1).content.summary, /Mushroom Risotto already added/);
  assert.ok(supabase.tables.photo_reads.filter((r) => r.n > 1).every((r) => !r.tray_item_id));
});

test("the reader's answer is accepted wrapped in a one-item array, fenced, or with prose around it (providers don't all enforce the schema)", () => {
  const obj = { kind: "dish" };
  assert.deepEqual(reader.parseReaderJson(JSON.stringify([obj])), obj);
  assert.deepEqual(reader.parseReaderJson("```json\n" + JSON.stringify(obj) + "\n```"), obj);
  assert.deepEqual(reader.parseReaderJson("Here is the result:\n" + JSON.stringify(obj) + "\nDone."), obj);
  assert.deepEqual(reader.parseReaderJson([obj]), obj);
  assert.equal(reader.parseReaderJson("[1, 2]"), null);
  assert.equal(reader.parseReaderJson("not json"), null);
  assert.equal(reader.parseReaderJson(JSON.stringify([obj, obj])), null);
});
