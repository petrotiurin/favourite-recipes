// The chat agent (docs/chatbot-design.md D1, D3, 6.1, 7.2): one user turn = a loop of OpenRouter chat-completion calls
// (streamed) with tool calling. Every tool call the model makes goes through dispatch() with the caller, which is what
// enforces access; the model is only OFFERED what the role may call. The client's history is untrusted and is reduced
// to plain user/assistant text before it gets here.
import { z } from "zod";
import { config, COURSES } from "./config.js";
import { TOOLS, accessOf, toolDefinitions, dispatch } from "./tools.js";
import { catalogue, catalogueText, getRecipe, isDraft, isThisWeek, isNextWeek } from "./recipes.js";
import { systemPrompt, SUGGEST_REPLIES_TOOL, SHOW_RECIPES_TOOL, OFFER_NAVIGATION_TOOL, ASK_USER_TOOL, PROMPT_VERSION } from "./chat-prompt.js";
import { trayAction, trayView, loadTray } from "./tray.js";
import { loadBook, buildCards, buildNavigation, cleanReplyList, cleanQuestion } from "./chat-ui.js";

export const MAX_TURNS = 20; // messages kept from the client's history
export const MAX_USER_CHARS = 2000;
export const MAX_ASSISTANT_CHARS = 4000;
export const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 12000;
// tools whose answers are legitimately long (the tray with its recipes, the whole shopping list, a fetched page)
const RESULT_CAPS = { get_tray: 40000, get_shopping_list: 24000, fetch_url: 24000 };
// Limits on what ONE model reply may ask for, so a single request can't fan out into thousands of GitHub calls or a huge prompt.
export const MAX_CALLS_PER_ROUND = 4; // tool calls honoured per model reply (the rest get an error result)
export const MAX_TOOL_CALLS_PER_TURN = 10; // data and write tool calls per user turn (UI tools like suggest_replies don't count)
export const MAX_RESULT_CHARS_PER_TURN = 80_000; // total tool-result text added to the thread in one turn
const TEMPERATURE = 0.4;

// --- Langfuse (design 8.1): how a turn's steps show up in a trace ---------------------------------------------------------------
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
// Read tools that only look something up are retrievers; everything else (stage tools, the tray, the UI tools, scaling) is a tool.
const COMPUTED_READS = new Set(["scale_recipe"]);
export function observationType(name) {
  const tool = TOOL_BY_NAME.get(name);
  return tool && accessOf(tool) === "read" && !COMPUTED_READS.has(name) ? "retriever" : "tool";
}

/** A model call's answer as an OpenAI-style assistant message, so Langfuse renders the text, the tool calls (as cards) and the thinking. */
export function assistantOutput(result) {
  return {
    role: "assistant",
    content: result.text || null,
    ...(result.toolCalls?.length ? { tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })) } : {}),
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
  };
}

/** An error with a message that is safe to show the visitor. */
export class ChatError extends Error {
  constructor(message, { status = 500, kind = "error" } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

const RESTING = "The chat is resting, try again later.";
const GENERIC = "Something went wrong with the chat. Try again in a moment.";

/** Maps an OpenRouter failure to something friendly. 402 (out of credit) and a dead key both mean "resting". */
export function friendlyOpenRouterError(status, bodyText = "") {
  if (status === 402 || status === 401 || status === 403 || /insufficient|credit/i.test(bodyText)) return new ChatError(RESTING, { status: 503, kind: "out-of-credit" });
  // a text-only model sent a photo
  if (/image|modalit|vision|multimodal|multi-modal|image_url/i.test(bodyText) && /support|accept|not (?:allowed|available|valid)|invalid|cannot|can't|unsupported|no endpoints/i.test(bodyText)) {
    return new ChatError("This chat model can't read photos — paste the recipe text or a link instead.", { status: 400, kind: "no-vision" });
  }
  if (status === 429) return new ChatError("The chat is busy right now. Try again in a minute.", { status: 503, kind: "busy" });
  return new ChatError(GENERIC, { status: 502, kind: "upstream" });
}

// --- the client's messages: untrusted ----------------------------------------------------------------------------

/**
 * Reduces whatever the client sent to the last MAX_TURNS plain-text user/assistant messages. Anything else (system, tool,
 * tool_calls, unknown roles, non-string content) is dropped, so the client can't inject tool results or system messages.
 * The conversation must start with and end on a user message; returns [] if there is none.
 */
export function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = [];
  for (const m of raw) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.trim().slice(0, m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS);
    if (content) clean.push({ role: m.role, content });
  }
  const last = clean.slice(-MAX_TURNS);
  while (last.length && last[0].role !== "user") last.shift();
  return last.length && last[last.length - 1].role === "user" ? last : [];
}

