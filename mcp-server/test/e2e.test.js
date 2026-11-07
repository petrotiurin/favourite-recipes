// End-to-end: real MCP client -> api/mcp.js handler -> fake in-memory GitHub API.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";
process.env.OPENROUTER_API_KEY = "or-test";
process.env.SUPABASE_URL = "https://sb.test/";
process.env.SUPABASE_ANON_KEY = "anon-test";
process.env.EDITORS = "Owner@Example.com, partner@example.com";

// --- fake GitHub: repo files live in a Map, commits update it -------------
const ROOT = new URL("../../", import.meta.url);
const files = new Map();
for (const dir of ["recipes", "images/recipes"]) {
  for (const f of readdirSync(new URL(dir + "/", ROOT))) files.set(`${dir}/${f}`, readFileSync(new URL(`${dir}/${f}`, ROOT)));
}
// Start from a repo where nothing is a draft or in a week, whatever the real recipes are marked as right now.
for (const [p, buf] of files) if (p.endsWith(".md")) files.set(p, Buffer.from(buf.toString().replace(/^(draft|current|next): true\n/gm, "")));
files.set("build.js", Buffer.from("// build"));
const blobs = new Map();
const trees = new Map();
let head = "c0";
const commits = new Map([["c0", { tree: "t0" }]]);
let n = 0;
const commitLog = [];
const realFetch = globalThis.fetch;

async function fakeGitHub(url, init = {}) {
  const u = new URL(url);
  const path = decodeURI(u.pathname.replace("/repos/petrotiurin/favourite-recipes", ""));
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (method === "GET" && path.startsWith("/contents/")) {
    const p = path.slice("/contents/".length);
    if (files.has(p)) return new Response(files.get(p));
    const entries = [...files.keys()].filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/"));
    return entries.length ? json(entries.map((k) => ({ type: "file", name: k.split("/").pop() }))) : json({}, 404);
  }
  if (method === "POST" && path === "/git/blobs") { const sha = `b${++n}`; blobs.set(sha, Buffer.from(body.content, "base64")); return json({ sha }); }
  if (method === "GET" && path.startsWith("/git/ref/")) return json({ object: { sha: head } });
  if (method === "GET" && path.startsWith("/git/commits/")) return json({ tree: { sha: commits.get(path.split("/").pop()).tree } });
  if (method === "POST" && path === "/git/trees") { const sha = `t${++n}`; trees.set(sha, body.tree); return json({ sha }); }
  if (method === "POST" && path === "/git/commits") { const sha = `c${++n}`; commits.set(sha, { tree: body.tree, message: body.message }); return json({ sha, html_url: `https://github.com/x/commit/${sha}` }); }
  if (method === "PATCH" && path.startsWith("/git/refs/")) {
    const c = commits.get(body.sha);
    for (const e of trees.get(c.tree)) e.sha === null ? files.delete(e.path) : files.set(e.path, blobs.get(e.sha));
    head = body.sha;
    commitLog.push({ message: c.message, paths: trees.get(c.tree).map((e) => e.path) });
    return json({});
  }
  throw new Error(`unexpected GitHub call ${method} ${path}`);
}

const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#c84" } }).png().toBuffer();

// --- fake OpenRouter: square images after a short delay, failing for prompts that mention FAIL ---
const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#4a8" } }).png().toBuffer();
const imageRequests = [];
let inFlight = 0;
let maxInFlight = 0;
async function fakeOpenRouter(init) {
  const body = JSON.parse(init.body);
  imageRequests.push({ ...body, auth: init.headers.Authorization });
  maxInFlight = Math.max(maxInFlight, ++inFlight);
  await new Promise((r) => setTimeout(r, 50));
  inFlight--;
  if (body.prompt.includes("FAIL")) return new Response(JSON.stringify({ error: { message: "moderated" } }), { status: 400 });
  return new Response(JSON.stringify({ data: [{ b64_json: generated.toString("base64") }] }));
}

// --- fake Supabase Auth: /auth/v1/user answers for two known access tokens ---
function fakeSupabase(url, init) {
  assert.equal(init.headers.apikey, "anon-test");
  const users = { "Bearer owner-token": "owner@example.com", "Bearer stranger-token": "stranger@example.com" };
  const email = users[init.headers.Authorization];
  return email ? Response.json({ id: "u1", email }) : Response.json({ msg: "invalid JWT" }, { status: 401 });
}

let mcp, upload, stocktake, client;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return fakeGitHub(s, init);
    if (s === "https://openrouter.ai/api/v1/images") return fakeOpenRouter(init);
    if (s === "https://sb.test/auth/v1/user") return fakeSupabase(s, init);
    if (s === "https://img.example/dish.png") return new Response(photo, { headers: { "content-type": "image/png" } });
    if (s.startsWith("https://mcp.test/upload")) return upload[init?.method || "GET"](new Request(s, init));
    if (s.startsWith("https://mcp.test/")) return mcp[init?.method || "GET"](new Request(s, init));
    return realFetch(url, init);
  };
  mcp = await import("../api/mcp.js");
  upload = await import("../api/upload.js");
  stocktake = await import("../api/stocktake.js");
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp?key=secret")));
});

const text = (r) => r.content.map((c) => c.text || "").join("\n");

test("rejects requests without the key", async () => {
  const res = await mcp.POST(new Request("https://mcp.test/mcp", { method: "POST", body: "{}" }));
  assert.equal(res.status, 401);
});

test("lists tools and recipes", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["batch_changes", "create_image_upload_link", "create_recipe", "get_recipe", "get_shopping_list", "get_workflow_guide", "list_recipes", "promote_recipe", "remove_draft", "set_shopping_servings", "set_week_recipes", "start_next_week", "update_recipe", "update_shopping_list"]);
  const r = await client.callTool({ name: "list_recipes", arguments: {} });
  const list = JSON.parse(text(r));
  assert.ok(list.find((x) => x.slug === "harissa-tuna-pitta"));
});

