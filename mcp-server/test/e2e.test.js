// End-to-end: real MCP client -> api/mcp.js handler -> fake in-memory GitHub API.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";

// --- fake GitHub: repo files live in a Map, commits update it -------------
const ROOT = new URL("../../", import.meta.url);
const files = new Map();
for (const dir of ["recipes", "images/recipes"]) {
  for (const f of readdirSync(new URL(dir + "/", ROOT))) files.set(`${dir}/${f}`, readFileSync(new URL(`${dir}/${f}`, ROOT)));
}
// Start from a repo where nothing is a draft or current, whatever the real recipes are marked as right now.
for (const [p, buf] of files) if (p.endsWith(".md")) files.set(p, Buffer.from(buf.toString().replace(/^(draft|current): true\n/gm, "")));
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

let mcp, upload, client;
before(async () => {
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("https://api.github.com/")) return fakeGitHub(s, init);
    if (s === "https://img.example/dish.png") return new Response(photo, { headers: { "content-type": "image/png" } });
    if (s.startsWith("https://mcp.test/upload")) return upload[init?.method || "GET"](new Request(s, init));
    if (s.startsWith("https://mcp.test/")) return mcp[init?.method || "GET"](new Request(s, init));
    return realFetch(url, init);
  };
  mcp = await import("../api/mcp.js");
  upload = await import("../api/upload.js");
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["batch_changes", "create_image_upload_link", "create_recipe", "get_recipe", "get_shopping_list", "list_recipes", "promote_recipe", "remove_draft", "set_current_recipes", "update_recipe", "update_shopping_list"]);
  const r = await client.callTool({ name: "list_recipes", arguments: {} });
  const list = JSON.parse(text(r));
  assert.ok(list.find((x) => x.slug === "harissa-tuna-pitta"));
});

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

test("drafts are listed first and promote_recipe turns them into regular recipes that stay current", async () => {
  const list = JSON.parse(text(await client.callTool({ name: "list_recipes", arguments: {} })));
  assert.equal(list[0].slug, "test-lentil-soup");
  assert.equal(list[0].draft, true);

  const before = files.get("recipes/test-lentil-soup.md").toString();
  const r = await client.callTool({ name: "promote_recipe", arguments: { slug: "test-lentil-soup" } });
  assert.ok(!r.isError, text(r));
  assert.equal(files.get("recipes/test-lentil-soup.md").toString(), before.replace("draft: true\n", "current: true\n"));
  assert.deepEqual(commitLog.at(-1).paths, ["recipes/test-lentil-soup.md"]);
  assert.match(commitLog.at(-1).message, /^Promote recipe: Test Lentil Soup/);

  const again = await client.callTool({ name: "promote_recipe", arguments: { slug: "test-lentil-soup" } });
  assert.ok(again.isError);
  assert.match(text(again), /not a draft/);

  // Promoting left it current; take it out of the rotation so later tests start from a clean slate.
  const listed2 = JSON.parse(text(await client.callTool({ name: "list_recipes", arguments: {} })));
  assert.equal(listed2[0].slug, "test-lentil-soup");
  assert.equal(listed2[0].current, true);
  assert.equal(listed2[0].draft, undefined);
  const off = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["test-lentil-soup"], current: false } });
  assert.ok(!off.isError, text(off));
  assert.doesNotMatch(files.get("recipes/test-lentil-soup.md").toString(), /^(draft|current):/m);
});

test("draft: false creates a regular recipe straight away", async () => {
  const r = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Test Regular Soup", draft: false, image: { url: "https://img.example/dish.png" } } });
  assert.ok(!r.isError, text(r));
  assert.doesNotMatch(files.get("recipes/test-regular-soup.md").toString(), /draft/);
});

const sections = [
  { name: "Fresh produce", items: [{ quantity: "3", name: "Red onions", note: "for both" }, { name: "Parsley" }] },
  { name: "Pantry", items: [{ quantity: "400g", name: "Red lentils" }] },
];
const shopping = async (name = "get_shopping_list", args = {}) => text(await client.callTool({ name, arguments: args }));
const listed = async () => JSON.parse(text(await client.callTool({ name: "list_recipes", arguments: {} })));