// --- page context: re-resolved by the server, never trusted -------------------------------------------------------

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const oneLine = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max);
const weekWords = (d) => (isThisWeek(d) && isNextWeek(d) ? "in this week and next week" : isThisWeek(d) ? "in this week, not in next week" : isNextWeek(d) ? "in next week, not in this week" : "in neither week");

/**
 * A short note about the page the user is on, or "". For a recipe page the slug is looked up in the repo (title, servings and status
 * come from OUR data, not from the page); live UI state is reduced to validated values.
 */
export async function pageNote(page) {
  if (!page || typeof page !== "object" || page.dismissed === true) return "";
  switch (page.page) {
    case "recipe": {
      if (typeof page.slug !== "string" || !SLUG.test(page.slug)) return "";
      let data;
      try {
        ({ data } = await getRecipe(page.slug));
      } catch {
        return "";
      }
      const picked = Number.isInteger(page.servings) && page.servings >= 1 && page.servings <= 24 ? ` They have ${page.servings} servings selected on the page.` : "";
      return `The user is viewing: ${data.title} (${data.slug}), serves ${data.serves}, ${data.calories} kcal each, ${isDraft(data) ? "a draft (not tried yet)" : "a regular recipe"}, ${weekWords(data)}.${picked} "This recipe" or "this" means ${data.title}.`;
    }
    case "index": {
      const filter = COURSES.includes(page.filter) ? ` filtered to ${page.filter}` : "";
      const search = oneLine(page.search, 60);
      return `The user is on the home page (the recipe list)${filter}${search ? `; they typed ${JSON.stringify(search)} in the search box` : ""}.`;
    }
    case "next-week":
      return "The user is on the Next week page, which lists the recipes planned for next week.";
    case "shopping":
      return "The user is on the shopping list page (the list for next week's recipes).";
    default:
      return "";
  }
}

// --- OpenRouter streaming ----------------------------------------------------------------------------------------

/** Yields the parsed JSON of each `data:` event of an SSE response body. */
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // a comment or partial line we don't need
      }
    }
  }
}

/** Drops <think>…</think> (and <thinking>…</thinking>) spans from streamed text, even when a tag is split across chunks. */
export function createThinkFilter() {
  let buf = "";
  let inside = false;
  const OPEN = /<think(?:ing)?>/i;
  const CLOSE = /<\/think(?:ing)?>/i;
  const MAXTAG = 12;
  return {
    push(chunk) {
      buf += chunk;
      let out = "";
      for (;;) {
        if (inside) {
          const m = buf.match(CLOSE);
          if (!m) {
            buf = buf.slice(-MAXTAG); // keep a possible partial closing tag
            return out;
          }
          buf = buf.slice(m.index + m[0].length);
          inside = false;
        } else {
          const m = buf.match(OPEN);
          if (m) {
            out += buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            inside = true;
            continue;
          }
          const lt = buf.lastIndexOf("<");
          if (lt !== -1 && buf.length - lt < MAXTAG && /^<\/?t?h?i?n?k?i?n?g?>?$/i.test(buf.slice(lt))) {
            out += buf.slice(0, lt);
            buf = buf.slice(lt); // maybe the start of a tag: wait for more
          } else {
            out += buf;
            buf = "";
          }
          return out;
        }
      }
    },
    flush() {
      const rest = inside ? "" : buf;
      buf = "";
      return rest;
    },
  };
}

/**
 * One streamed model call. Calls onText(delta) as text arrives; resolves to { text, toolCalls, usage, finishReason, cut, ms, reasoning,
 * firstTokenAt }.
 * toolCalls: [{ id, name, arguments (string) }]. cut: "length" (stopped at max_tokens), "dropped" (the stream ended with no finish
 * reason: the provider gave up or timed out mid-answer) or null (a normal end). A tool call the provider hadn't finished is often not
 * passed on at all, so a cut answer can look like an empty one: `cut` is what tells them apart.
 */
