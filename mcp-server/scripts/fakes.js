// Fakes for the outside world, shared by the local dev harness (scripts/dev.js) and the tests, so nothing here ever
// touches the real GitHub, OpenRouter or Supabase:
//   createFakeGitHub    the repo's recipes/, images/ and shopping-list.json read from disk; commits stay in memory
//   createMockOpenRouter a scripted, deterministic chat model that streams OpenAI-format SSE and exercises tool calls
//   createFakeSupabase  Auth (token check, password and email-code sign-in, refresh, logout) and PostgREST for the chat's tables
//                       (conversations, messages) and RPCs (rate_limit_hit, purge_old_chats), all in memory
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


// --- the editor's scripted flows (stage tools, ask_user, Finalise) ------------------------------------------------------------------
const titleCase = (t) => t.replace(/\b\w/g, (c) => c.toUpperCase());
const parseNoteDrafts = (note) => {
  const line = String(note || "").match(/This week's drafts on the site: (.*)\./)?.[1] || "";
  return line === "none" ? [] : [...line.matchAll(/([^,(]+?) \(([a-z0-9-]+)\)/g)].map((m) => ({ title: m[1].trim(), slug: m[2] }));
};
const callsOf = (m) => (m.tool_calls || []).map((c) => ({ name: c.function.name, args: (() => { try { return JSON.parse(c.function.arguments); } catch { return {}; } })(), id: c.id }));

/** Ingredient lines of a recipe's Markdown: [{ name, quantity }]. */
const ingredientsOf = (markdown) => {
  const section = String(markdown).split(/^## /m).find((x) => /^Ingredients/i.test(x)) || "";
  return section.split("\n").filter((l) => l.startsWith("- ")).map((l) => {
    const m = l.match(/^- (?:(.+?) )?\*\*(.+?)\*\*/);
    return m ? { name: m[2], quantity: m[1] || "" } : null;
  }).filter(Boolean);
};

/** A shopping list from get_tray's answer: one line per ingredient, tagged with its recipes (a mock: not scaled, quantities only when plain). */
function listFromTray(content) {
  const json = String(content).split(/Recipes that will be in next week after Save \(\d+\):\n/)[1];
  let recipes = [];
  try { recipes = JSON.parse(json); } catch { /* none */ }
  const byName = new Map();
  for (const r of recipes) for (const i of ingredientsOf(r.markdown)) {
    const key = i.name.toLowerCase();
    const row = byName.get(key) || { name: i.name, quantity: i.quantity, recipes: [] };
    if (row.recipes.length) row.quantity = "";
    if (!row.recipes.includes(r.slug)) row.recipes.push(r.slug);
    byName.set(key, row);
  }
  const items = [...byName.values()].map((r) => ({ name: r.name, ...(/^\d+(g|ml)?$/.test(r.quantity) ? { quantity: r.quantity } : {}), recipes: r.recipes }));
  return { sections: [{ name: "Everything", items }] };
}

/** The editor's flows. Returns a scripted response, or null when the message is not one of them. */
function editorFlow({ msgs, lastUserIdx, user, note, opts }) {
  const after = msgs.slice(lastUserIdx + 1);
  const turnCalls = after.filter((m) => m.role === "assistant").flatMap(callsOf);
  const lastCall = turnCalls[turnCalls.length - 1];
  const lastResult = after.filter((m) => m.role === "tool").at(-1);
  const pageSlug = String(note || "").match(/viewing: .+? \(([a-z0-9-]+)\)/)?.[1];
  const tray = (name, args, text) => scriptedStream({ ...opts, text, calls: [{ name, arguments: args }] });
  const ask = (question, options, text = "") => scriptedStream({ ...opts, text, calls: [{ name: "ask_user", arguments: { question, options } }] });
  const done = (text, ...chips) => scriptedStream({ ...opts, text, calls: [replies(...(chips.length ? chips : ["Anything else?"]))] });

  // "we've got 6 eggs and plenty of rice": read the list, stage what is at home
  const haveLine = user.match(/we(?:'ve| have)(?: got)? (.+)/);
  if (haveLine) {
    if (!lastCall) return tray("get_shopping_list", {}, "Let me check the list.");
    if (lastCall.name === "get_shopping_list") {
      let stored = [];
      try { stored = JSON.parse(String(lastResult.content).match(/```json\n([\s\S]*?)\n```/)[1]).sections.flatMap((x) => x.items); } catch { /* no list */ }
      const items = [];
      for (const phrase of haveLine[1].replace(/[.!]$/, "").split(/,| and /)) {
        const m = phrase.trim().match(/^(?:(\d+(?:\.\d+)?)\s*(?:g|ml)?\s+)?(?:plenty of |loads of |lots of )?(.+)$/);
        const word = m?.[2]?.replace(/s$/, "");
        const hit = word && stored.find((i) => i.name.toLowerCase().includes(word));
        if (hit) items.push({ name: hit.name, have: m[1] && /\d/.test(hit.quantity || "") ? Number(m[1]) : true });
      }
      if (!items.length) return done("None of that is on the shopping list, so there's nothing to record.", "What's left to buy?");
      return tray("stage_stocktake", { items }, "I'll note that in the tray.");
    }
    if (lastCall.name === "stage_stocktake") return done("It's in the tray as an At home card. Tap Save now on it when you're ready; it doesn't touch next week.", "What's left to buy?");
  }
  // a photo the user attached: "read" it (a mock: always the same soup) and stage the recipe; "use this as the photo" keeps their photo
  const photos = imagesIn(msgs[lastUserIdx]);
  if (photos) {
    if (!lastCall) {
      return tray("stage_create_recipe", {
        title: "Screenshot Tomato Soup", course: ["Lunch"], tags: ["Soup"], total_mins: 30, serves: 4, calories: 210,
        ingredients: [{ quantity: "800g", name: "tinned tomatoes" }, { quantity: "1", name: "onion" }, { quantity: "500ml", name: "vegetable stock" }],
        instructions: ["Soften the **onion** in a pan.", "Add the **tinned tomatoes** and **vegetable stock** and simmer for 15 minutes.", "Blend until smooth."],
        ...(/use (this|that|it|my|the)\b.*photo|as the photo/.test(user) ? { photo_from_attachment: 1 } : {}),
        reason: "read from the screenshot",
      }, "I read the recipe off your photo and will put it in the tray.");
    }
    return done("It's in the tray as a draft for next week (serves and calories are my estimate). It isn't on the site until you tap Save.", "Add another", { label: "Finalise list", action: "finalise_plan" });
  }
  // a link: read it with fetch_url, then stage the recipe from the page's own recipe data
  const link = userText(msgs[lastUserIdx]).match(/https?:\/\/[^\s)]+/)?.[0];
  if (link && !/add a new recipe:/.test(user)) {
    if (!lastCall) return tray("fetch_url", { url: link }, "Let me read that page.");
    if (lastCall.name === "fetch_url") {
      const body = String(lastResult.content);
      const json = body.match(/\(JSON-LD[^\n]*\):\n([\s\S]*?)\nPage text:/)?.[1];
      let recipe;
      try { recipe = JSON.parse(json); } catch { /* none */ }
      if (!recipe) return done("I couldn't read a recipe off that page. Could you paste it or send a screenshot?", "I'll paste it");
      const ingredients = (recipe.ingredients || []).map((line) => {
        const m = line.match(/^([\d½¼¾./]+\s*(?:g|kg|ml|l|tbsp|tsp|cups?)?)\s+(.+)$/i);
        return m ? { quantity: m[1].trim(), name: m[2].trim() } : { quantity: "1", name: line };
      });
      return tray("stage_create_recipe", {
        title: recipe.name || "Linked Recipe", course: ["Dinner"], total_mins: recipe.total_mins || 30, serves: 4, calories: 400,
        ingredients, instructions: (recipe.steps || ["Cook everything."]).map((x) => x), image_url: link, reason: "from a link",
      }, `I read ${recipe.name || "the page"} and will put it in the tray.`);
    }
    if (lastCall.name === "stage_create_recipe") return done("It's in the tray as a draft for next week, with the page's own photo. It isn't on the site until you tap Save.", "Add another", { label: "Finalise list", action: "finalise_plan" });
  }
  // a new recipe
  const created = user.match(/add a new recipe:\s*(.+)$/);
  if (created) {
    if (!lastResult) {
      const title = titleCase(created[1].trim());
      return tray("stage_create_recipe", {
        title, course: ["Dinner"], tags: ["Quick"], total_mins: 20, serves: 2, calories: 450,
        ingredients: [{ quantity: "200g", name: "pasta" }, { quantity: "2", name: "garlic cloves" }, { quantity: "2 tbsp", name: "olive oil" }, { name: "parmesan", note: "to serve" }],
        instructions: ["Boil the **pasta** until al dente.", "Fry the **garlic cloves** in the **olive oil** for a minute.", "Toss the **pasta** in the pan and top with **parmesan**."],
        reason: "from this chat",
      }, `I'll put ${title} in the tray.`);
    }
    return done("It's in the tray as a draft for next week, and its photo is being made. It isn't on the site until you tap Save.", "Add another", { label: "Finalise list", action: "finalise_plan" });
  }
  // "add this to next week" on a recipe page
  if (/\badd\b/.test(user) && user.includes("next week") && pageSlug) {
    if (!lastResult) return tray("stage_set_week_recipes", { slugs: [pageSlug], add: true, reason: "from the recipe page" }, "I'll add it to next week in the tray.");
    return done("Added to next week in the tray. It's not saved to the site yet.", { label: "Finalise list", action: "finalise_plan" }, "Not yet");
  }
  // a quick fix
  const mins = user.match(/(\d+)\s*minutes?/);
  if (mins && /it's|its|actually|not/.test(user) && pageSlug) {
    if (!lastResult) return tray("stage_update_recipe", { slug: pageSlug, total_mins: Number(mins[1]), reason: "quick fix from the recipe page" }, "I'll stage that fix.");
    return done("Staged. Its card in the tray has a Save now button for a small fix like this.");
  }
  // asking to save
  if (/\bsave\b/.test(user) && !user.includes("finalise")) {
    return done("Nothing is saved until you tap Save to site, and because this changes next week, the shopping list has to be made first.", { label: "Finalise list", action: "finalise_plan" }, "Not yet");
  }
  // clashes
  const clash = String(note || "").match(/\[([a-f0-9]{8})\][^\n]*CLASH/)?.[1];
  if (clash && /clash|changed|resolve/.test(user) && !lastResult) return ask("That recipe changed on the site since you staged this. What now?", ["Keep yours", "Keep theirs", "Drop it"]);
  if (clash && /^(keep yours|keep theirs|drop it)$/.test(user)) {
    if (!lastResult) return tray("resolve_clash", { id: clash, resolution: { "keep yours": "keep_mine", "keep theirs": "keep_theirs", "drop it": "drop" }[user] }, "");
    return done("Done.", { label: "Finalise list", action: "finalise_plan" });
  }

  // Finalise list, and the answers it asks for
  const prev = msgs.slice(0, lastUserIdx).reverse().find((m) => m.role === "assistant" && m.tool_calls);
  const prevAsk = prev ? callsOf(prev).find((c) => c.name === "ask_user")?.args : null;
  const finaliseTap = user === "finalise list" || /tapped "finalise list"/i.test(String(note || ""));
  const asked = msgs.filter((m) => m.role === "assistant" && m.tool_calls).flatMap(callsOf).filter((c) => c.name === "ask_user").map((c) => c.args.question);
  const drafts = parseNoteDrafts(note);
  const nextN = Number(String(note || "").match(/Next week on the site now: (\d+) recipe/)?.[1] || 0);
  const carried = [];
  msgs.forEach((m, i) => {
    if (m.role !== "user" || String(m.content).toLowerCase().trim() !== "keep it this week") return;
    const q = msgs.slice(0, i).reverse().find((x) => x.role === "assistant" && x.tool_calls && callsOf(x).some((c) => c.name === "ask_user" && /Keep .* this week/.test(c.args.question)));
    const title = q && callsOf(q).find((c) => c.name === "ask_user").args.question.match(/Keep (.+?) this week/)?.[1];
    const d = drafts.find((x) => x.title === title);
    if (d) carried.push(d.slug);
  });
  const nextStep = () => {
    // what the tray note says is already answered (history may have scrolled out), plus what this conversation asked
    const noted = String(note || "").match(/Drafts with an answer already in the tray \(don't ask again\): (.*?)\. Drafts not yet answered/)?.[1] || "";
    const left = drafts.find((d) => !asked.some((q) => q.includes(`Did you like ${d.title}?`)) && !noted.includes(`(${d.slug},`));
    if (left) return ask(`Did you like ${left.title}?`, ["Liked", "Not for us", "Not tried yet"]);
    if (!lastCall || lastCall.name !== "get_tray") return tray("get_tray", {}, "Now I'll read next week's recipes and build the list.");
    return null;
  };
  const buildStep = () => {
    if (lastCall?.name === "get_tray") return tray("stage_update_shopping_list", listFromTray(lastResult.content), "");
    if (lastCall?.name === "stage_update_shopping_list") return done("The shopping list is in the tray. Check it, then tap Save to site.", "Open the shopping page");
    return null;
  };
  if (lastCall && ["get_tray", "stage_update_shopping_list"].includes(lastCall.name)) return buildStep();
  const answer = user;
  if (finaliseTap && !lastCall) {
    if (nextN > 0) {
      const nextSlugs = [...String(note || "").match(/Next week on the site now: ([^\n]*)/)?.[1].matchAll(/\(([a-z0-9-]+)\)/g) || []].map((m) => m[1]);
      // the recipes' cards first, then the question (both in one reply: the question ends the turn)
      return scriptedStream({ ...opts, text: "Next week already has recipes, so first: is it ready to become this week?", calls: [showRecipes(nextSlugs.slice(0, 6)), { name: "ask_user", arguments: { question: `Next week has ${nextN} recipe${nextN === 1 ? "" : "s"}. Is it ready to become this week?`, options: ["Promote it", "Not yet"] } }] });
    }
    // next week is empty: no promote question and no draft questions, straight to building the list
    return tray("get_tray", {}, "Next week is empty, so there's nothing to switch. I'll read the tray and build the list.");
  }
  if (prevAsk && /ready to become this week/.test(prevAsk.question)) {
    if (answer === "not yet") return done("Okay: nothing changes, and next week and its list stay as they are. Say the word when you want to finalise.", { label: "Finalise list", action: "finalise_plan" });
    if (answer === "promote it") {
      if (!lastCall) return tray("stage_start_next_week", {}, "I'll stage the switch first.");
      return nextStep();
    }
  }
  if (prevAsk && /^Did you like /.test(prevAsk.question)) {
    const d = drafts.find((x) => prevAsk.question.includes(`Did you like ${x.title}?`));
    if (d && answer === "liked") return !lastCall ? tray("stage_promote_recipe", { slug: d.slug }, "") : nextStep();
    if (d && answer === "not for us") return !lastCall ? tray("stage_remove_draft", { slug: d.slug }, "") : nextStep();
    if (d && answer === "not tried yet") return ask(`Keep ${d.title} this week or put it back in the book?`.replace("Keep ", "Keep "), ["Keep it this week", "Back to the book"]);
  }
  if (prevAsk && /Keep .* this week/.test(prevAsk.question)) {
    if (answer === "keep it this week") return !lastCall ? tray("stage_start_next_week", { carry_over: carried }, "") : nextStep();
    if (answer === "back to the book") return nextStep();
  }
  return null;
}

/** A message's text, whether its content is a string or text + image parts. */
const contentText = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : String(m.content ?? ""));
const imagesIn = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0);
const userText = (m) => contentText(m).replace(/\n\n\[Note from the site[\s\S]*$/, "");

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
 *   "mock-call:x"  -> asks for the tool x with no arguments (the auth tests walk the whole registry with it)
 *   anything else  -> a plain reply + suggest_replies
 * An editor's turn (the stage tools are offered) also knows:
 *   "add a new recipe: test pasta"     -> stage_create_recipe (a draft for next week, photo generated), then a short answer
 *   "add this to next week" on a recipe page -> stage_set_week_recipes for that page's recipe
 *   "it's 35 minutes" on a recipe page -> stage_update_recipe (a quick fix, eligible for Save now)
 *   "save it"                          -> explains and offers the chips Finalise list / Not yet
 *   "Finalise list" (the button)       -> asks "Next week has N recipes. Is it ready to become this week?" when it has, then the
 *                                         switch and one question per draft of this week (Liked / Not for us / Not tried yet), then
 *                                         get_tray and stage_update_shopping_list; answers: "Promote it", "Not yet", "Liked", ...
 * `requests` records every request body, so tests can assert on what the server sent.
 */
export function createMockOpenRouter({ delayMs = 12 } = {}) {
  const requests = [];
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ ...body, auth: init.headers.Authorization, url: String(url) });
    // the loop may add a "you already told the user" note to the last tool result; the mock reads results without it
    const msgs = body.messages.map((m) => (m.role === "tool" && typeof m.content === "string" ? { ...m, content: m.content.replace(/\n\n\[Note from the site, not a tool result[\s\S]*$/, "") } : m));
    const lastUserIdx = msgs.findLastIndex((m) => m.role === "user");
    const user = userText(msgs[lastUserIdx]).toLowerCase();
    const note = contentText(msgs[lastUserIdx]).match(/\[Note from the site, not from the user: ([\s\S]*)\]$/)?.[1];
    const after = msgs.slice(lastUserIdx + 1);
    const toolResults = after.filter((m) => m.role === "tool");
    const lastTool = toolResults[toolResults.length - 1];
    const calledShown = after.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "suggest_replies"));
    const opts = { delayMs };

    if (user.includes("mock-402")) return new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402 });
    if (user.includes("mock-500")) return new Response("boom", { status: 500 });
    if (user.includes("mock-stream-error")) return sse([chunk({ role: "assistant", content: "Let me" }), { error: { code: 500, message: "upstream died" } }], delayMs);
    if (calledShown) return scriptedStream({ ...opts }); // nothing more to say after the replies were shown
    if (after.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "ask_user"))) return scriptedStream({ ...opts }); // the question is on screen: the answer comes next
    if (body.tools?.some((t) => t.function.name === "stage_create_recipe")) {
      const flow = editorFlow({ msgs, lastUserIdx, user, note, opts });
      if (flow) return flow;
    }

    // "mock-call:<tool>" asks for that tool with no arguments (the registry-wide auth test uses it), then closes with a line of text.
    const forced = user.match(/mock-call:([a-z_]+)/)?.[1];
    if (forced) {
      if (!lastTool) return scriptedStream({ ...opts, text: "Doing that.", calls: [{ name: forced, arguments: {} }] });
      return scriptedStream({ ...opts, text: "That didn't go through." });
    }
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
    // cooking help on a recipe page: read the recipe, then answer from it
    const pageSlug = String(note || "").match(/viewing: .+? \(([a-z0-9-]+)\)/)?.[1];
    const scaleTo = user.match(/scale (?:it |this )?(?:for|to) (\d+)/)?.[1];
    const stepNo = user.match(/(?:what'?s|what is|tell me) step (\d+)/)?.[1];
    if (pageSlug && (scaleTo || stepNo || /swap the |substitut|replace the /.test(user))) {
      if (!lastTool) return scriptedStream({ ...opts, text: "Let me check the recipe.", calls: [scaleTo ? { name: "scale_recipe", arguments: { slug: pageSlug, servings: Number(scaleTo) } } : { name: "get_recipe", arguments: { slug: pageSlug } }] });
      const body = String(lastTool.content);
      if (scaleTo) return scriptedStream({ ...opts, text: `For ${scaleTo} people:\n\n${body.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/\*\*/g, "")).join("\n")}\n\nTimes and pan sizes may need a tweak.`, calls: [replies("Scale it for 2", "Swap an ingredient")] });
      if (stepNo) {
        const steps = (body.split(/^## Instructions/m)[1] || "").split("\n").filter((l) => /^\d+\./.test(l));
        return scriptedStream({ ...opts, text: steps[stepNo - 1] ? `Step ${stepNo}: ${steps[stepNo - 1].replace(/^\d+\.\s*/, "").replace(/\*\*/g, "")}` : `There's no step ${stepNo} in this recipe.`, calls: [replies("What's step 3?", "Scale it for 6")] });
      }
      return scriptedStream({ ...opts, text: "A plain swap: use Greek yogurt with a squeeze of lemon, same amount. It will be a little tangier and less rich.", calls: [replies("Scale it for 6", "What's step 2?")] });
    }
    if (user.includes("this recipe") || user.includes("this one")) {
      const text = note?.includes("is viewing") || note?.includes("viewing:")
        ? `You're looking at ${note.match(/viewing: ([^(]+) \(/)?.[1].trim()}. ${note.match(/serves \d+/)?.[0] ? `It ${note.match(/serves \d+/)[0]}.` : ""} What would you like to know about it?`
        : "I'm not sure which recipe you mean. Open one and ask again, or tell me its name.";
      return scriptedStream({ ...opts, text, calls: [replies("What can I swap?", "How long does it take?", "Something similar")] });
    }
    if (/what can i make|at home\?|what.s in the (cupboard|fridge)/.test(user)) {
      if (!lastTool) return scriptedStream({ ...opts, text: "Let me see what's at home.", calls: [{ name: "recipes_from_home", arguments: {} }] });
      const rows = String(lastTool.content).split("\n").filter((l) => /^[a-z0-9-]+ \| /.test(l)).map((l) => l.split(" | ")[0]);
      if (!rows.length) return scriptedStream({ ...opts, text: String(lastTool.content).slice(0, 200), calls: [replies("What's left to buy?")] });
      return scriptedStream({ ...opts, text: "These use the most of what you have at home:", calls: [showRecipes(rows.slice(0, 3)), replies("Which is quickest?", "What's missing?")] });
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

const UUID_V4 = () => crypto.randomUUID();
const HOUR = 3600;

/**
 * An in-memory Supabase.
 *   Auth      users: { "<access token>": { id, email } } are tokens that are valid from the start (tests); accounts:
 *             [{ id, email, password }] can sign in with a password (POST /auth/v1/token?grant_type=password), with the email code
 *             (/otp then /verify with the code "123456") or refresh (grant_type=refresh_token). Tokens it issues expire after
 *             `tokenTtlSeconds` (default an hour), after which /auth/v1/user answers 401 like the real thing; `expire(token)` ages one now.
 *   PostgREST the chat's tables (conversations, messages) with the filters, ordering and limits lib/chat-store.js uses, only
 *             for the service-role key (the anon key gets 401, like RLS with no policies), and the RPCs rate_limit_hit and
 *             purge_old_chats (rows older than 14 days go, messages with them).
 * Inspect: `tables.conversations` / `tables.messages` (arrays), `counters`, `calls`.
 */
export function createFakeSupabase({ url = "http://supabase.fake", anonKey = "dev-anon", serviceKey = "dev-service", users = {}, accounts = [], tokenTtlSeconds = HOUR, now = () => Date.now() } = {}) {
  const counters = new Map();
  const calls = [];
  const tables = { conversations: [], messages: [], trays: [] };
  const objects = new Map(); // storage: "<bucket>/<path>" -> { bytes, type }
  const signed = new Map(); // token -> { key, exp }
  let seq = 0;
  let issued = 0;
  const tokens = new Map(); // access token -> { id, email, exp (ms, or Infinity) }
  for (const [token, u] of Object.entries(users)) tokens.set(token, { ...u, exp: Infinity });
  const refreshTokens = new Map(); // refresh token -> account
  const byEmail = (email) => accounts.find((a) => a.email.toLowerCase() === String(email || "").toLowerCase());

  function issue(account) {
    const n = ++issued;
    const access = `fake-access-${n}`;
    const refresh = `fake-refresh-${n}`;
    tokens.set(access, { id: account.id, email: account.email, exp: now() + tokenTtlSeconds * 1000 });
    refreshTokens.set(refresh, account);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: tokenTtlSeconds,
      expires_at: Math.floor(now() / 1000) + tokenTtlSeconds,
      user: { id: account.id, email: account.email },
    };
  }
  const expire = (token) => {
    const t = tokens.get(token);
    if (t) t.exp = 0;
  };

  const json = (body, status = 200) => Response.json(body, { status });
  const bearer = (headers) => String(headers.Authorization || headers.authorization || "").replace(/^Bearer /, "");

  // ----- Auth
  async function auth(u, init, headers) {
    const method = init.method || "GET";
    if (headers.apikey !== anonKey) return json({ msg: "bad apikey" }, 401);
    const body = init.body ? JSON.parse(init.body) : {};
    const route = u.pathname.replace("/auth/v1/", "");
    if (route === "user" && method === "GET") {
      const t = tokens.get(bearer(headers));
      return t && t.exp > now() ? json({ id: t.id, email: t.email }) : json({ msg: "invalid JWT" }, 401);
    }
    if (route === "token") {
      const grant = u.searchParams.get("grant_type");
      if (grant === "password") {
        const a = byEmail(body.email);
        return a && a.password === body.password ? json(issue(a)) : json({ error_description: "Invalid login credentials", msg: "Invalid login credentials" }, 400);
      }
      if (grant === "refresh_token") {
        const a = refreshTokens.get(body.refresh_token);
        return a ? json(issue(a)) : json({ msg: "Invalid Refresh Token" }, 400);
      }
    }
    if (route === "otp") {
      const a = byEmail(body.email);
      if (!a) return json({ msg: "Signups not allowed for otp" }, 422);
      calls.push({ otp: a.email, redirect: u.searchParams.get("redirect_to") });
      return json({});
    }
    if (route === "verify") {
      const a = byEmail(body.email);
      return a && body.token === "123456" ? json(issue(a)) : json({ msg: "Token has expired or is invalid" }, 403);
    }
    if (route === "user" && method === "PUT") {
      const t = tokens.get(bearer(headers));
      const a = t && t.exp > now() && accounts.find((x) => x.id === t.id);
      if (!a) return json({ msg: "invalid JWT" }, 401);
      a.password = body.password;
      return json({ id: a.id, email: a.email });
    }
    if (route === "logout") {
      tokens.delete(bearer(headers));
      return new Response(null, { status: 204 });
    }
    return json({ msg: `fake Supabase: unexpected auth call ${method} ${route}` }, 404);
  }

  // ----- PostgREST
  const COLUMNS = {
    conversations: () => ({ id: UUID_V4(), title: null, created_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(), archived: false }),
    messages: () => ({ id: UUID_V4(), seq: ++seq, turn_id: null, trace_id: null, feedback: null, created_at: new Date(now()).toISOString() }),
    trays: () => ({ id: UUID_V4(), status: "collecting", items: [], list_hash: null, version: 0, created_at: new Date(now()).toISOString(), expires_at: new Date(now() + 7 * 24 * HOUR * 1000).toISOString(), updated_at: new Date(now()).toISOString(), updated_by: null }),
  };
  function matches(row, params) {
    for (const [k, v] of params) {
      if (["select", "order", "limit"].includes(k)) continue;
      const [op, ...rest] = v.split(".");
      const want = rest.join(".");
      const have = row[k];
      if (op === "eq" && String(have) !== want) return false;
      if (op === "gt" && !(String(have) > want)) return false; // ISO timestamps compare as strings
      if (op === "in" && !want.replace(/^\(|\)$/g, "").split(",").includes(String(have))) return false;
    }
    return true;
  }
  const order = (rows, spec) => {
    if (!spec) return rows;
    const [col, dir] = spec.split(".");
    return [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === "desc" ? -1 : 1));
  };
  function dropConversation(id) {
    tables.conversations = tables.conversations.filter((c) => c.id !== id);
    tables.messages = tables.messages.filter((m) => m.conversation_id !== id); // on delete cascade
  }

  async function rest(u, init, headers) {
    if (headers.apikey !== serviceKey || bearer(headers) !== serviceKey) return json({ message: "permission denied", code: "42501" }, 401);
    const method = init.method || "GET";
    const name = u.pathname.replace("/rest/v1/", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (name === "rpc/rate_limit_hit") {
      const { p_key, p_window_seconds } = body;
      calls.push({ p_key, p_window_seconds });
      const window = Math.floor(Date.now() / 1000 / p_window_seconds);
      const k = `${p_key}|${window}`;
      counters.set(k, (counters.get(k) || 0) + 1);
      return json(counters.get(k));
    }
    if (name === "rpc/purge_old_chats") {
      const cutoff = new Date(now() - 14 * 24 * HOUR * 1000).toISOString();
      const old = tables.conversations.filter((c) => c.updated_at < cutoff);
      old.forEach((c) => dropConversation(c.id));
      calls.push({ purged: old.length });
      return json(old.length);
    }
    if (!tables[name]) return json({ message: `unknown table ${name}` }, 404);
    const wantRows = /return=representation/.test(headers.Prefer || "");
    if (method === "GET") {
      const rows = order(tables[name].filter((r) => matches(r, u.searchParams)), u.searchParams.get("order"));
      const limit = Number(u.searchParams.get("limit")) || rows.length;
      return json(rows.slice(0, limit));
    }
    if (method === "POST") {
      const inserted = (Array.isArray(body) ? body : [body]).map((r) => ({ ...COLUMNS[name](), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) }));
      if (name === "messages" && inserted.some((m) => !tables.conversations.some((c) => c.id === m.conversation_id))) return json({ message: "foreign key violation", code: "23503" }, 409);
      if (name === "trays" && tables.trays.length) return json({ message: "duplicate key value violates unique constraint trays_one_per_household", code: "23505" }, 409);
      tables[name].push(...inserted);
      return wantRows ? json(inserted, 201) : new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      const rows = tables[name].filter((r) => matches(r, u.searchParams));
      rows.forEach((r) => Object.assign(r, body));
      return wantRows ? json(rows) : new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const rows = tables[name].filter((r) => matches(r, u.searchParams));
      if (name === "conversations") rows.forEach((r) => dropConversation(r.id));
      else tables[name] = tables[name].filter((r) => !rows.includes(r));
      return wantRows ? json(rows) : new Response(null, { status: 204 });
    }
    return json({ message: "unsupported" }, 405);
  }

  // ----- Storage (the private bucket tray-photos): upload, download, delete (one or many), list, signed URLs
  async function storage(u, init, headers) {
    const method = init.method || "GET";
    const route = u.pathname.replace("/storage/v1/", "");
    const isService = headers.apikey === serviceKey && bearer(headers) === serviceKey;
    const bytes = (body) => (typeof body === "string" ? Buffer.from(body) : Buffer.from(body || []));
    let m;
    if ((m = route.match(/^object\/sign\/([^/]+)\/(.+)$/)) && method === "GET") {
      const t = signed.get(u.searchParams.get("token"));
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (!t || t.key !== key || t.exp < now()) return json({ message: "Invalid token" }, 400);
      const o = objects.get(key);
      return o ? new Response(o.bytes, { headers: { "content-type": o.type } }) : json({ message: "Object not found" }, 404);
    }
    if (!isService) return json({ message: "permission denied" }, 401);
    if ((m = route.match(/^object\/sign\/([^/]+)\/(.+)$/)) && method === "POST") {
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (!objects.has(key)) return json({ message: "Object not found" }, 400);
      const token = `tok-${UUID_V4()}`;
      signed.set(token, { key, exp: now() + (JSON.parse(init.body).expiresIn || 60) * 1000 });
      return json({ signedURL: `/object/sign/${m[1]}/${m[2]}?token=${token}` });
    }
    if ((m = route.match(/^object\/list\/([^/]+)$/)) && method === "POST") {
      const { prefix = "" } = JSON.parse(init.body);
      if (!prefix) return json([...new Set([...objects.keys()].filter((k) => k.startsWith(`${m[1]}/`)).map((k) => k.slice(m[1].length + 1).split("/")[0]))].map((name) => ({ name, id: null })));
      return json([...objects.keys()].filter((k) => k.startsWith(`${m[1]}/${prefix}/`)).map((k) => ({ name: k.slice(`${m[1]}/${prefix}/`.length) })));
    }
    if ((m = route.match(/^object\/([^/]+)$/)) && method === "DELETE") {
      for (const p of JSON.parse(init.body).prefixes || []) objects.delete(`${m[1]}/${p}`);
      return json([]);
    }
    if ((m = route.match(/^object\/([^/]+)\/(.+)$/))) {
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (method === "POST") {
        if (objects.has(key) && headers["x-upsert"] !== "true") return json({ message: "The resource already exists" }, 409);
        objects.set(key, { bytes: bytes(init.body), type: headers["Content-Type"] || "application/octet-stream" });
        return json({ Key: key });
      }
      if (method === "GET") {
        const o = objects.get(key);
        return o ? new Response(o.bytes, { headers: { "content-type": o.type } }) : json({ message: "Object not found" }, 404);
      }
      if (method === "DELETE") return objects.delete(key) ? json({}) : json({ message: "Object not found" }, 404);
    }
    return json({ message: `fake Supabase: unexpected storage call ${method} ${route}` }, 404);
  }

  async function fetch(input, init = {}) {
    const u = new URL(input);
    const headers = init.headers || {};
    if (u.pathname.startsWith("/storage/v1/")) return storage(u, init, headers);
    if (u.pathname.startsWith("/auth/v1/")) return auth(u, init, headers);
    if (u.pathname.startsWith("/rest/v1/")) return rest(u, init, headers);
    throw new Error(`fake Supabase: unexpected call ${init.method || "GET"} ${u.pathname}`);
  }
  return { fetch, url, counters, calls, tables, expire, tokens, objects };
}

// --- the image API (photo generation) -------------------------------------------------------------------------------------------

/** A fake of OpenRouter's image endpoint: a plain coloured "plate" JPEG per prompt, so staged photos have something to show. */
export function createFakeImageApi() {
  const requests = [];
  async function fetch(url, init) {
    const { default: sharp } = await import("sharp");
    const prompt = JSON.parse(init.body).prompt || "";
    requests.push({ prompt, auth: init.headers?.Authorization });
    let h = 0;
    for (const c of prompt) h = (h * 31 + c.charCodeAt(0)) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="hsl(${h},30%,85%)"/><circle cx="600" cy="450" r="300" fill="hsl(${h},45%,95%)"/><circle cx="600" cy="450" r="200" fill="hsl(${(h + 30) % 360},55%,60%)"/></svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
    return Response.json({ data: [{ b64_json: jpeg.toString("base64") }] });
  }
  return { fetch, requests };
}