test("current recipes: marking is one minimal commit, idempotent, and drafts can't be toggled", async () => {
  const before = files.get("recipes/steamed-rice.md").toString();
  const commits = commitLog.length;
  const r = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["steamed-rice", "steamed-rice"], current: true } });
  assert.ok(!r.isError, text(r));
  assert.equal(commitLog.length, commits + 1);
  assert.deepEqual(commitLog.at(-1).paths, ["recipes/steamed-rice.md"]);
  const after = files.get("recipes/steamed-rice.md").toString();
  assert.equal(after, before.replace(/\n---\n/, "\ncurrent: true\n---\n"));

  const again = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["steamed-rice"], current: true } });
  assert.ok(!again.isError);
  assert.match(text(again), /Nothing changed/);
  assert.match(text(again), /Already current: steamed-rice/);
  assert.equal(commitLog.length, commits + 1);

  const missing = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["no-such-recipe"], current: true } });
  assert.ok(missing.isError);

  // Order: drafts, then current, then the rest (alphabetical within each).
  const r2 = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Test Draft Salad", image: { url: "https://img.example/dish.png" } } });
  assert.ok(!r2.isError, text(r2));
  const list = await listed();
  assert.deepEqual(list.slice(0, 2).map((x) => x.slug), ["test-draft-salad", "steamed-rice"]);
  assert.equal(list[0].draft, true);
  assert.equal(list[0].current, true);
  assert.equal(list[1].draft, undefined);
  assert.equal(list[1].current, true);
  assert.equal(list.filter((x) => x.current).length, 2);
  assert.ok(list.slice(2).every((x) => !x.current && !x.draft));

  const onDraft = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["test-draft-salad"], current: true } });
  assert.ok(onDraft.isError);
  assert.match(text(onDraft), /always current/);
  const offDraft = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["steamed-rice", "test-draft-salad"], current: false } });
  assert.ok(offDraft.isError);
  assert.match(text(offDraft), /promote_recipe/);
  assert.match(files.get("recipes/steamed-rice.md").toString(), /current: true/); // nothing committed from the failed call
});

test("shopping list covers current recipes; it stays until rewritten and goes blank only when nothing is current", async () => {
  const dup = await client.callTool({
    name: "update_shopping_list",
    arguments: { sections: [{ name: "A", items: [{ name: "Onions" }] }, { name: "B", items: [{ name: "onions" }] }] },
  });
  assert.ok(dup.isError);
  assert.match(text(dup), /listed twice/);

  const r = await client.callTool({ name: "update_shopping_list", arguments: { sections } });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(commitLog.at(-1).paths, ["shopping-list.json"]);
  const stored = JSON.parse(files.get("shopping-list.json").toString());
  assert.deepEqual(stored.recipes, ["steamed-rice", "test-draft-salad"]);
  assert.match(stored.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(stored.sections[0].items[0], { name: "Red onions", quantity: "3", note: "for both" });
  assert.deepEqual(stored.sections[0].items[1], { name: "Parsley" });
  assert.match(await shopping(), /Status: current/);

  // Unmarking one recipe changes the set: the list is flagged outdated but kept (the draft is still current).
  await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["steamed-rice"], current: false } });
  assert.doesNotMatch(files.get("recipes/steamed-rice.md").toString(), /^current:/m);
  assert.ok(files.has("shopping-list.json"));
  const outdated = await shopping();
  assert.match(outdated, /Status: outdated/);
  assert.match(outdated, /test-draft-salad.*\[draft\]/);
  assert.doesNotMatch(outdated, /- Steamed Rice/);

  // Marking existing recipes is enough on its own: no drafts needed.
  await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["steamed-rice", "harissa-tuna-pitta"], current: true } });
  await client.callTool({ name: "update_shopping_list", arguments: { sections } });
  assert.deepEqual(JSON.parse(files.get("shopping-list.json").toString()).recipes, ["harissa-tuna-pitta", "steamed-rice", "test-draft-salad"]);
  assert.match(await shopping(), /Status: current/);

  // Promoting only touches that recipe's file: it stays current and the shopping list is unaffected.
  const commits = commitLog.length;
  await client.callTool({ name: "promote_recipe", arguments: { slug: "test-draft-salad" } });
  assert.equal(commitLog.length, commits + 1);
  assert.deepEqual(commitLog.at(-1).paths, ["recipes/test-draft-salad.md"]);
  assert.match(files.get("recipes/test-draft-salad.md").toString(), /^current: true$/m);
  assert.doesNotMatch(files.get("recipes/test-draft-salad.md").toString(), /^draft:/m);
  assert.deepEqual((await listed()).filter((x) => x.current).map((x) => x.slug), ["harissa-tuna-pitta", "steamed-rice", "test-draft-salad"]);
  assert.match(await shopping(), /Status: current/);

  // Unmarking the last current recipes deletes the saved list in the same commit, so it can't resurface later.
  await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["harissa-tuna-pitta", "steamed-rice"], current: false } });
  assert.ok(files.has("shopping-list.json"));
  const last = await client.callTool({ name: "set_current_recipes", arguments: { slugs: ["test-draft-salad"], current: false } });
  assert.match(text(last), /shopping list was cleared/);
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["recipes/test-draft-salad.md", "shopping-list.json"]);
  assert.equal(files.has("shopping-list.json"), false);
  assert.match(await shopping(), /Status: none/);
  const none = await client.callTool({ name: "update_shopping_list", arguments: { sections } });
  assert.ok(none.isError);
  assert.match(text(none), /no current recipes/);
});

