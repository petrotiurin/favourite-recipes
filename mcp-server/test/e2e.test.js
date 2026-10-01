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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["create_image_upload_link", "create_recipe", "get_recipe", "list_recipes", "update_recipe"]);
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
  const done = await client.callTool({ name: "create_recipe", arguments: { ...base, title: "Upload Test Curry", image: { uploaded: true } } });
  assert.ok(!done.isError, text(done));

  const r2 = await client.callTool({ name: "create_image_upload_link", arguments: { slug: "steamed-rice" } });
  const link2 = text(r2).match(/https:\/\/mcp\.test\/upload\?t=\S+/)[0];
  const up2 = await fetch(link2, { method: "POST", body: form, headers: { Accept: "application/json" } });
  assert.equal(up2.status, 200);
  assert.ok(files.has("images/recipes/steamed-rice.jpg"));
  assert.ok(!files.has("images/recipes/steamed-rice.webp"));
  assert.match(files.get("recipes/steamed-rice.md").toString(), /image: \/images\/recipes\/steamed-rice\.jpg/);
});

test("tampered upload token is rejected", async () => {
  const res = await fetch("https://mcp.test/upload?t=eyJzbHVnIjoiYnVpbGQifQ.forged");
  assert.equal(res.status, 403);
});

test("no commit ever touches a path outside recipes/ and images/recipes/", () => {
  for (const c of commitLog) for (const p of c.paths) assert.match(p, /^(recipes\/[a-z0-9-]+\.md|images\/recipes\/[a-z0-9-]+\.(jpg|webp))$/);
  assert.equal(files.get("build.js").toString(), "// build");
});
