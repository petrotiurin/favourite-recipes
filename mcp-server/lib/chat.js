// The chat agent (docs/chatbot-design.md D1, D3, 6.1, 7.2): one user turn = a loop of OpenRouter chat-completion calls
// (streamed) with tool calling. Every tool call the model makes goes through dispatch() with the caller, which is what
// enforces access; the model is only OFFERED what the role may call. The client's history is untrusted and is reduced
// to plain user/assistant text before it gets here.
import { z } from "zod";
import { config, COURSES } from "./config.js";
import { TOOLS, accessOf, toolDefinitions, dispatch } from "./tools.js";
import { catalogue, catalogueText, getRecipe, isDraft, isThisWeek, isNextWeek } from "./recipes.js";
import { systemPrompt, SUGGEST_REPLIES_TOOL, SHOW_RECIPES_TOOL, OFFER_NAVIGATION_TOOL, PROMPT_VERSION } from "./chat-prompt.js";
import { loadBook, buildCards, buildNavigation, cleanReplyList } from "./chat-ui.js";

export const MAX_TURNS = 20; // messages kept from the client's history
export const MAX_USER_CHARS = 2000;
export const MAX_ASSISTANT_CHARS = 4000;
export const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 12000;

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

/**
 * One streamed model call. Calls onText(delta) as text arrives; resolves to { text, toolCalls, usage, finishReason }.
 * toolCalls: [{ id, name, arguments (string) }].
 */