test("batch_changes lands everything in one commit, each operation seeing the ones before it", async () => {
  const commits = commitLog.length;
  const ops = [
    { action: "create_recipe", ...base, title: "Batch Bean Stew", image: { url: "https://img.example/dish.png" } },
    { action: "create_recipe", ...base, title: "Batch Pea Soup", instructions: ["Add 200g **red lentils**", "Season with **Salt**"], image: { url: "https://img.example/dish.png" } },
    { action: "set_current_recipes", slugs: ["steamed-rice"], current: true },
    { action: "update_recipe", slug: "batch-pea-soup", serves: 2 },
    { action: "update_shopping_list", sections },
  ];

  const dry = await client.callTool({ name: "batch_changes", arguments: { operations: ops, dry_run: true } });
  assert.ok(!dry.isError, text(dry));
  assert.match(text(dry), /Dry run: nothing committed/);
  assert.match(text(dry), /2\. Created "batch-pea-soup" \(draft\).*\n\s+warning: /);
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
    "recipes/steamed-rice.md",
    "shopping-list.json",
  ]);
  assert.match(c.message, /^Batch update: 5 changes\n\n- Add draft recipe: Batch Bean Stew\n/);
  assert.match(files.get("recipes/batch-pea-soup.md").toString(), /^serves: 2$/m);
  assert.match(files.get("recipes/batch-pea-soup.md").toString(), /^draft: true$/m);
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

  // Changing the current set without a shopping list afterwards gets a reminder; then clear everything for later tests.
  const off = await client.callTool({
    name: "batch_changes",
    arguments: { operations: [{ action: "promote_recipe", slug: "batch-bean-stew" }, { action: "set_current_recipes", slugs: ["steamed-rice"], current: false }] },
  });
  assert.ok(!off.isError, text(off));
  assert.match(text(off), /refresh it with update_shopping_list/);
  assert.equal(commitLog.length, commits + 2);
  const clear = await client.callTool({
    name: "batch_changes",
    arguments: {
      operations: [
        { action: "promote_recipe", slug: "batch-pea-soup" },
        { action: "set_current_recipes", slugs: ["batch-bean-stew", "batch-pea-soup"], current: false },
      ],
    },
  });
  assert.ok(!clear.isError, text(clear));
  assert.equal(files.has("shopping-list.json"), false);
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["recipes/batch-bean-stew.md", "recipes/batch-pea-soup.md", "shopping-list.json"]);
  assert.equal((await listed()).filter((x) => x.current).length, 0);
});