test("the plan-recipes workflow ships with the server, as a tool and a prompt", async () => {
  const guide = text(await client.callTool({ name: "get_workflow_guide", arguments: { name: "plan-recipes" } }));
  assert.match(guide, /^# Plan recipes/);
  assert.match(guide, /batch_changes/);
  assert.match(guide, /set_shopping_servings/);
  assert.doesNotMatch(guide, /<!--/);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["plan-recipes", "ocado-shop", "sainsburys-shop"]);
  const p = await client.getPrompt({ name: "plan-recipes", arguments: { request: "harissa pitta, the soup just for me" } });
  assert.equal(p.messages[0].role, "user");
  assert.ok(p.messages[0].content.text.startsWith(guide));
  assert.match(p.messages[0].content.text, /the soup just for me$/);
  assert.match(client.getInstructions(), /get_workflow_guide\(\{ name: "plan-recipes" \}\)/);
});

for (const [name, title, own] of [
  ["ocado-shop", /^# Ocado shop/, /ocado\.com\/favorites/],
  ["sainsburys-shop", /^# Sainsbury's shop/, /window\.S = \{/], // the helper ships inside the guide
]) {
  test(`the ${name} workflow ships with the server, with the shared shop rules`, async () => {
    const guide = text(await client.callTool({ name: "get_workflow_guide", arguments: { name } }));
    assert.match(guide, title);
    assert.match(guide, own);
    for (const shared of ["## What to buy", "## Picking rules", "## Non-negotiable preferences", "## Report back"]) {
      assert.equal(guide.split(shared).length, 2, `${name} has "${shared}" exactly once`);
    }
    assert.match(guide, /planned servings/);
    assert.doesNotMatch(guide, /<!--|-->/); // includes expanded, maintainers' notes stripped
    const p = await client.getPrompt({ name, arguments: { request: "also 2 more avocados" } });
    assert.ok(p.messages[0].content.text.startsWith(guide));
    assert.match(p.messages[0].content.text, /also 2 more avocados$/);
    assert.match(client.getInstructions(), new RegExp(`get_workflow_guide\\(\\{ name: "${name}" \\}\\)`));
  });
}

const base = {
  title: "Test Lentil Soup",
  course: ["Lunch", "Dinner"],
  tags: ["Vegan"],
  total_mins: 40,
  serves: 4,
  calories: 320,
  ingredients: [
    { quantity: "200g", name: "red lentils", note: "rinsed" },
    { name: "Salt", note: "to taste" },
  ],
  instructions: ["1. Simmer the **red lentils** for 20 minutes", "Season with **Salt**"],
};

test("schema rejects bad course and missing image", async () => {
  const r1 = await client.callTool({ name: "create_recipe", arguments: { ...base, course: ["Brunch"], image: { url: "https://img.example/dish.png" } } });
  assert.ok(r1.isError);
  const r2 = await client.callTool({ name: "create_recipe", arguments: { ...base, image: {} } });
  assert.ok(r2.isError);
  assert.match(text(r2), /exactly one/);
});

test("rejects ingredients without quantity", async () => {
  const r = await client.callTool({ name: "create_recipe", arguments: { ...base, ingredients: [{ name: "lentils" }], image: { url: "https://img.example/dish.png" } } });
  assert.ok(r.isError);
  assert.match(text(r), /needs a quantity/);
});

test("creates a recipe with image from URL in a single commit", async () => {
  const r = await client.callTool({ name: "create_recipe", arguments: { ...base, image: { url: "https://img.example/dish.png" } } });
  assert.ok(!r.isError, text(r));
  const md = files.get("recipes/test-lentil-soup.md").toString();
  assert.equal(md, `---
title: Test Lentil Soup
slug: test-lentil-soup
image: /images/recipes/test-lentil-soup.jpg
course: [Lunch, Dinner]
tags: [Vegan]
total_mins: 40
serves: 4
calories: 320
draft: true
---

## Ingredients

- 200g **red lentils**, rinsed
- **Salt**, to taste

## Instructions

1. Simmer the **red lentils** for 20 minutes
2. Season with **Salt**
`);
  const meta = await sharp(files.get("images/recipes/test-lentil-soup.jpg")).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(Math.max(meta.width, meta.height), 1600);
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["images/recipes/test-lentil-soup.jpg", "recipes/test-lentil-soup.md"]);
});

test("promote_recipe turns a draft into a regular recipe and leaves its weeks alone", async () => {
  const list = JSON.parse(text(await client.callTool({ name: "list_recipes", arguments: {} })));
  const draft = list.find((x) => x.slug === "test-lentil-soup");
  assert.equal(draft.draft, true);
  assert.equal(draft.current, undefined); // a draft isn't in a week unless it's put in one

  const before = files.get("recipes/test-lentil-soup.md").toString();
  const r = await client.callTool({ name: "promote_recipe", arguments: { slug: "test-lentil-soup" } });
  assert.ok(!r.isError, text(r));
  assert.equal(files.get("recipes/test-lentil-soup.md").toString(), before.replace("draft: true\n", ""));
  assert.deepEqual(commitLog.at(-1).paths, ["recipes/test-lentil-soup.md"]);
  assert.match(commitLog.at(-1).message, /^Promote recipe: Test Lentil Soup/);

  const again = await client.callTool({ name: "promote_recipe", arguments: { slug: "test-lentil-soup" } });
  assert.ok(again.isError);
  assert.match(text(again), /not a draft/);
});

test("draft: false creates a regular recipe straight away", async () => {
  const r = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Test Regular Soup", draft: false, image: { url: "https://img.example/dish.png" } } });
  assert.ok(!r.isError, text(r));
  assert.doesNotMatch(files.get("recipes/test-regular-soup.md").toString(), /draft/);
});

// Every item is tagged with the recipes it is for; here each item is simply for all of the given recipes,
// split evenly between them (an item for several recipes says how much each one needs).
const split = (total, recipes) => {
  const slugs = [...new Set(recipes)];
  return slugs.length > 1 ? { amounts: Object.fromEntries(slugs.map((s) => [s, total / slugs.length])) } : {};
};
const sectionsFor = (recipes) => [
  { name: "Fresh produce", items: [{ quantity: "3", name: "Red onions", note: "for both", recipes, ...split(3, recipes) }, { name: "Parsley", recipes }] },
  { name: "Pantry", items: [{ quantity: "400g", name: "Red lentils", recipes, ...split(400, recipes) }] },
];
const shopping = async (name = "get_shopping_list", args = {}) => text(await client.callTool({ name, arguments: args }));
const listed = async () => JSON.parse(text(await client.callTool({ name: "list_recipes", arguments: {} })));
const thisWeek = async () => (await listed()).filter((x) => x.current).map((x) => x.slug);
const nextWeek = async () => (await listed()).filter((x) => x.next).map((x) => x.slug);
const nextSections = async () => sectionsFor(await nextWeek());

test("weeks: set_week_recipes is one minimal commit, idempotent, works on drafts, and a recipe can be in both weeks", async () => {
  const before = files.get("recipes/steamed-rice.md").toString();
  const commits = commitLog.length;
  const r = await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["steamed-rice", "steamed-rice"], add: true } });
  assert.ok(!r.isError, text(r));
  assert.equal(commitLog.length, commits + 1);
  assert.deepEqual(commitLog.at(-1).paths, ["recipes/steamed-rice.md"]);
  assert.equal(files.get("recipes/steamed-rice.md").toString(), before.replace(/\n---\n/, "\ncurrent: true\n---\n"));

  const again = await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["steamed-rice"], add: true } });
  assert.ok(!again.isError);
  assert.match(text(again), /nothing changed/);
  assert.match(text(again), /already in this week: steamed-rice/);
  assert.equal(commitLog.length, commits + 1);

  const missing = await client.callTool({ name: "set_week_recipes", arguments: { week: "next", slugs: ["no-such-recipe"], add: true } });
  assert.ok(missing.isError);
  const badWeek = await client.callTool({ name: "set_week_recipes", arguments: { week: "later", slugs: ["steamed-rice"], add: true } });
  assert.ok(badWeek.isError);

  // A new draft can go straight into next week; steamed rice is cooked both weeks.
  const r2 = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Test Draft Salad", week: "next", image: { url: "https://img.example/dish.png" } } });
  assert.ok(!r2.isError, text(r2));
  assert.match(text(r2), /next week: refresh the shopping list/);
  assert.match(files.get("recipes/test-draft-salad.md").toString(), /^next: true\ndraft: true\n---$/m);
  await client.callTool({ name: "set_week_recipes", arguments: { week: "next", slugs: ["steamed-rice"], add: true } });

  // Order: this week (drafts first), then next week, then the rest (alphabetical within each).
  const list = await listed();
  assert.deepEqual(list.slice(0, 2).map((x) => x.slug), ["steamed-rice", "test-draft-salad"]);
  assert.deepEqual([list[0].current, list[0].next], [true, true]);
  assert.deepEqual([list[1].current, list[1].next, list[1].draft], [undefined, true, true]);
  assert.ok(list.slice(2).every((x) => !x.current && !x.next));

  // Drafts can be taken in and out of a week like anything else.
  await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["test-draft-salad"], add: true } });
  assert.deepEqual(await thisWeek(), ["test-draft-salad", "steamed-rice"]);
  await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["test-draft-salad"], add: false } });
  assert.deepEqual(await thisWeek(), ["steamed-rice"]);
});

