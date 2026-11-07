#!/usr/bin/env node
// Local dev harness: the whole chat stack on your machine, with nothing real behind it.
//
//   cd mcp-server && npm run dev            (builds the site, then starts both servers)
//   npm run dev -- --no-build               (reuse the existing ../dist)
//
//   http://localhost:4000   the built site (../dist), built with CHAT_API_URL=http://localhost:8787/chat
//   http://localhost:8787   the backend: /chat, /stocktake, /upload, /mcp (the api/*.js handlers, as Vercel would run them)
//
// Everything outside is faked in-process (scripts/fakes.js), by wrapping global fetch:
//   GitHub     your working tree's recipes/, images/ and shopping-list.json, read from disk; commits live in memory only
//              (the real files are never written, restart to reset)
//   OpenRouter a scripted model. Try: "chicken" (search tool + linked list + suggestions), "this recipe" (uses the page the
//              user is on), "shopping", "mock-add" (a write attempt the public role must be refused), "mock-402" (out of
//              credit), "mock-500", "mock-stream-error", or anything else for a plain reply with suggestions
//   Supabase   /auth/v1/user for the tokens "dev-editor-token" (editor@example.com, in EDITORS) and "dev-stranger-token",
//              and the rate_limit_hit counters in memory. Limits are 20/hour, 100/day per IP; to see the 429 quickly
//              start with CHAT_PUBLIC_HOURLY_LIMIT=3 npm run dev
//   Langfuse   off (set LANGFUSE_* yourself to trace to a real one)
//
// Env you can override: CHAT_API_PORT (8787), SITE_PORT (4000). Later phases extend this file (fake Supabase tables, editor chat).
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeGitHub, createMockOpenRouter, createFakeSupabase } from "./fakes.js";

const API_PORT = Number(process.env.CHAT_API_PORT) || 8787;
const SITE_PORT = Number(process.env.SITE_PORT) || 4000;
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(REPO, "dist");

// Local configuration, set before the handlers (and lib/config.js) are imported. Anything already in the environment wins.
const env = {
  GITHUB_TOKEN: "dev-github",
  MCP_AUTH_TOKEN: "dev-secret",
  PUBLIC_SITE_URL: `http://localhost:${SITE_PORT}`,
  SUPABASE_URL: "http://supabase.fake",
  SUPABASE_ANON_KEY: "dev-anon",
  SUPABASE_SERVICE_ROLE_KEY: "dev-service",
  EDITORS: "editor@example.com",
  OPENROUTER_CHAT_PUBLIC_KEY: "dev-openrouter",
  OPENROUTER_BASE_URL: "http://openrouter.fake/api/v1",
};
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const github = createFakeGitHub();
const openrouter = createMockOpenRouter();
const supabase = createFakeSupabase({
  url: process.env.SUPABASE_URL,
  anonKey: process.env.SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  users: {
    "dev-editor-token": { id: "00000000-0000-0000-0000-0000000000e1", email: "editor@example.com" },
    "dev-stranger-token": { id: "00000000-0000-0000-0000-0000000000a1", email: "stranger@example.com" },
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.github.com/")) return github.fetch(url, init);
  if (url.startsWith(process.env.OPENROUTER_BASE_URL) || url.startsWith("https://openrouter.ai/api/v1/chat/completions")) return openrouter.fetch(url, init);
  if (url.startsWith(process.env.SUPABASE_URL)) return supabase.fetch(url, init);
  return realFetch(input, init);
};

const handlers = {
  "/chat": await import("../api/chat.js"),
  "/stocktake": await import("../api/stocktake.js"),
  "/upload": await import("../api/upload.js"),
  "/mcp": await import("../api/mcp.js"),
};

// --- the backend: Node http -> Web Request -> handler -> Web Response ------------------------------------------------------
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const handler = handlers[url.pathname];
  const fn = handler?.[req.method];
  if (!fn) {
    res.writeHead(handler ? 405 : 404, { "content-type": "application/json" }).end(JSON.stringify({ error: handler ? "Method not allowed" : "Not found" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const abort = new AbortController();
  res.on("close", () => !res.writableEnded && abort.abort());
  const request = new Request(url, {
    method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1" },
    body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : body,
    signal: abort.signal,
  });
  try {
    const response = await fn(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Server error" }));
  }
});

// --- the site: ../dist, built to talk to the local backend -----------------------------------------------------------------
if (!process.argv.includes("--no-build")) {
  console.log("Building the site (CHAT_API_URL points at the local backend)…");
  const build = spawnSync("node", ["build.js"], { cwd: REPO, stdio: "inherit", env: { ...process.env, CHAT_API_URL: `http://localhost:${API_PORT}/chat` } });
  if (build.status !== 0) process.exit(build.status || 1);
}
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".svg": "image/svg+xml" };
const site = http.createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
});

api.listen(API_PORT, () => console.log(`Backend  http://localhost:${API_PORT}  (/chat, /stocktake, /upload, /mcp)`));
site.listen(SITE_PORT, () => console.log(`Site     http://localhost:${SITE_PORT}   (open this; the chat bubble is bottom right)`));
