// Fakes for the outside world, shared by the local dev harness (scripts/dev.js) and the tests, so nothing here ever
// touches the real GitHub, OpenRouter or Supabase:
//   createFakeGitHub    the repo's recipes/, images/ and shopping-list.json read from disk; commits stay in memory
//   createMockOpenRouter a scripted, deterministic chat model that streams OpenAI-format SSE and exercises tool calls
//   createFakeSupabase  /auth/v1/user for a few known tokens, and the rate_limit_hit RPC with in-memory counters
import { readdirSync, readFileSync, existsSync } from "node:fs";

const REPO_ROOT = new URL("../../", import.meta.url);

// --- GitHub -------------------------------------------------------------------------------------------------------

/**
 * A fake of the GitHub REST calls lib/github.js makes. `files` is a Map of repo path -> Buffer, seeded from the working tree
 * (never written back). `clean: true` strips draft/current/next flags so tests start from a known book.
 */
export function createFakeGitHub({ repo = "petrotiurin/favourite-recipes", clean = false, root = REPO_ROOT } = {}) {
  const files = new Map();
  for (const dir of ["recipes", "images/recipes"]) {
    const base = new URL(`${dir}/`, root);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base)) files.set(`${dir}/${f}`, readFileSync(new URL(f, base)));
  }
  for (const f of ["shopping-list.json", "build.js"]) if (existsSync(new URL(f, root))) files.set(f, readFileSync(new URL(f, root)));
  if (clean) for (const [p, buf] of files) if (p.endsWith(".md")) files.set(p, Buffer.from(buf.toString().replace(/^(draft|current|next): true\n/gm, "")));

  const blobs = new Map();
  const trees = new Map();
  const commits = new Map([["c0", { tree: "t0" }]]);
  let head = "c0";
  let n = 0;
  const commitLog = [];

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const path = decodeURI(u.pathname.replace(`/repos/${repo}`, ""));
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
    throw new Error(`fake GitHub: unexpected call ${method} ${path}`);
  }
  return { fetch, files, commitLog };
}

// --- OpenRouter chat -----------------------------------------------------------------------------------------------