test("shopping list covers next week only, and stays as it is after the switch", async () => {
  // State from the test before: this week = steamed-rice; next week = steamed-rice + test-draft-salad.
  const dup = await client.callTool({
    name: "update_shopping_list",
    arguments: { sections: [{ name: "A", items: [{ name: "Onions", recipes: ["steamed-rice"] }] }, { name: "B", items: [{ name: "onions", recipes: ["steamed-rice"] }] }] },
  });
  assert.ok(dup.isError);
  assert.match(text(dup), /listed twice/);

  // Each item names next-week recipes, and every next-week recipe has at least one item.
  const unknown = await client.callTool({ name: "update_shopping_list", arguments: { sections: sectionsFor(["steamed-rice", "test-draft-salad", "harissa-tuna-pitta"]) } });
  assert.ok(unknown.isError);
  assert.match(text(unknown), /"harissa-tuna-pitta" is not a next-week recipe/);
  const uncovered = await client.callTool({ name: "update_shopping_list", arguments: { sections: sectionsFor(["steamed-rice"]) } });
  assert.ok(uncovered.isError);
  assert.match(text(uncovered), /no item is for test-draft-salad/);

  // An item for several recipes says how much each one needs, adding up to its quantity.
  const both = ["test-draft-salad", "steamed-rice"];
  const withOnions = (onions) => [{ name: "Fresh produce", items: [{ quantity: "3", name: "Red onions", recipes: both, ...onions }] }];
  const noSplit = await client.callTool({ name: "update_shopping_list", arguments: { sections: withOnions({}) } });
  assert.ok(noSplit.isError);
  assert.match(text(noSplit), /"Red onions": amounts is required/);
  const badSum = await client.callTool({ name: "update_shopping_list", arguments: { sections: withOnions({ amounts: { "test-draft-salad": 2, "steamed-rice": 2 } }) } });
  assert.match(text(badSum), /amounts add up to 4, but quantity is "3"/);
  const wrongKeys = await client.callTool({ name: "update_shopping_list", arguments: { sections: withOnions({ amounts: { "test-draft-salad": 3 } }) } });
  assert.match(text(wrongKeys), /missing steamed-rice/);
  const badServings = await client.callTool({ name: "update_shopping_list", arguments: { sections: sectionsFor(both), servings: { "harissa-tuna-pitta": 1 } } });
  assert.match(text(badServings), /"harissa-tuna-pitta" is not a next-week recipe/);

  const r = await client.callTool({ name: "update_shopping_list", arguments: { sections: sectionsFor(["test-draft-salad", "steamed-rice", "steamed-rice"]) } });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(commitLog.at(-1).paths, ["shopping-list.json"]);
  const stored = JSON.parse(files.get("shopping-list.json").toString());
  assert.deepEqual(stored.recipes, ["steamed-rice", "test-draft-salad"]);
  assert.match(stored.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(stored.sections[0].items[0], {
    name: "Red onions",
    quantity: "3",
    note: "for both",
    recipes: ["test-draft-salad", "steamed-rice"],
    amounts: { "test-draft-salad": 1.5, "steamed-rice": 1.5 },
  });
  assert.deepEqual(stored.servings, { "steamed-rice": 4, "test-draft-salad": 4 });
  assert.deepEqual(stored.sections[0].items[1], { name: "Parsley", recipes: ["test-draft-salad", "steamed-rice"] });
  assert.match(await shopping(), /Status: current/);

  // Changing THIS week doesn't touch the list; changing next week makes it outdated (but keeps it).
  await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["harissa-tuna-pitta"], add: true } });
  assert.match(await shopping(), /Status: current/);
  await client.callTool({ name: "set_week_recipes", arguments: { week: "next", slugs: ["harissa-tuna-pitta"], add: true } });
  const outdated = await shopping();
  assert.match(outdated, /Status: outdated/);
  assert.match(outdated, /test-draft-salad.*\[draft\]/);
  assert.match(outdated, /- Harissa Tuna Pitta/);
  await client.callTool({ name: "update_shopping_list", arguments: { sections: await nextSections() } });
  assert.deepEqual(JSON.parse(files.get("shopping-list.json").toString()).recipes, ["harissa-tuna-pitta", "steamed-rice", "test-draft-salad"]);
  const listBefore = files.get("shopping-list.json").toString();

  // The switch: next week becomes this week in one commit; the list file isn't touched.
  const commits = commitLog.length;
  const sw = await client.callTool({ name: "start_next_week", arguments: {} });
  assert.ok(!sw.isError, text(sw));
  assert.equal(commitLog.length, commits + 1);
  assert.match(commitLog.at(-1).message, /^Start next week \(3 recipes this week\)/);
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["recipes/harissa-tuna-pitta.md", "recipes/steamed-rice.md", "recipes/test-draft-salad.md"]);
  assert.deepEqual((await thisWeek()).sort(), ["harissa-tuna-pitta", "steamed-rice", "test-draft-salad"]);
  assert.deepEqual(await nextWeek(), []);
  assert.doesNotMatch(files.get("recipes/steamed-rice.md").toString(), /^next:/m);
  assert.equal(files.get("shopping-list.json").toString(), listBefore);
  assert.match(await shopping(), /Status: not planned/);
  assert.match(text(sw), /already in this week too: harissa-tuna-pitta, steamed-rice/);

  // Nothing in next week: nothing to shop for.
  const none = await client.callTool({ name: "update_shopping_list", arguments: { sections: sectionsFor(["steamed-rice"]) } });
  assert.ok(none.isError);
  assert.match(text(none), /Next week has no recipes/);

  // Switching again with an empty next week empties this week, except what's carried over; drafts that leave go back to the book.
  const badCarry = await client.callTool({ name: "start_next_week", arguments: { carry_over: ["test-lentil-soup"] } });
  assert.ok(badCarry.isError);
  assert.match(text(badCarry), /"test-lentil-soup" is not in this week/);
  const sw2 = await client.callTool({ name: "start_next_week", arguments: { carry_over: ["harissa-tuna-pitta"] } });
  assert.ok(!sw2.isError, text(sw2));
  assert.match(text(sw2), /carried over from last week: harissa-tuna-pitta/);
  assert.match(text(sw2), /left this week: steamed-rice/);
  assert.match(text(sw2), /drafts back in the book .*: test-draft-salad/);
  assert.deepEqual(await thisWeek(), ["harissa-tuna-pitta"]);
  assert.match(files.get("recipes/test-draft-salad.md").toString(), /^draft: true\n---$/m);
  assert.ok(files.has("shopping-list.json"));
  await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["harissa-tuna-pitta"], add: false } });
});