async function streamCompletion({ messages, tools, model, apiKey, signal, onText }) {
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
        ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
        temperature: 0.4,
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    console.error("OpenRouter request failed:", err.message);
    throw new ChatError(GENERIC, { status: 502, kind: "upstream" });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`OpenRouter answered ${res.status}: ${text.slice(0, 300)}`);
    throw friendlyOpenRouterError(res.status, text);
  }

  let text = "";
  let usage;
  let finishReason;
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
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const call = (calls[tc.index ?? 0] ||= { id: "", name: "", arguments: "" });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
    }
  }
  const toolCalls = calls.filter((c) => c?.name).map((c, i) => ({ ...c, id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}` }));
  return { text, toolCalls, usage, finishReason };
}

// --- tools ----------------------------------------------------------------------------------------------------

const STATUS = {
  search_recipes: "Looking through the recipes…",
  list_recipes: "Looking through the recipes…",
  get_recipe: "Reading the recipe…",
  get_shopping_list: "Checking the shopping list…",
};

const repliesSchema = z.object({ replies: z.array(z.unknown()).min(1) });

/**
 * Cleans what the model passed to suggest_replies (see chat-ui.js cleanReplyList). `book` (slug -> recipe) is what an action
 * reply's slug is checked against; without it only plain-string replies survive.
 */
export function cleanReplies(args, book) {
  const parsed = repliesSchema.safeParse(args);
  return parsed.success ? cleanReplyList(parsed.data.replies, book) : [];
}

const UI_TOOLS = new Set(["suggest_replies", "show_recipes", "offer_navigation"]);

const resultText = (result) => {
  const text = (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (cut: ${text.length - MAX_TOOL_RESULT_CHARS} more characters)` : text;
};

const READ_TOOLS = new Set(TOOLS.filter((t) => accessOf(t) === "read").map((t) => t.name));

/**
 * The tool definitions offered to a role: the registry's read tools (minus the workflow guides) plus the UI tools.
 * TODO(phase 4): editors also get the stage tools here (they change the plan tray, never the repo); the write tools stay
 * out of chat for good: saving is its own request (POST /chat/plan/apply). Until then an editor is offered exactly what a
 * visitor is, but on the editor's model and key (the role split is real, the extra tools are not offered yet).
 */
export function offeredTools(role) {
  return [...toolDefinitions(role).filter((t) => READ_TOOLS.has(t.function.name) && t.function.name !== "get_workflow_guide"), SUGGEST_REPLIES_TOOL, SHOW_RECIPES_TOOL, OFFER_NAVIGATION_TOOL];
}

// --- the loop --------------------------------------------------------------------------------------------------

/**
 * Runs one user turn. Emits events through emit({ type: "text" | "status" | "suggestions" | "cards" | "navigation" | "done", ... }); throws ChatError
 * for failures (the caller turns it into an `error` event).
 *   caller    frozen { role, ... } from makeCaller; decides what dispatch() allows
 *   messages  already sanitized (sanitizeMessages) for a visitor; for an editor the server's own stored history plus the new
 *             user message (full OpenAI-format messages, tool calls and results included)
 *   apiKey    the OpenRouter key for this role
 *   page      the client's page context (untrusted; see pageNote)
 *   trace     a Langfuse trace (or a no-op)
 */
export async function runChat({ caller, messages, page, emit, trace, signal, model = config.chatPublicModel, apiKey = config.chatPublicKey, origin }) {
  const tools = offeredTools(caller.role);
  const offered = new Set(tools.map((t) => t.function.name));

  let rows;
  try {
    rows = catalogueText(await catalogue());
  } catch (err) {
    console.error("Couldn't load the catalogue:", err.message);
    rows = "";
  }
  const note = await pageNote(page);
  const book = await loadBook();

  // Stable prefix first (system prompt + catalogue, then the conversation); the volatile page note rides on the latest user message,
  // as plain text, so it works on every model (not all accept a system message mid-conversation) and doesn't break the cached prefix.
  const convo = messages.map((m) => ({ ...m }));
  if (note) {
    const last = convo[convo.length - 1];
    last.content = `${last.content}\n\n[Note from the site, not from the user: ${note}]`;
  }
  const thread = [{ role: "system", content: systemPrompt(rows) }, ...convo];
  const base = thread.length; // everything pushed after this is new this turn (an editor's turn is stored)
  const ui = {}; // what the panel shows again on reload: { cards, nav, replies }

  let suggestions = false;
  let navigationOffered = false;
  let reply = "";
  let finalRound = false;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    finalRound = round === MAX_TOOL_ROUNDS; // out of rounds: one last call without tools, so the user always gets an answer
    const generation = trace.generation({ name: `chat round ${round + 1}`, model, input: thread.slice(1), metadata: { promptVersion: PROMPT_VERSION } });
    let result;
    let separate = reply.trim() !== ""; // text from an earlier round: start this one in a new paragraph
    try {
      result = await streamCompletion({
        messages: thread,
        tools: finalRound ? [] : tools,
        model,
        apiKey,
        signal,
        onText: (delta) => {
          if (separate) {
            separate = false;
            delta = `\n\n${delta.replace(/^\s+/, "")}`;
          }
          reply += delta;
          emit({ type: "text", delta });
        },
      });
    } catch (err) {
      generation.end({ error: err.message });
      throw err;
    }
    generation.end({ output: result.text || result.toolCalls.map((c) => `${c.name}(${c.arguments})`).join("\n"), usage: result.usage, finishReason: result.finishReason });

    if (!result.toolCalls.length || finalRound) {
      thread.push({ role: "assistant", content: result.text || "" });
      break;
    }

    thread.push({
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
    });
    for (const call of result.toolCalls) {
      let args;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        thread.push({ role: "tool", tool_call_id: call.id, content: "Error: the arguments were not valid JSON." });
        continue;
      }
      const span = trace.span({ name: `tool ${call.name}`, input: args, metadata: { access: UI_TOOLS.has(call.name) ? "ui" : undefined } });
      let content;
      if (call.name === "suggest_replies") {
        const replies = cleanReplies(args, book);
        if (replies.length) {
          suggestions = true;
          ui.replies = replies;
          emit({ type: "suggestions", replies });
        }
        content = JSON.stringify({ shown: replies.length > 0 });
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
        emit({ type: "status", text: STATUS[call.name] || "Working on it…" });
        const out = await dispatch(call.name, args, caller, { origin });
        content = resultText(out);
        span.end({ output: content, error: out.isError && !/^Not allowed/.test(content), refused: out.isError && /^Not allowed/.test(content) });
        if (out.isError) content = `Error: ${content}`;
      }
      thread.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  if (!reply.trim()) console.warn("Chat turn ended with no text");
  emit({ type: "done", suggestions });
  // This turn's new model messages (assistant tool calls, tool results, the final answer), the panel extras on the last
  // assistant one, ready to be stored for an editor.
  const produced = thread.slice(base);
  const lastAssistant = produced.findLastIndex((m) => m.role === "assistant");
  if (lastAssistant !== -1 && Object.keys(ui).length) produced[lastAssistant] = { ...produced[lastAssistant], ui };
  return { reply, suggestions, produced };
}