async function streamCompletion({ messages, tools, model, apiKey, signal, onText, onToolProgress, maxTokens, toolChoice = "auto" }) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl,
        "X-Title": "Our Favourite Recipes",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
        temperature: TEMPERATURE,
        max_tokens: maxTokens,
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    console.error("OpenRouter request failed:", err.message);
    throw new ChatError(GENERIC, { status: 502, kind: "upstream" });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`OpenRouter answered ${res.status} (model ${model}): ${text.slice(0, 600)}`);
    throw friendlyOpenRouterError(res.status, text);
  }

  let text = "";
  let reasoning = ""; // the model's thinking: never shown to the user, kept for the trace
  let firstTokenAt; // time to first token, for the trace
  let usage;
  let finishReason;
  const thinking = createThinkFilter();
  const calls = []; // by index
  for await (const event of sseEvents(res.body)) {
    if (event.error) {
      console.error("OpenRouter stream error:", JSON.stringify(event.error).slice(0, 300));
      throw friendlyOpenRouterError(Number(event.error.code) || 500, JSON.stringify(event.error));
    }
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    // delta.reasoning / reasoning_content / reasoning_details are the model's thinking: never shown. Some models inline it as <think>…</think>.
    const thought = typeof delta.reasoning === "string" ? delta.reasoning : typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (!firstTokenAt && (thought || delta.content || delta.tool_calls?.length)) firstTokenAt = new Date();
    if (thought) reasoning += thought;
    if (typeof delta.content === "string" && delta.content) {
      const visible = thinking.push(delta.content);
      if (visible) {
        text += visible;
        onText(visible);
      }
    }
    for (const tc of delta.tool_calls || []) {
      const call = (calls[tc.index ?? 0] ||= { id: "", name: "", arguments: "" });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
      if (onToolProgress && call.name) onToolProgress(call);
    }
  }
  const tail = thinking.flush();
  if (tail) {
    text += tail;
    onText(tail);
  }
  const toolCalls = calls.filter((c) => c?.name).map((c, i) => ({ ...c, id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}` }));
  const cut = finishReason === "length" ? "length" : finishReason ? null : "dropped";
  return { text, toolCalls, usage, finishReason, cut, ms: Date.now() - started, reasoning, firstTokenAt };
}

/** One log line about a model call that was cut off or came back empty: enough to tell a timeout from the token cap. */
function logRound(label, model, maxTokens, result) {
  const u = result.usage;
  console.warn(
    `${label} (model ${model}): finish ${result.finishReason || "none"}${result.cut ? `, cut off (${result.cut})` : ""}, ${Math.round(result.ms / 1000)}s, ` +
      `tokens ${u ? `${u.prompt_tokens ?? "?"} in / ${u.completion_tokens ?? "?"} out${u.completion_tokens_details?.reasoning_tokens ? ` (${u.completion_tokens_details.reasoning_tokens} reasoning)` : ""}` : "unknown"} of max ${maxTokens}, ` +
      `text ${result.text.length} chars, calls ${result.toolCalls.map((c) => c.name).join(",") || "none"}`
  );
}

/** What the user is told when the model was cut off before it could answer. */
export function cutOffLine(cut, { photo } = {}) {
  const why = cut === "length" ? "it ran out of room for its answer" : "the connection to it ended early (most likely it took too long)";
  return `Sorry, the model stopped before it finished: ${why}. Nothing was added. ${photo ? "Try again, or send a tighter crop of just the recipe, or paste the link if it's from a website." : "Try again in a moment, or ask for a bit less at once."}`;
}

// --- tools ----------------------------------------------------------------------------------------------------

const STATUS = {
  stage_update_recipe: "Adding the edit to the tray…",
  stage_promote_recipe: "Adding that to the tray…",
  stage_remove_draft: "Adding that to the tray…",
  stage_set_week_recipes: "Adding that to next week in the tray…",
  stage_start_next_week: "Adding the switch to the tray…",
  stage_update_shopping_list: "Building the shopping list…",
  stage_set_shopping_servings: "Adding that to the tray…",
  stage_stocktake: "Adding what's at home to the tray…",
  get_tray: "Reading next week's recipes…",
  resolve_clash: "Sorting that out…",
  drop_tray_item: "Taking that out of the tray…",
  search_recipes: "Looking through the recipes…",
  list_recipes: "Looking through the recipes…",
  get_recipe: "Reading the recipe…",
  fetch_url: "Reading the link…",
  scale_recipe: "Scaling the recipe…",
  recipes_from_home: "Checking what's at home…",
  get_shopping_list: "Checking the shopping list…",
};

/**
 * What to tell the user while a tool runs (or while the model is still writing its arguments): specific where the arguments say what it is
 * ("Adding Lemon Garlic Pasta to the tray…", "Reading Pancakes…", "Building the shopping list: 9 items so far…"). `args` is the parsed
 * arguments, `raw` the argument text streamed so far (it may be incomplete JSON); `titles` maps slug -> recipe title.
 */
export function statusFor(name, { args, raw = "", titles } = {}) {
  const title = args?.title || raw.match(/"title"\s*:\s*"((?:[^"\\]|\\.)+)"/)?.[1];
  const slug = args?.slug || raw.match(/"slug"\s*:\s*"([a-z0-9-]+)"/)?.[1];
  const named = slug && titles?.get(slug);
  switch (name) {
    case "stage_create_recipe":
      return title ? `Adding ${title} to the tray…` : "Adding the recipe to the tray…";
    case "get_recipe":
      return named ? `Reading ${named}…` : STATUS.get_recipe;
    case "stage_update_recipe":
      return named ? `Adding the edit to ${named} to the tray…` : STATUS.stage_update_recipe;
    case "stage_promote_recipe":
      return named ? `Promoting ${named} in the tray…` : STATUS.stage_promote_recipe;
    case "stage_remove_draft":
      return named ? `Adding the removal of ${named} to the tray…` : STATUS.stage_remove_draft;
    case "stage_update_shopping_list": {
      const items = (raw.match(/"recipes"\s*:/g) || []).length;
      return items ? `Building the shopping list: ${items} item${items === 1 ? "" : "s"} so far…` : STATUS.stage_update_shopping_list;
    }
    default:
      return STATUS[name] || "Working on it…";
  }
}

const repliesSchema = z.object({ replies: z.array(z.unknown()).min(1) });

/**
 * Cleans what the model passed to suggest_replies (see chat-ui.js cleanReplyList). `book` (slug -> recipe) is what an action
 * reply's slug is checked against; without it only plain-string replies survive.
 */
export function cleanReplies(args, book, opts) {
  const parsed = repliesSchema.safeParse(args);
  return parsed.success ? cleanReplyList(parsed.data.replies, book, opts) : [];
}

/** Appends the site note to a user message whose content is text or text + image parts. */
function withNote(content, note) {
  const add = `\n\n[Note from the site, not from the user: ${note}]`;
  if (!Array.isArray(content)) return `${content}${add}`;
  const parts = content.map((p) => ({ ...p }));
  const first = parts.find((p) => p.type === "text");
  if (first) first.text += add;
  else parts.unshift({ type: "text", text: add.trim() });
  return parts;
}

/** Safe chips from the page, for when a model gave none (the same ideas as the panel's starters; never anything that changes the site). */
export function defaultChips(page, editor) {
  const by = {
    recipe: editor ? ["Swap an ingredient", "What goes with it?"] : ["Swap an ingredient", "What goes with it?", "Something similar"],
    index: ["Something quick tonight", "Light and healthy"],
    "next-week": ["What's planned?", "What's on this week?"],
    shopping: ["What's left to buy?", "What can I make from what's at home?"],
  };
  return by[page?.page] || ["Something quick tonight", "What's on this week?"];
}

/**
 * Chips for a turn whose model gave none and whose nudge gave none: tied to what the turn did where possible (cards were shown, something was staged),
 * else the page's safe starters.
 */
export async function turnChips({ page, editor, ui, fixReplies, staged }) {
  if (ui.cards?.length) return [{ label: "Open the first one", url: ui.cards[0].url }, "Under 20 minutes", "Something lighter"];
  if (editor && staged) {
    const chips = await fixReplies(["Finalise list", "Save to site"]); // become real buttons only when the tray allows them
    return [...chips, "Add another"].slice(0, 3);
  }
  return defaultChips(page, editor);
}

const normText = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const UI_TOOLS = new Set(["suggest_replies", "show_recipes", "offer_navigation", "ask_user"]);

const resultText = (result, max = MAX_TOOL_RESULT_CHARS) => {
  const text = (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return text.length > max ? `${text.slice(0, max)}\n… (cut: ${text.length - max} more characters)` : text;
};

const READ_TOOLS = new Set(TOOLS.filter((t) => accessOf(t) === "read").map((t) => t.name));

const STAGE_TOOLS = new Set(TOOLS.filter((t) => accessOf(t) === "stage").map((t) => t.name));

/**
 * The tool definitions offered to a role: the registry's read tools (minus the workflow guides) plus the UI tools; an editor also gets the
 * stage tools (they change the plan tray, never the repo) and ask_user. The write tools stay out of chat for good: saving is its own
 * request (POST /chat/plan/apply), a button a person taps.
 */
export function offeredTools(role) {
  const base = toolDefinitions(role).filter((t) => READ_TOOLS.has(t.function.name) && t.function.name !== "get_workflow_guide" && (role === "editor" || t.function.name !== "fetch_url"));
  const ui = [SUGGEST_REPLIES_TOOL, SHOW_RECIPES_TOOL, OFFER_NAVIGATION_TOOL];
  if (role !== "editor") return [...base, ...ui];
  return [...base, ...toolDefinitions(role).filter((t) => STAGE_TOOLS.has(t.function.name)), ...ui, ASK_USER_TOOL];
}

// --- the loop --------------------------------------------------------------------------------------------------

/**
 * Runs one user turn. Emits events through emit({ type: "text" | "status" | "suggestions" | "cards" | "navigation" | "done", ... }); throws ChatError
 * for failures (the caller turns it into an `error` event).
 *   caller    frozen { role, ... } from makeCaller; decides what dispatch() allows
 *   messages  already sanitized (sanitizeMessages) for a visitor; for an editor the server's own stored history plus the new
 *             user message (full OpenAI-format messages, tool calls and results included)
 *   apiKey    the OpenRouter key for this role
 *   attachments  the editor's photos on this message, [{ path }] in order (stage tools may use one as a recipe photo)
 *   page      the client's page context (untrusted; see pageNote)
 *   trace     a Langfuse trace (or a no-op)
 */
export async function runChat({ caller, messages, page, emit: rawEmit, trace, signal, attachments = [], model = config.chatPublicModel, apiKey = config.chatPublicKey, origin, extraNote, conversation, maxTokens = caller.role === "editor" ? config.chatEditorMaxTokens : config.chatPublicMaxTokens }) {
  const stagedLabels = []; // what this turn put in the tray, in words
  let shownUi = false; // cards, a question, replies, a button or a tray change reached the user this turn
  const emit = (event) => {
    if (["cards", "question", "suggestions", "navigation", "tray"].includes(event.type)) shownUi = true;
    if (event.type === "tray" && event.label && !stagedLabels.includes(event.label)) stagedLabels.push(event.label);
    rawEmit(event);
  };
  const tools = offeredTools(caller.role);
  const offered = new Set(tools.map((t) => t.function.name));

  let rows;
  try {
    rows = catalogueText(await catalogue());
  } catch (err) {
    console.error("Couldn't load the catalogue:", err.message);
    rows = "";
  }
  const lastMsg = messages[messages.length - 1];
  const userText = Array.isArray(lastMsg?.content) ? lastMsg.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : String(lastMsg?.content ?? "");
  const note = [await pageNote(page), extraNote].filter(Boolean).join("\n");
  const book = await loadBook();

  // Stable prefix first (system prompt + catalogue, then the conversation); the volatile page note rides on the latest user message,
  // as plain text, so it works on every model (not all accept a system message mid-conversation) and doesn't break the cached prefix.
  const convo = messages.map((m) => ({ ...m }));
  if (note) {
    const last = convo[convo.length - 1];
    last.content = withNote(last.content, note);
  }
  const thread = [{ role: "system", content: systemPrompt(rows, { editor: caller.role === "editor" }) }, ...convo];
  const base = thread.length; // everything pushed after this is new this turn (an editor's turn is stored)
  const ui = {}; // what the panel shows again on reload: { cards, nav, replies }

  let suggestions = false;
  let askedUser = false;
  let navigationOffered = false;
  const seenCalls = new Map(); // "name\nargs" -> the result already given this turn
  let turnCalls = 0;
  let resultChars = 0;
  let reply = "";
  // Chips of this turn only: answers of an EARLIER ask_user are not suggestions now, and "Save to site" / "Finalise list" typed as plain text
  // become the real buttons (when the tray allows them) or go.
  const oldOptions = new Set(
    messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls || []) : [])).filter((c) => c.function?.name === "ask_user").flatMap((c) => {
      try {
        return JSON.parse(c.function.arguments).options || [];
      } catch {
        return [];
      }
    }).map((o) => normText(o))
  );
  let trayChoice; // "apply_plan" | "finalise_plan" | null, looked up once when a plain chip asks for it
  const PLAN_WORDS = /^(save to site|save|save it|finalise list|finalize list|finalise|finalize|finalise the list)(\s*\(\d+\))?$/i;
  const fixReplies = async (replies) => {
    const out = [];
    for (const r of replies) {
      if (typeof r !== "string") {
        out.push(r);
        continue;
      }
      if (caller.role === "editor" && PLAN_WORDS.test(r.trim())) {
        if (trayChoice === undefined) {
          try {
            trayChoice = trayAction(await trayView(await loadTray(), caller));
          } catch {
            trayChoice = null;
          }
        }
        if (trayChoice && !out.some((x) => x.action === trayChoice)) out.push({ label: trayChoice === "apply_plan" ? "Save to site" : "Finalise list", action: trayChoice });
        continue;
      }
      if (oldOptions.has(normText(r))) continue; // a leftover answer of an earlier question
      out.push(r);
    }
    return out;
  };
  let finalRound = false;
  let lastStatus = "";
  const titles = new Map([...book].map(([slug, r]) => [slug, r.title]));
  let roundNote = ""; // told to the model on its next call, not stored
  const startedAt = Date.now();
  let stoppedLong = false;
  let lastCut = null; // "length" | "dropped": a model call of this turn was cut off (see streamCompletion)
  // The hard stop: the budget above is only checked between model calls, and one call (a thinking model writing the whole shopping list) can
  // run for minutes, past Vercel's maxDuration. Every model call of the turn is aborted at the deadline instead; `signal` is still the client's.
  const deadline = AbortSignal.timeout(Math.max(1, config.chatTurnDeadlineMs));
  const callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const pastDeadline = (err) => deadline.aborted && !signal?.aborted && (err?.name === "TimeoutError" || err?.name === "AbortError");
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // A turn that has been going too long (a slow model looping through tools) stops with a clear line instead of running on in silence.
    if (round > 0 && Date.now() - startedAt > config.chatTurnBudgetMs) {
      stoppedLong = true;
      break;
    }
    finalRound = round === MAX_TOOL_ROUNDS; // out of rounds: one last call without tools, so the user always gets an answer
    const generation = trace.generation({
      name: "generate-response",
      model,
      input: roundNote ? thread.map((m, i) => (i === thread.length - 1 && m.role === "tool" ? { ...m, content: m.content + roundNote } : m)) : thread,
      modelParameters: { temperature: TEMPERATURE, max_tokens: maxTokens, tool_choice: finalRound ? "none" : "auto" },
      metadata: { round: round + 1, promptVersion: PROMPT_VERSION, tools: finalRound ? [] : [...offered] },
    });
    let result;
    let separate = reply.trim() !== ""; // text from an earlier round: start this one in a new paragraph
    // A follow-up round must not say again what the user already has (some models restate their greeting or summary after every tool call):
    // its first words are held back and compared with this turn's text so far; a repeat is swallowed.
    let held = "";
    let guard = reply.trim() ? "check" : "pass"; // check | drop | pass
    let kept = "";
    const emitText = (delta) => {
      if (separate) {
        separate = false;
        delta = `\n\n${delta.replace(/^\s+/, "")}`;
      }
      reply += delta;
      kept += delta;
      emit({ type: "text", delta });
    };
    const before = reply;
    const repeats = (t) => {
      const n = normText(t);
      return n.length >= 12 && normText(before).includes(n.slice(0, Math.min(n.length, 40)));
    };
    try {
      result = await streamCompletion({
        messages: roundNote ? thread.map((m, i) => (i === thread.length - 1 && m.role === "tool" ? { ...m, content: m.content + roundNote } : m)) : thread,
        tools: finalRound ? [] : tools,
        model,
        apiKey,
        signal: callSignal,
        maxTokens,
        onToolProgress: (call) => {
          // the model is still writing a tool call (a recipe, the shopping list can take a while): say what it is, as it grows
          const text = statusFor(call.name, { raw: call.arguments, titles });
          if (text !== lastStatus) {
            lastStatus = text;
            emit({ type: "status", text });
          }
        },
        onText: (delta) => {
          if (guard === "pass") return emitText(delta);
          if (guard === "drop") return;
          held += delta;
          if (normText(held).length >= 40) {
            if (repeats(held)) guard = "drop";
            else {
              guard = "pass";
              emitText(held);
            }
          }
        },
      });
    } catch (err) {
      generation.end({ error: err.message });
      if (!pastDeadline(err)) throw err;
      // Out of time mid-call: whatever it was writing is dropped (a half-written tool call is never run); the turn ends with the clear line.
      if (guard === "check" && held && !repeats(held)) emitText(held);
      if (kept) thread.push({ role: "assistant", content: kept });
      lastCut = "dropped";
      stoppedLong = true;
      break;
    }
    if (guard === "check" && held && !repeats(held)) emitText(held);
    if (guard !== "pass" && !kept) result = { ...result, text: "" }; // what was swallowed isn't part of the turn's text
    generation.end({ output: assistantOutput(result), usage: result.usage, finishReason: result.finishReason, completionStartTime: result.firstTokenAt, metadata: { cut: result.cut, ms: result.ms } });
    if (result.cut) lastCut = result.cut;
    if (result.cut || (!result.text.trim() && !result.toolCalls.length)) logRound(`Chat round ${round + 1} ${result.cut ? "was cut off" : "came back empty"}`, model, maxTokens, result);

    if (!result.toolCalls.length || finalRound) {
      thread.push({ role: "assistant", content: kept || "" });
      break;
    }

    thread.push({
      role: "assistant",
      content: kept || null,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
    });
    let roundCalls = 0;
    for (const call of result.toolCalls) {
      if (++roundCalls > MAX_CALLS_PER_ROUND) {
        thread.push({ role: "tool", tool_call_id: call.id, content: `Error: too many tool calls at once (at most ${MAX_CALLS_PER_ROUND} per step). Ask for fewer.` });
        continue;
      }
      const key = `${call.name}\n${call.arguments || "{}"}`;
      if (seenCalls.has(key)) {
        // the same call again: reuse its answer (it still counts toward the turn's size budget)
        let again = seenCalls.get(key);
        if (resultChars + again.length > MAX_RESULT_CHARS_PER_TURN) again = "Error: this turn has already read as much as it can. Answer with what you have.";
        resultChars += again.length;
        thread.push({ role: "tool", tool_call_id: call.id, content: again });
        continue;
      }
      if (!UI_TOOLS.has(call.name) && ++turnCalls > MAX_TOOL_CALLS_PER_TURN) {
        thread.push({ role: "tool", tool_call_id: call.id, content: `Error: too many tool calls in one turn (at most ${MAX_TOOL_CALLS_PER_TURN}). Answer with what you have.` });
        continue;
      }
      let args;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        thread.push({ role: "tool", tool_call_id: call.id, content: "Error: the arguments were not valid JSON." });
        continue;
      }
      const span = trace.span({ name: call.name, type: observationType(call.name), input: args, metadata: { tool_call_id: call.id, access: UI_TOOLS.has(call.name) ? "ui" : accessOf(TOOL_BY_NAME.get(call.name)) } });
      let content;
      if (call.name === "suggest_replies") {
        let replies = askedUser ? [] : cleanReplies(args, book, { editor: caller.role === "editor" });
        if (replies.length) replies = await fixReplies(replies);
        if (replies.length) {
          suggestions = true;
          ui.replies = replies;
          emit({ type: "suggestions", replies });
        }
        content = JSON.stringify({ shown: replies.length > 0 });
        span.end({ output: content });
      } else if (call.name === "ask_user") {
        const q = askedUser ? null : cleanQuestion(args);
        if (q) {
          askedUser = true;
          ui.question = q;
          delete ui.replies;
          emit({ type: "question", ...q });
        }
        content = JSON.stringify(q ? { shown: true, note: "End your turn now: the answer arrives as the user's next message." } : { shown: false, error: askedUser ? "One question per turn." : "Give a question and 2-6 short options." });
        span.end({ output: content });
      } else if (call.name === "show_recipes") {
        const { cards, dropped } = buildCards(book, args?.slugs);
        if (cards.length) {
          ui.cards = [...(ui.cards || []), ...cards].slice(0, 8);
          emit({ type: "cards", cards });
        }
        content = JSON.stringify(cards.length ? { shown: true, count: cards.length, ...(dropped.length ? { ignored_unknown_slugs: dropped } : {}) } : { shown: false, error: "None of those slugs are in our book." });
        span.end({ output: content });
      } else if (call.name === "offer_navigation") {
        const nav = navigationOffered ? null : buildNavigation(book, args);
        if (nav) {
          navigationOffered = true;
          ui.nav = { label: nav.label, url: nav.url };
          emit({ type: "navigation", label: nav.label, url: nav.url });
        }
        content = JSON.stringify(nav ? { shown: true } : { shown: false, error: navigationOffered ? "One button per answer." : "Unknown recipe slug or page." });
        span.end({ output: content });
      } else if (!offered.has(call.name)) {
        // Layer 2 of the auth model: a tool the model wasn't offered is refused here, before dispatch is even asked.
        console.warn(`Model asked for a tool it was not offered: "${call.name}" (role ${caller.role})`);
        content = `Error: "${call.name}" is not available here.`;
        span.end({ output: content, refused: true });
      } else {
        emit({ type: "status", text: statusFor(call.name, { args, titles }) });
        const out = await dispatch(call.name, args, caller, { origin, chat: { emit, trace, conversationTitle: conversation?.title, attachments, userText } });
        content = resultText(out, RESULT_CAPS[call.name] || MAX_TOOL_RESULT_CHARS);
        span.end({ output: content, error: out.isError && !/^Not allowed/.test(content), refused: out.isError && /^Not allowed/.test(content) });
        if (out.isError) content = `Error: ${content}`;
      }
      if (resultChars + content.length > MAX_RESULT_CHARS_PER_TURN) content = "Error: this turn has already read as much as it can. Answer with what you have.";
      resultChars += content.length;
      seenCalls.set(key, content);
      thread.push({ role: "tool", tool_call_id: call.id, content });
    }
    // The model already spoke and only asked for things to SHOW (chips, cards, a button, a question): nothing is left to say, and asking it
    // again is what makes some models repeat themselves. Finish the turn.
    if (result.toolCalls.every((c) => UI_TOOLS.has(c.name)) && (kept.trim() || askedUser)) break;
    // Text plus data or stage tools: that text is already on the user's screen. Tell the model so, on the last tool result (a message after
    // tool results would break the pairing some providers require).
    // (Only the copy sent to the model carries the note; it is never stored.)
    roundNote = kept.trim() ? `\n\n[Note from the site, not a tool result: you already told the user: "${oneLine(kept, 600)}". Continue from there; don't repeat it.]` : "";
  }
  if (stoppedLong) {
    console.warn(`Chat turn stopped after ${Math.round((Date.now() - startedAt) / 1000)}s (budget ${config.chatTurnBudgetMs}ms)`);
    const line = `${reply.trim() ? "\n\n" : ""}That is taking longer than expected, so I've stopped here. Anything already in the tray is still there: tell me to carry on if you want.`;
    reply += line;
    emit({ type: "text", delta: line });
    thread.push({ role: "assistant", content: line.trim() });
  }
  // A turn that staged something but said nothing gets a fixed one-line confirmation built from what was staged (some models stop after the tool).
  if (!reply.trim() && stagedLabels.length) {
    reply = `Added to the tray: ${stagedLabels.join("; ")}.`;
    emit({ type: "text", delta: reply });
    thread.push({ role: "assistant", content: reply });
  }
  // Chips on (almost) every answer (design 6.1): a model that forgot them gets ONE cheap nudge that offers nothing but suggest_replies; if even
  // that fails, safe chips from the page. No retries, and never after an error (errors leave runChat before this point).
  if (!suggestions && !askedUser && reply.trim() && !stoppedLong) {
    let nudged = [];
    // Try 1 forces the tool. Some providers/models refuse a forced tool_choice (Qwen's thinking mode, for one): then try 2 offers the same single
    // tool without forcing it and asks in words. Whatever goes wrong is logged with the provider's reason, so it shows in the logs.
    const attempts = [
      { toolChoice: { type: "function", function: { name: "suggest_replies" } }, ask: "your answer is done. Call suggest_replies now with 2-4 short replies the user might want to say next, based on what you just said. Do not write any text." },
      { toolChoice: "auto", ask: "Call suggest_replies now with 2-4 short follow-ups to your last answer. Only call the tool; write no other text." },
    ];
    for (const [n, attempt] of attempts.entries()) {
      const nudgeMessages = [...thread, { role: "user", content: `[Note from the site, not from the user: ${attempt.ask}]` }];
      const gen = trace.generation({
        name: "suggest-replies",
        model,
        input: nudgeMessages,
        modelParameters: { temperature: TEMPERATURE, max_tokens: 200, tool_choice: typeof attempt.toolChoice === "string" ? attempt.toolChoice : "suggest_replies" },
        metadata: { attempt: n + 1, promptVersion: PROMPT_VERSION },
      });
      try {
        const out = await streamCompletion({
          messages: nudgeMessages,
          tools: [SUGGEST_REPLIES_TOOL],
          toolChoice: attempt.toolChoice,
          model,
          apiKey,
          signal: callSignal,
          maxTokens: 200,
          onText: () => {},
        });
        gen.end({ output: assistantOutput(out), usage: out.usage, finishReason: out.finishReason, completionStartTime: out.firstTokenAt });
        const call = out.toolCalls.find((c) => c.name === "suggest_replies");
        if (call) {
          try {
            nudged = cleanReplies(JSON.parse(call.arguments || "{}"), book, { editor: caller.role === "editor" });
          } catch {
            nudged = [];
          }
        }
        if (nudged.length) nudged = await fixReplies(nudged);
        if (nudged.length) break;
        console.warn(`Chips nudge ${n + 1} (model ${model}) gave no usable chips: finish ${out.finishReason || "?"}, calls ${out.toolCalls.map((c) => c.name).join(",") || "none"}, text ${JSON.stringify(String(out.text).slice(0, 300))}${call ? `, arguments ${String(call.arguments).slice(0, 300)}` : ""}`);
      } catch (err) {
        gen.end({ error: err.message });
        if (pastDeadline(err)) break; // out of time: page chips below
        if (err?.name === "AbortError") throw err;
        console.warn(`Chips nudge ${n + 1} (model ${model}) failed: ${err.status || ""} ${err.kind || ""} ${String(err.message).slice(0, 300)}`);
        if (!(err instanceof ChatError) || err.kind !== "upstream") break; // out of credit, busy, no vision...: a second try would only cost more
      }
    }
    if (!nudged.length) nudged = await turnChips({ page, editor: caller.role === "editor", ui, fixReplies, staged: stagedLabels.length > 0 });
    if (nudged.length) {
      suggestions = true;
      ui.replies = nudged;
      emit({ type: "suggestions", replies: nudged });
    }
  }
  if (!reply.trim() && !shownUi) {
    // never end a turn in silence
    // A cut-off answer says so (a photo turn writing a whole recipe is the usual one); only a model that really said nothing gets the generic line.
    const photo = attachments.length > 0 || (Array.isArray(lastMsg?.content) && lastMsg.content.some((p) => p.type === "image_url"));
    console.warn(`Chat turn ended with no text and nothing shown${lastCut ? ` (cut off: ${lastCut})` : ""}: sending the fallback line`);
    reply = lastCut ? cutOffLine(lastCut, { photo }) : "Sorry, I didn't manage to answer that. Could you try again?";
    emit({ type: "text", delta: reply });
    thread.push({ role: "assistant", content: reply });
  }
  emit({ type: "done", suggestions });
  // This turn's new model messages (assistant tool calls, tool results, the final answer), the panel extras on the last
  // assistant one, ready to be stored for an editor.
  const produced = thread.slice(base);
  const lastAssistant = produced.findLastIndex((m) => m.role === "assistant");
  if (lastAssistant !== -1 && Object.keys(ui).length) produced[lastAssistant] = { ...produced[lastAssistant], ui };
  return { reply, suggestions, produced };
}