test("batch_changes lands everything in one commit, each operation seeing the ones before it", async () => {
  // A full week's turnover: last week's next-week recipes go into this week, a draft is carried over, a new week is planned.
  await client.callTool({ name: "set_week_recipes", arguments: { week: "next", slugs: ["steamed-rice"], add: true } });
  await client.callTool({ name: "set_week_recipes", arguments: { week: "this", slugs: ["test-draft-salad", "harissa-tuna-pitta"], add: true } });
  const commits = commitLog.length;
  const ops = [
    { action: "start_next_week", carry_over: ["test-draft-salad"] },
    { action: "create_recipe", ...base, title: "Batch Bean Stew", week: "next", image: { url: "https://img.example/dish.png" } },
    { action: "create_recipe", ...base, title: "Batch Pea Soup", week: "next", instructions: ["Add 200g **red lentils**", "Season with **Salt**"], image: { url: "https://img.example/dish.png" } },
    { action: "set_week_recipes", week: "next", slugs: ["steamed-rice"], add: true },
    { action: "update_recipe", slug: "batch-pea-soup", serves: 2 },
    { action: "update_shopping_list", sections: sectionsFor(["batch-bean-stew", "batch-pea-soup", "steamed-rice"]) },
  ];

  const dry = await client.callTool({ name: "batch_changes", arguments: { operations: ops, dry_run: true } });
  assert.ok(!dry.isError, text(dry));
  assert.match(text(dry), /Dry run: nothing committed/);
  assert.match(text(dry), /3\. Created "batch-pea-soup" \(draft, next week\).*\n\s+warning: /);
  assert.equal(commitLog.length, commits);
  assert.equal(files.has("recipes/batch-bean-stew.md"), false);

  const r = await client.callTool({ name: "batch_changes", arguments: { operations: ops } });
  assert.ok(!r.isError, text(r));
  assert.equal(commitLog.length, commits + 1);
  const c = commitLog.at(-1);
  assert.deepEqual(c.paths.sort(), [
    "images/recipes/batch-bean-stew.jpg",
    "images/recipes/batch-pea-soup.jpg",
    "recipes/batch-bean-stew.md",
    "recipes/batch-pea-soup.md",
    "recipes/harissa-tuna-pitta.md",
    "recipes/steamed-rice.md",
    "shopping-list.json",
  ]);
  assert.match(c.message, /^Batch update: 6 changes\n\n- Start next week \(2 recipes this week\)\n- Add draft recipe: Batch Bean Stew \(next week\)\n/);
  assert.match(files.get("recipes/batch-pea-soup.md").toString(), /^serves: 2$/m);
  assert.match(files.get("recipes/batch-pea-soup.md").toString(), /^next: true\ndraft: true$/m);
  assert.deepEqual((await thisWeek()).sort(), ["steamed-rice", "test-draft-salad"]);
  assert.deepEqual((await nextWeek()).sort(), ["batch-bean-stew", "batch-pea-soup", "steamed-rice"]);
  assert.deepEqual(JSON.parse(files.get("shopping-list.json").toString()).recipes, ["batch-bean-stew", "batch-pea-soup", "steamed-rice"]);
  assert.match(await shopping(), /Status: current/);
  assert.doesNotMatch(text(r), /refresh it/);

  // All or nothing: a rejected operation commits nothing, not even the valid ones before it.
  const bad = await client.callTool({
    name: "batch_changes",
    arguments: {
      operations: [
        { action: "update_recipe", slug: "batch-bean-stew", serves: 6 },
        { action: "promote_recipe", slug: "steamed-rice" },
      ],
    },
  });
  assert.ok(bad.isError);
  assert.match(text(bad), /operations\[1\] \(promote_recipe\) failed, so nothing was committed/);
  assert.equal(commitLog.length, commits + 1);
  assert.doesNotMatch(files.get("recipes/batch-bean-stew.md").toString(), /^serves: 6$/m);

  // Changing next week without a shopping list afterwards gets a reminder; changing only this week doesn't.
  const thisOnly = await client.callTool({ name: "batch_changes", arguments: { operations: [{ action: "set_week_recipes", week: "this", slugs: ["test-draft-salad"], add: false }] } });
  assert.doesNotMatch(text(thisOnly), /refresh it/);
  const off = await client.callTool({
    name: "batch_changes",
    arguments: { operations: [{ action: "promote_recipe", slug: "batch-bean-stew" }, { action: "set_week_recipes", week: "next", slugs: ["steamed-rice"], add: false }] },
  });
  assert.ok(!off.isError, text(off));
  assert.match(text(off), /refresh it with update_shopping_list/);
  // Clear both weeks for later tests (the list file stays: only a new list replaces it).
  const clear = await client.callTool({
    name: "batch_changes",
    arguments: {
      operations: [
        { action: "promote_recipe", slug: "batch-pea-soup" },
        { action: "set_week_recipes", week: "next", slugs: ["batch-bean-stew", "batch-pea-soup"], add: false },
        { action: "set_week_recipes", week: "this", slugs: ["steamed-rice"], add: false },
      ],
    },
  });
  assert.ok(!clear.isError, text(clear));
  assert.ok(files.has("shopping-list.json"));
  assert.deepEqual([await thisWeek(), await nextWeek()], [[], []]);
});