test("remove_draft deletes a disliked draft and its photo, refuses regular recipes, and clears the list when nothing is current", async () => {
  const draftOps = (title) => ({ action: "create_recipe", ...base, title, image: { url: "https://img.example/dish.png" } });
  const created = await client.callTool({ name: "batch_changes", arguments: { operations: [draftOps("Remove Me Stew"), draftOps("Keep Me Stew"), { action: "update_shopping_list", sections }] } });
  assert.ok(!created.isError, text(created));

  // Regular recipes (and unknown slugs) can't be removed; nothing is committed.
  const commits = commitLog.length;
  const regular = await client.callTool({ name: "remove_draft", arguments: { slug: "steamed-rice" } });
  assert.ok(regular.isError);
  assert.match(text(regular), /not a draft/);
  const missing = await client.callTool({ name: "remove_draft", arguments: { slug: "no-such-recipe" } });
  assert.ok(missing.isError);
  assert.equal(commitLog.length, commits);
  assert.ok(files.has("recipes/steamed-rice.md"));

  // A draft that was promoted is a regular recipe and is protected too.
  await client.callTool({ name: "promote_recipe", arguments: { slug: "keep-me-stew" } });
  const promoted = await client.callTool({ name: "remove_draft", arguments: { slug: "keep-me-stew" } });
  assert.ok(promoted.isError);
  assert.ok(files.has("recipes/keep-me-stew.md"));

  // Removing a draft deletes its recipe + photo in one commit; other current recipes keep the list alive (but outdated).
  const r = await client.callTool({ name: "remove_draft", arguments: { slug: "remove-me-stew" } });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["images/recipes/remove-me-stew.jpg", "recipes/remove-me-stew.md"]);
  assert.match(commitLog.at(-1).message, /^Remove draft recipe: Remove Me Stew/);
  assert.equal(files.has("recipes/remove-me-stew.md"), false);
  assert.equal(files.has("images/recipes/remove-me-stew.jpg"), false);
  assert.match(text(r), /update_shopping_list/);
  assert.ok(files.has("shopping-list.json"));
  assert.match(await shopping(), /Status: outdated/);
  assert.equal((await listed()).some((x) => x.slug === "remove-me-stew"), false);

  // In a batch: promote + unmark a liked draft and remove a disliked one in a single commit; the last current recipe going clears the list.
  await client.callTool({ name: "batch_changes", arguments: { operations: [draftOps("Remove Me Too Stew")] } });
  const batchCommits = commitLog.length;
  const batch = await client.callTool({
    name: "batch_changes",
    arguments: {
      operations: [
        { action: "remove_draft", slug: "remove-me-too-stew" },
        { action: "set_current_recipes", slugs: ["keep-me-stew"], current: false },
      ],
    },
  });
  assert.ok(!batch.isError, text(batch));
  assert.equal(commitLog.length, batchCommits + 1);
  assert.deepEqual(commitLog.at(-1).paths.sort(), ["images/recipes/remove-me-too-stew.jpg", "recipes/keep-me-stew.md", "recipes/remove-me-too-stew.md", "shopping-list.json"]);
  assert.equal(files.has("shopping-list.json"), false);
  assert.match(text(batch), /shopping list is cleared/);
  assert.doesNotMatch(files.get("recipes/keep-me-stew.md").toString(), /^(draft|current):/m);

  // Clean up the regular recipe this test created so later tests see the original recipe set.
  files.delete("recipes/keep-me-stew.md");
  files.delete("images/recipes/keep-me-stew.jpg");
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

test("no commit ever touches a path outside recipes/, images/recipes/ and shopping-list.json", () => {
  for (const c of commitLog) for (const p of c.paths) assert.match(p, /^(recipes\/[a-z0-9-]+\.md|images\/recipes\/[a-z0-9-]+\.(jpg|webp)|shopping-list\.json)$/);
  assert.equal(files.get("build.js").toString(), "// build");
});