const sse = (events, delayMs) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${e === "[DONE]" ? e : JSON.stringify(e)}\n\n`));
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
};

const chunk = (delta, finish = null) => ({ id: "gen-mock", choices: [{ index: 0, delta, finish_reason: finish }] });

/** Streams `text` word by word, then tool calls (arguments split in two pieces, like a real model), then usage. */
function scriptedStream({ text = "", calls = [], delayMs = 12 }) {
  const events = [chunk({ role: "assistant", content: "" })];
  for (const word of text.match(/\S+\s*/g) || []) events.push(chunk({ content: word }));
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.arguments);
    const half = Math.ceil(args.length / 2);
    events.push(chunk({ tool_calls: [{ index, id: `call_mock_${index}_${c.name}`, type: "function", function: { name: c.name, arguments: "" } }] }));
    events.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, half) } }] }));
    events.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] }));
  });
  events.push(chunk({}, calls.length ? "tool_calls" : "stop"));
  events.push({ id: "gen-mock", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.0004 } });
  events.push("[DONE]");
  return sse(events, delayMs);
}

const replies = (...r) => ({ name: "suggest_replies", arguments: { replies: r } });
const showRecipes = (slugs) => ({ name: "show_recipes", arguments: { slugs, reason: "mock" } });
const rowsOf = (toolMessage) => {
  try {
    const rows = JSON.parse(toolMessage.content);
    return Array.isArray(rows) ? rows : [];
  } catch {
    // "No recipes match", or a long result the server cut off: pull out the rows that are whole
    return [...String(toolMessage.content).matchAll(/"slug":\s*"([^"]+)",\s*"title":\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => ({ slug: m[1], title: m[2] }));
  }
};

const userText = (m) => String(m.content).replace(/\n\n\[Note from the site[\s\S]*$/, "");

/**
 * A scripted stand-in for OpenRouter's /chat/completions. Behaviour depends on the latest user message:
 *   "chicken"      -> search_recipes({ include_ingredients: ["chicken"] }), then a short intro + show_recipes (cards) + suggest_replies
 *                     with an action chip ("Open the first one" -> that recipe's page)
 *   "quick"        -> search_recipes (max 25 min) -> cards;   "light" -> search_recipes (max 400 kcal) -> cards
 *   "planned"      -> search_recipes({ week: "next" }) -> cards (the next-week starter chip)
 *   "rice"         -> search_recipes({ text: "rice" }) -> offer_navigation (an "Open <recipe>" button) + replies
 *   "add ... next week" -> a read-only answer with an action chip to the Next week page
 *   "left to buy"  -> the shopping answer (as "shopping")
 *   "this recipe"  -> answers from the site note about the page the user is on (+ suggest_replies)
 *   "shopping"     -> get_shopping_list, then a one-line answer
 *   "mock-402"     -> HTTP 402 (out of credit);   "mock-500" -> HTTP 500;   "mock-stream-error" -> an error event mid-stream
 *   "mock-add"     -> asks for create_recipe, which the public caller must be refused (shows the refusal path)
 *   anything else  -> a plain reply + suggest_replies
 * `requests` records every request body, so tests can assert on what the server sent.
 */
export function createMockOpenRouter({ delayMs = 12 } = {}) {
  const requests = [];
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ ...body, auth: init.headers.Authorization, url: String(url) });
    const msgs = body.messages;
    const lastUserIdx = msgs.findLastIndex((m) => m.role === "user");
    const user = userText(msgs[lastUserIdx]).toLowerCase();
    const note = String(msgs[lastUserIdx].content).match(/\[Note from the site, not from the user: ([\s\S]*)\]$/)?.[1];
    const after = msgs.slice(lastUserIdx + 1);
    const toolResults = after.filter((m) => m.role === "tool");
    const lastTool = toolResults[toolResults.length - 1];
    const calledShown = after.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "suggest_replies"));
    const opts = { delayMs };

    if (user.includes("mock-402")) return new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402 });
    if (user.includes("mock-500")) return new Response("boom", { status: 500 });
    if (user.includes("mock-stream-error")) return sse([chunk({ role: "assistant", content: "Let me" }), { error: { code: 500, message: "upstream died" } }], delayMs);
    if (calledShown) return scriptedStream({ ...opts }); // nothing more to say after the replies were shown

    if (user.includes("mock-add")) {
      if (!lastTool) return scriptedStream({ ...opts, text: "I'll add that.", calls: [{ name: "create_recipe", arguments: { title: "Mock Pie" } }] });
      return scriptedStream({ ...opts, text: "I can't change the site from here, but an editor can sign in to do that.", calls: [replies("How do editors sign in?", "Show me pies")] });
    }
    const searchThenCards = (searchArgs, intro, none) => {
      if (!lastTool) return scriptedStream({ ...opts, text: "Let me check our book.", calls: [{ name: "search_recipes", arguments: searchArgs }] });
      const rows = rowsOf(lastTool);
      const top = rows.slice(0, 3);
      if (!top.length) return scriptedStream({ ...opts, text: none, calls: [replies("What's on this week?", "Show me everything")] });
      return scriptedStream({
        ...opts,
        text: intro(rows.length),
        calls: [
          showRecipes(top.map((r) => r.slug)),
          replies("Under 400 kcal", "Quick ones only", { label: "Open the first one", action: { navigate: top[0].slug } }),
        ],
      });
    };
    if (user.includes("chicken")) return searchThenCards({ include_ingredients: ["chicken"] }, (n) => `We have ${n} with chicken. A few to start with:`, "Nothing with chicken in our book yet.");
    if (user.includes("quick")) return searchThenCards({ max_minutes: 25 }, () => "These are all quick:", "Nothing that quick in our book yet.");
    if (user.includes("light") || user.includes("healthy")) return searchThenCards({ max_calories: 400 }, () => "These are light and still filling:", "Nothing that light in our book yet.");
    if (user.includes("planned")) return searchThenCards({ week: "next" }, (n) => `${n} recipe${n === 1 ? " is" : "s are"} planned for next week:`, "Nothing is planned for next week yet.");
    if (user.includes("rice")) {
      if (!lastTool) return scriptedStream({ ...opts, calls: [{ name: "search_recipes", arguments: { text: "rice" } }] });
      const first = rowsOf(lastTool)[0];
      if (!first) return scriptedStream({ ...opts, text: "Nothing with rice in our book yet." });
      return scriptedStream({ ...opts, text: `${first.title} is the best match.`, calls: [{ name: "offer_navigation", arguments: { slug: first.slug, label: `Open ${first.title}` } }, replies("Something quicker", "What's on this week?")] });
    }
    if (user.includes("add") && user.includes("next week")) {
      return scriptedStream({ ...opts, text: "Planning is something only a signed-in editor can do, so I can't add it from here. You can see what's planned on the Next week page.", calls: [replies("What's planned?", { label: "Open next week", action: { navigate: "next-week" } })] });
    }
    if (user.includes("this recipe") || user.includes("this one")) {
      const text = note?.includes("is viewing") || note?.includes("viewing:")
        ? `You're looking at ${note.match(/viewing: ([^(]+) \(/)?.[1].trim()}. ${note.match(/serves \d+/)?.[0] ? `It ${note.match(/serves \d+/)[0]}.` : ""} What would you like to know about it?`
        : "I'm not sure which recipe you mean. Open one and ask again, or tell me its name.";
      return scriptedStream({ ...opts, text, calls: [replies("What can I swap?", "How long does it take?", "Something similar")] });
    }
    if (user.includes("shopping") || user.includes("left to buy")) {
      if (!lastTool) return scriptedStream({ ...opts, calls: [{ name: "get_shopping_list", arguments: {} }] });
      return scriptedStream({ ...opts, text: "I've had a look at the shopping list for next week.", calls: [replies("What's left to buy?", "Which recipes?")] });
    }
    return scriptedStream({
      ...opts,
      text: "I can help you pick something from our recipe book. What are you in the mood for?",
      calls: [replies("Something quick", "Under 400 kcal", "Use up some chicken")],
    });
  }
  return { fetch, requests };
}