test("remove_draft deletes a disliked draft and its photo, refuses regular recipes and drafts planned for next week", async () => {
  const draftOps = (title, week) => ({ action: "create_recipe", ...base, title, ...(week ? { week } : {}), image: { url: "https://img.example/dish.png" } });
  const created = await client.callTool({ name: "batch_changes", arguments: { operations: [draftOps("Remove Me Stew", "this"), draftOps("Keep Me Stew", "this"), draftOps("Planned Stew", "next")] } });
  assert.ok(!created.isError, text(created));
  await client.callTool({ name: "set_week_recipes", arguments: { week: "next", slugs: ["remove-me-stew"], add: false } });

  // Regular recipes (and unknown slugs) can't be removed; nothing is committed.
  const commits = commitLog.length;
  const regular = await client.callTool({ name: "remove_draft", arguments: { slug: "steamed-rice" } });
  assert.ok(regular.isError);
  assert.match(text(regular), /not a draft/);
  const missing = await client.callTool({ name: "remove_draft", arguments: { slug: "no-such-recipe" } });
  assert.ok(missing.isError);
  // A draft that's planned for next week is kept, even if they didn't like it this week.
  const planned = await client.callTool({ name: "remove_draft", arguments: { slug: "planned-stew" } });
  assert.ok(planned.isError);
  assert.match(text(planned), /planned for next week, so it isn't removed/);
  assert.equal(commitLog.length, commits);
  assert.ok(files.has("recipes/steamed-rice.md"));
  assert.ok(files.has("recipes/planned-stew.md"));

  // A draft that was promoted is a regular recipe and is protected too.
  await client.callTool({ name: "promote_recipe", arguments: { slug: "keep-me-stew" } });
  const promoted = await client.callTool({ name: "remove_draft", arguments: { slug: "keep-me-stew" } });
  assert.ok(promoted.isError);
  assert.ok(files.has("recipes/keep-me-stew.md"));

  // Removing a draft deletes its recipe + photo in one commit.
  const r = await client.callTool({ name: "remove_draft", arguments: { slug: "remove-me-stew" } });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["images/recipes/remove-me-stew.jpg", "recipes/remove-me-stew.md"]);
  assert.match(commitLog.at(-1).message, /^Remove draft recipe: Remove Me Stew/);
  assert.equal(files.has("recipes/remove-me-stew.md"), false);
  assert.equal(files.has("images/recipes/remove-me-stew.jpg"), false);
  assert.equal((await listed()).some((x) => x.slug === "remove-me-stew"), false);

  // Clean up the recipes this test created so later tests see the original recipe set.
  for (const slug of ["keep-me-stew", "planned-stew"]) {
    files.delete(`recipes/${slug}.md`);
    files.delete(`images/recipes/${slug}.jpg`);
  }
});

test("refuses duplicate slug", async () => {
  const r = await client.callTool({ name: "create_recipe", arguments: { ...base, image: { url: "https://img.example/dish.png" } } });
  assert.ok(r.isError);
  assert.match(text(r), /already exists/);
});

test("update keeps untouched sections and trailing text", async () => {
  const before = files.get("recipes/harissa-tuna-pitta.md").toString();
  const r = await client.callTool({ name: "update_recipe", arguments: { slug: "harissa-tuna-pitta", serves: 2, instructions: ["Mix the **tuna** and **harissa**", "Stuff the pitta"] } });
  assert.ok(!r.isError, text(r));
  const after = files.get("recipes/harissa-tuna-pitta.md").toString();
  assert.match(after, /serves: 2/);
  assert.match(after, /1\. Mix the \*\*tuna\*\*/);
  assert.match(after, /Approx\. 436 kcal/);
  assert.equal(after.split("## Instructions")[0].replace("serves: 2", "serves: 1"), before.split("## Instructions")[0]);
  assert.match(text(r), /mentions "wholemeal \(wholewheat\) pitta"|Warnings|Updated/);
});

test("upload link flow for a new recipe, and webp -> jpg swap for an existing one", async () => {
  const r = await client.callTool({ name: "create_image_upload_link", arguments: { title: "Upload Test Curry" } });
  assert.ok(!r.isError, text(r));
  const link = text(r).match(/https:\/\/mcp\.test\/upload\?t=\S+/)[0];
  const page = await (await fetch(link)).text();
  assert.match(page, /upload-test-curry/);

  const missing = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Upload Test Curry", image: { uploaded: true } } });
  assert.ok(missing.isError);

  const form = new FormData();
  form.append("photo", new Blob([photo]), "p.png");
  const up = await fetch(link, { method: "POST", body: form, headers: { Accept: "application/json" } });
  assert.equal(up.status, 200, await up.clone().text());
  // Not on any page yet, so it must not trigger a site deploy on its own.
  assert.match(commitLog.at(-1).message, /^Add photo: upload-test-curry \[skip ci\]/);
  const done = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Upload Test Curry", image: { uploaded: true } } });
  assert.ok(!done.isError, text(done));

  const r2 = await client.callTool({ name: "create_image_upload_link", arguments: { slug: "steamed-rice" } });
  const link2 = text(r2).match(/https:\/\/mcp\.test\/upload\?t=\S+/)[0];
  const up2 = await fetch(link2, { method: "POST", body: form, headers: { Accept: "application/json" } });
  assert.equal(up2.status, 200);
  assert.doesNotMatch(commitLog.at(-1).message, /skip ci/);
  assert.ok(files.has("images/recipes/steamed-rice.jpg"));
  assert.ok(!files.has("images/recipes/steamed-rice.webp"));
  assert.match(files.get("recipes/steamed-rice.md").toString(), /image: \/images\/recipes\/steamed-rice\.jpg/);
});

test("one upload link covers several recipes; each photo is its own upload, only for the recipes on the link", async () => {
  const bad = await client.callTool({ name: "create_image_upload_link", arguments: { recipes: [{ title: "Multi Photo Pie" }, { title: "Multi Photo Pie" }] } });
  assert.ok(bad.isError);
  assert.match(text(bad), /listed twice/);
  const both = await client.callTool({ name: "create_image_upload_link", arguments: { recipes: [{ title: "Multi" }], slug: "steamed-rice" } });
  assert.ok(both.isError);

  const r = await client.callTool({
    name: "create_image_upload_link",
    arguments: { recipes: [{ title: "Multi Photo Pie" }, { title: "Multi Photo Tart" }, { slug: "harissa-tuna-pitta" }] },
  });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /3 recipes/);
  assert.match(text(r), /1\. Multi Photo Pie \(multi-photo-pie\) \[new recipe\]/);
  assert.match(text(r), /3\. Harissa Tuna Pitta.*\(harissa-tuna-pitta\) \[replaces the current photo\]/);
  const links = text(r).match(/https:\/\/mcp\.test\/upload\?t=\S+/g);
  assert.equal(links.length, 1);
  const link = links[0];

  const page = await (await fetch(link)).text();
  assert.match(page, /Upload 3 recipe photos/);
  assert.equal(page.match(/<form class="item"/g).length, 3);
  assert.match(page, /value="multi-photo-tart"/);

  const post = (slug) => {
    const form = new FormData();
    if (slug) form.append("slug", slug);
    form.append("photo", new Blob([photo]), "p.png");
    return fetch(link, { method: "POST", body: form, headers: { Accept: "application/json" } });
  };
  const commits = commitLog.length;
  assert.equal((await post("steamed-rice")).status, 403); // a real recipe, but not on this link
  assert.equal((await post(null)).status, 403); // several recipes: the page must say which
  assert.equal(commitLog.length, commits);

  for (const slug of ["multi-photo-tart", "multi-photo-pie"]) {
    const res = await post(slug);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).slug, slug);
    assert.ok(files.has(`images/recipes/${slug}.jpg`));
  }
  assert.equal(commitLog.length, commits + 2);
  assert.ok(commitLog.slice(-2).every((c) => /\[skip ci\]/.test(c.message)));

  const created = await client.callTool({
    name: "batch_changes",
    arguments: {
      operations: ["Multi Photo Pie", "Multi Photo Tart"].map((title) => ({ action: "create_recipe", ...base, title, image: { uploaded: true } })),
    },
  });
  assert.ok(!created.isError, text(created));
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["recipes/multi-photo-pie.md", "recipes/multi-photo-tart.md"]);
});