// --- Supabase ---------------------------------------------------------------------------------------------------------

/** users: { "<access token>": { id, email } }. rate_limit_hit counts per (key, window) in memory, like the SQL function. */
export function createFakeSupabase({ url = "http://supabase.fake", anonKey = "dev-anon", serviceKey = "dev-service", users = {} } = {}) {
  const counters = new Map();
  const calls = [];
  async function fetch(input, init = {}) {
    const u = new URL(input);
    const headers = init.headers || {};
    if (u.pathname === "/auth/v1/user") {
      if (headers.apikey !== anonKey) return Response.json({ msg: "bad apikey" }, { status: 401 });
      const user = users[String(headers.Authorization || "").replace(/^Bearer /, "")];
      return user ? Response.json(user) : Response.json({ msg: "invalid JWT" }, { status: 401 });
    }
    if (u.pathname === "/rest/v1/rpc/rate_limit_hit") {
      if (headers.apikey !== serviceKey || headers.Authorization !== `Bearer ${serviceKey}`) return Response.json({ message: "permission denied" }, { status: 401 });
      const { p_key, p_window_seconds } = JSON.parse(init.body);
      calls.push({ p_key, p_window_seconds });
      const window = Math.floor(Date.now() / 1000 / p_window_seconds);
      const k = `${p_key}|${window}`;
      counters.set(k, (counters.get(k) || 0) + 1);
      return Response.json(counters.get(k));
    }
    throw new Error(`fake Supabase: unexpected call ${init.method || "GET"} ${u.pathname}`);
  }
  return { fetch, url, counters, calls };
}