test("generates a 4:3 photo from the recipe", async () => {
  const before = imageRequests.length;
  const r = await client.callTool({
    name: "create_recipe",
    arguments: { ...base, title: "Generated Lentil Stew", image: { generate: true, description: "thick orange stew in a blue bowl" } },
  });
  assert.ok(!r.isError, text(r));
  const [req] = imageRequests.slice(before);
  assert.equal(req.model, "meta/muse-image");
  assert.equal(req.auth, "Bearer or-test");
  assert.match(req.prompt, /"Generated Lentil Stew"/);
  assert.match(req.prompt, /thick orange stew in a blue bowl/);
  assert.match(req.prompt, /red lentils, Salt/);
  const meta = await sharp(files.get("images/recipes/generated-lentil-stew.jpg")).metadata();
  assert.equal(meta.format, "jpeg");
  assert.deepEqual([meta.width, meta.height], [1024, 768]);
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["images/recipes/generated-lentil-stew.jpg", "recipes/generated-lentil-stew.md"]);
});

test("update_recipe regenerates from the stored recipe", async () => {
  const before = imageRequests.length;
  const r = await client.callTool({ name: "update_recipe", arguments: { slug: "generated-lentil-stew", image: { generate: true } } });
  assert.ok(!r.isError, text(r));
  assert.match(imageRequests[before].prompt, /red lentils, Salt/);
  assert.deepEqual(commitLog.at(-1).paths, ["images/recipes/generated-lentil-stew.jpg"]);
});

test("batch_changes generates photos in parallel; dry runs and failures commit nothing", async () => {
  const ops = ["Parallel Pie", "Parallel Tart", "Parallel Flan"].map((title) => ({ action: "create_recipe", ...base, title, image: { generate: true } }));
  const commits = commitLog.length;
  let before = imageRequests.length;

  const dry = await client.callTool({ name: "batch_changes", arguments: { operations: ops, dry_run: true } });
  assert.ok(!dry.isError, text(dry));
  assert.equal(imageRequests.length, before);

  const failed = await client.callTool({
    name: "batch_changes",
    arguments: { operations: [...ops, { action: "create_recipe", ...base, title: "FAIL Soup", image: { generate: true } }] },
  });
  assert.ok(failed.isError);
  assert.match(text(failed), /operations\[3\].*nothing was committed[\s\S]*moderated[\s\S]*create_image_upload_link/);
  assert.equal(commitLog.length, commits);

  before = imageRequests.length;
  maxInFlight = 0;
  const r = await client.callTool({ name: "batch_changes", arguments: { operations: ops } });
  assert.ok(!r.isError, text(r));
  assert.equal(imageRequests.length - before, 3);
  assert.equal(maxInFlight, 3);
  assert.equal(commitLog.length, commits + 1);
  assert.equal(commitLog.at(-1).paths.filter((p) => p.startsWith("images/")).length, 3);
});

test("links made before multi-recipe uploads still work", async () => {
  const { createHmac } = await import("node:crypto");
  const payload = Buffer.from(JSON.stringify({ slug: "steamed-rice", exp: Date.now() + 60_000 })).toString("base64url");
  const sig = createHmac("sha256", "upload-link:secret").update(payload).digest("base64url");
  const page = await (await fetch(`https://mcp.test/upload?t=${payload}.${sig}`)).text();
  assert.match(page, /Upload the recipe photo/);
  assert.match(page, /value="steamed-rice"/);
});

test("tampered upload token is rejected", async () => {
  const res = await fetch("https://mcp.test/upload?t=eyJzbHVnIjoiYnVpbGQifQ.forged");
  assert.equal(res.status, 403);
});

test("stocktake: only a signed-in editor saves what's at home, for the list the page was loaded with", async () => {
  await client.callTool({ name: "set_week_recipes", arguments: { week: "next", slugs: ["steamed-rice"], add: true } });
  // The amounts are all for steamed-rice, planned for 2 (the list's base), so the stocktake reads in base amounts.
  const all = await nextWeek();
  const sections = [
    { name: "Fresh produce", items: [{ quantity: "3", name: "Red onions", note: "for both", recipes: ["steamed-rice"] }, { name: "Parsley", recipes: all }] },
    { name: "Pantry", items: [{ quantity: "400g", name: "Red lentils", recipes: ["steamed-rice"] }] },
  ];
  const saveList = await client.callTool({ name: "update_shopping_list", arguments: { sections, servings: { "steamed-rice": 2 } } });
  assert.ok(!saveList.isError, text(saveList));
  const site = "https://petrotiurin.github.io";
  const post = (body, token = "owner-token") =>
    stocktake.POST(
      new Request("https://mcp.test/stocktake", {
        method: "POST",
        headers: { Origin: site, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      })
    );
  const items = [
    { name: "Red onions", quantity: "3", have: 1 },
    { name: "Parsley", have: true },
    { name: "Red lentils", quantity: "400g" },
  ];

  const preflight = stocktake.OPTIONS(new Request("https://mcp.test/stocktake", { method: "OPTIONS", headers: { Origin: site } }));
  assert.equal(preflight.headers.get("access-control-allow-origin"), site);
  const elsewhere = stocktake.OPTIONS(new Request("https://mcp.test/stocktake", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
  assert.equal(elsewhere.headers.get("access-control-allow-origin"), null);

  const commits = commitLog.length;
  assert.equal((await post({ items }, null)).status, 401);
  assert.equal((await post({ items }, "expired-token")).status, 401);
  const stranger = await post({ items }, "stranger-token");
  assert.equal(stranger.status, 403);
  assert.match((await stranger.json()).error, /stranger@example\.com isn't allowed/);
  // A page loaded before the agent replaced the list can't write onto the new one.
  const stale = await post({ items: items.map((i) => (i.name === "Red lentils" ? { ...i, quantity: "300g" } : i)) });
  assert.equal(stale.status, 409);
  assert.equal((await post({ items: items.slice(1) })).status, 409);
  const noAmount = await post({ items: items.map((i) => (i.name === "Parsley" ? { ...i, have: 2 } : i)) });
  assert.equal(noAmount.status, 400);
  assert.match((await noAmount.json()).error, /Parsley.*have: true/);
  assert.equal(commitLog.length, commits, "nothing is committed for a refused stocktake");

  const saved = await post({ items });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(saved.headers.get("access-control-allow-origin"), site);
  assert.deepEqual(commitLog.at(-1).paths, ["shopping-list.json"]);
  assert.match(commitLog.at(-1).message, /^Update shopping list stocktake \(1 of 3 items at home, 1 partly\)/);
  const stored = JSON.parse(files.get("shopping-list.json").toString());
  assert.match(stored.stocktake, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(stored.sections[0].items, [
    { name: "Red onions", quantity: "3", note: "for both", recipes: ["steamed-rice"], have: 1 },
    { name: "Parsley", recipes: all, have: true },
  ]);
  assert.deepEqual(stored.sections[1].items, [{ name: "Red lentils", quantity: "400g", recipes: ["steamed-rice"] }]);

  const listText = await shopping();
  assert.match(listText, /Fresh produce \/ Red onions: 2 \(for both\) \[have 1 of 3\]/);
  assert.match(listText, /Pantry \/ Red lentils: 400g/);
  assert.match(listText, /Already at home \(skip\):\n- Parsley/);

  // Re-saving replaces the whole stocktake; a new list from the agent starts without one.
  await post({ items: items.map(({ have: _, ...i }) => (i.name === "Red lentils" ? { ...i, have: 150 } : i)) });
  assert.deepEqual(JSON.parse(files.get("shopping-list.json").toString()).sections[1].items[0], { name: "Red lentils", quantity: "400g", recipes: ["steamed-rice"], have: 150 });
  assert.match(await shopping(), /Red lentils: 250g \[have 150g of 400g\]/);

  // Re-planning one recipe keeps the list and the stocktake; what's left to buy follows the plan.
  const before = JSON.parse(files.get("shopping-list.json").toString());
  const replan = await client.callTool({ name: "set_shopping_servings", arguments: { servings: { "steamed-rice": 1 } } });
  assert.ok(!replan.isError, text(replan));
  assert.deepEqual(commitLog.at(-1).paths, ["shopping-list.json"]);
  const replanned = JSON.parse(files.get("shopping-list.json").toString());
  assert.deepEqual(replanned.sections, before.sections);
  assert.equal(replanned.stocktake, before.stocktake);
  assert.equal(replanned.servings["steamed-rice"], 1);
  assert.match(await shopping(), /Red lentils: 50g \[have 150g of 200g\]/);
  assert.match(await shopping(), /Fresh produce \/ Red onions: 1\.5 \(for both\)\n/);
  const commits2 = commitLog.length;
  const same = await client.callTool({ name: "set_shopping_servings", arguments: { servings: { "steamed-rice": 1 } } });
  assert.match(text(same), /Nothing changed/);
  assert.equal(commitLog.length, commits2);
  const notOnList = await client.callTool({ name: "set_shopping_servings", arguments: { servings: { "harissa-tuna-pitta": 1 } } });
  assert.ok(notOnList.isError);
  assert.match(text(notOnList), /"harissa-tuna-pitta" is not on the shopping list/);

  // A rebuilt list keeps the plan for recipes it doesn't name, and starts without a stocktake.
  await client.callTool({ name: "update_shopping_list", arguments: { sections } });
  assert.equal(JSON.parse(files.get("shopping-list.json").toString()).servings["steamed-rice"], 1);
  const fresh = JSON.parse(files.get("shopping-list.json").toString());
  assert.equal(fresh.stocktake, undefined);
  assert.ok(fresh.sections.flatMap((s) => s.items).every((i) => !("have" in i)));
  assert.match(await shopping(), /Stocktake: none saved/);
});

test("no commit ever touches a path outside recipes/, images/recipes/ and shopping-list.json", () => {
  for (const c of commitLog) for (const p of c.paths) assert.match(p, /^(recipes\/[a-z0-9-]+\.md|images\/recipes\/[a-z0-9-]+\.(jpg|webp)|shopping-list\.json)$/);
  assert.equal(files.get("build.js").toString(), "// build");
});
