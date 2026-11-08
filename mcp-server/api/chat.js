import { config, assertChatConfigured } from "../lib/config.js";
import { verifyUser } from "../lib/auth.js";
import { makeCaller } from "../lib/tools.js";
import { checkRateLimit, clientIp, hashIp } from "../lib/rate-limit.js";
import { runChat, sanitizeMessages, ChatError, MAX_USER_CHARS } from "../lib/chat.js";
import { startTrace, setScore, deleteScore } from "../lib/langfuse.js";
import {
  storeConfigured,
  isUuid,
  newId,
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  getMessages,
  appendMessages,
  lastAssistantRow,
  setFeedback,
  historyForModel,
  messagesForPanel,
  titleFrom,
  expiresAt,
} from "../lib/chat-store.js";

// The site's chat widget (templates/chat.js) talks to this function. Routes (all under /chat, see vercel.json):
//   POST   /chat                      one chat turn, streamed as Server-Sent Events (below)
//   GET    /chat/me                   who the server thinks the caller is: { role: "public" | "editor", signedIn, email? }
//   GET    /chat/conversations        an editor's own chats (title, last updated, when each expires)
//   GET    /chat/conversations/:id    one of them, as the panel shows it
//   DELETE /chat/conversations/:id    delete one
//   POST   /chat/feedback             an editor's thumbs up / down on a turn (a Langfuse score)
// Who the caller is is decided once from a verified Supabase token (design 4.1), never from the body:
//   no Authorization header                       -> a visitor ("public")
//   valid token, email in EDITORS                 -> an editor
//   valid token, email not in EDITORS             -> a visitor (the panel says the account can't edit)
//   bad or expired token                          -> 401 (never downgraded to visitor: the client refreshes or signs in again)
// A visitor's turn sends { messages: [{ role, content }], page } (their history lives in their browser, so it is untrusted and
// reduced to plain text). An editor's turn sends { conversation_id?, message, page } and NEVER history: the server owns it
// (Supabase tables conversations / messages), so nobody can forge an earlier tool result. Another user's conversation is a 404.
//
// Turn events:
//   event: meta         data: { conversation_id, turn_id }   editors only, first: the ids the client needs
//   event: text         data: { delta }
//   event: status       data: { text }        what the bot is doing, in plain words
//   event: suggestions  data: { replies }     tappable suggested replies: strings, or { label, url } chips that open a site page
//   event: cards        data: { cards }       recipe cards built from our own data (show_recipes)
//   event: navigation   data: { label, url }  a button that opens one site page (offer_navigation); never navigates by itself
//   event: title        data: { conversation_id, title }     editors only, when a new chat got its title
//   event: done         data: { suggestions }
//   event: error        data: { message }     safe to show the visitor

const MAX_BODY_BYTES = 100_000;
const FEEDBACK_REASONS = ["Wrong recipe", "Didn't do what I asked", "Wrong amounts", "Too slow", "Something else"];

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(config.siteUrl).origin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/** The sub-path after /chat: "" | "me" | "conversations" | "conversations/<id>" | "feedback". Vercel's rewrite passes it as ?route=. */
function routeOf(request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("route");
  if (q !== null) return q.replace(/^\/+|\/+$/g, "");
  return url.pathname.replace(/^\/(?:api\/)?chat\/?/, "").replace(/\/+$/, "");
}

/** The page context the client reports, reduced to plain values (the server re-resolves anything that matters). */
function pageFrom(raw) {
  if (!raw || typeof raw !== "object") return {};
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
  return {
    page: str(raw.page, 30),
    slug: str(raw.slug, 120),
    servings: Number.isInteger(raw.servings) ? raw.servings : undefined,
    filter: str(raw.filter, 30),
    search: str(raw.search, 200),
    dismissed: raw.dismissed === true,
  };
}

/** { user } (null for a visitor with no token; { email, userId, isEditor } for a valid token) or { refusal: { status, error } }. */
async function whoIs(request) {
  if (!request.headers.get("authorization")) return { user: null };
  const user = await verifyUser(request);
  if (user.error) return { refusal: { status: user.status, error: user.error } };
  return { user };
}

export async function GET(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200) => Response.json(body, { status, headers });
  const route = routeOf(request);

  if (route === "me") {
    const { user, refusal } = await whoIs(request);
    if (refusal) return reply({ error: refusal.error }, refusal.status);
    return reply({ role: user?.isEditor ? "editor" : "public", signedIn: !!user, ...(user ? { email: user.email } : {}) });
  }
  if (route === "conversations" || route.startsWith("conversations/")) {
    const editor = await requireEditor(request, reply);
    if (editor.response) return editor.response;
    const id = route.slice("conversations/".length);
    try {
      if (route === "conversations") {
        return reply({ conversations: await listConversations(editor.userId) });
      }
      const convo = await getConversation(id, editor.userId);
      if (!convo) return reply({ error: "That chat isn't available." }, 404);
      const rows = await getMessages(convo.id);
      return reply({ id: convo.id, title: convo.title || "New chat", expires_at: expiresAt(convo.updated_at), messages: messagesForPanel(rows) });
    } catch (err) {
      console.error("Loading chats failed:", err.message);
      return reply({ error: "Couldn't load your chats. Try again in a moment." }, 502);
    }
  }
  return reply({ error: "Not found" }, 404);
}

export async function DELETE(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200) => Response.json(body, { status, headers });
  const route = routeOf(request);
  if (!route.startsWith("conversations/")) return reply({ error: "Not found" }, 404);
  const editor = await requireEditor(request, reply);
  if (editor.response) return editor.response;
  try {
    const gone = await deleteConversation(route.slice("conversations/".length), editor.userId);
    return gone ? reply({ ok: true }) : reply({ error: "That chat isn't available." }, 404);
  } catch (err) {
    console.error("Deleting a chat failed:", err.message);
    return reply({ error: "Couldn't delete that chat. Try again in a moment." }, 502);
  }
}

/** Editor-only endpoints: 401 without a (good) token, 403 for a signed-in non-editor, 503 if chats aren't set up. */
async function requireEditor(request, reply) {
  if (!storeConfigured()) return { response: reply({ error: "Saved chats aren't available right now." }, 503) };
  if (!request.headers.get("authorization")) return { response: reply({ error: "Sign in first." }, 401) };
  const { user, refusal } = await whoIs(request);
  if (refusal) return { response: reply({ error: refusal.error }, refusal.status) };
  if (!user.isEditor) {
    console.warn("A non-editor tried an editor-only chat endpoint");
    return { response: reply({ error: `${user.email || "This account"} can't edit, so there are no saved chats.` }, 403) };
  }
  return { userId: user.userId, email: user.email };
}

async function feedback(request, reply) {
  const editor = await requireEditor(request, reply);
  if (editor.response) return editor.response;
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return reply({ error: "Send JSON: { conversation_id, turn_id, value, reasons?, note? }" }, 400);
  }
  const value = body?.value;
  if (!(value === 1 || value === 0 || value === null)) return reply({ error: "value must be 1 (good), 0 (bad) or null (clear)." }, 400);
  try {
    const convo = await getConversation(body?.conversation_id, editor.userId);
    if (!convo) return reply({ error: "That chat isn't available." }, 404);
    const row = await lastAssistantRow(convo.id, body?.turn_id);
    if (!row) return reply({ error: "That reply isn't available." }, 404);
    const scoreId = `user-feedback-${String(body.turn_id).replace(/[^\w-]/g, "")}`;
    if (value === null) {
      await setFeedback(row.id, null);
      if (row.trace_id) await deleteScore(scoreId);
      return reply({ ok: true });
    }
    const reasons = (Array.isArray(body.reasons) ? body.reasons : []).filter((r) => FEEDBACK_REASONS.includes(r)).slice(0, FEEDBACK_REASONS.length);
    const note = typeof body.note === "string" ? body.note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) : "";
    const record = value === 0 ? { value, reasons, note } : { value };
    await setFeedback(row.id, record);
    if (row.trace_id) {
      const comment = [reasons.length ? `Reasons: ${reasons.join(", ")}.` : "", note ? `Note: ${note}` : ""].filter(Boolean).join(" ");
      await setScore({ id: scoreId, traceId: row.trace_id, value, comment });
    }
    return reply({ ok: true });
  } catch (err) {
    console.error("Saving feedback failed:", err.message);
    return reply({ error: "Couldn't save that. Try again in a moment." }, 502);
  }
}

export async function POST(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

  const route = routeOf(request);
  if (route === "feedback") return feedback(request, reply);
  if (route) return reply({ error: "Not found" }, 404);

  try {
    assertChatConfigured();
  } catch (err) {
    console.error(err.message);
    return reply({ error: "The chat isn't available right now." }, 503);
  }

  // Who is calling, decided once from the request (design 4.1): a verified token or nothing, never the body.
  const { user, refusal } = await whoIs(request);
  if (refusal) return reply({ error: refusal.error }, refusal.status);
  const ip = clientIp(request);
  const isEditor = !!user?.isEditor;
  if (isEditor && (!config.chatEditorKey || !storeConfigured())) {
    console.error("Editor chat is not set up: OPENROUTER_CHAT_EDITOR_KEY (or OPENROUTER_API_KEY) and SUPABASE_SERVICE_ROLE_KEY are needed");
    return reply({ error: "The chat isn't available right now." }, 503);
  }
  const caller = isEditor ? makeCaller({ role: "editor", email: user.email, userId: user.userId, ip }) : makeCaller({ role: "public", ip });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return reply({ error: "That message is too long." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: isEditor ? "Send JSON: { conversation_id?, message, page }" : "Send JSON: { messages: [{ role, content }], page }" }, 400);
  }

  const page = pageFrom(body?.page);
  let messages; // what the loop starts from
  let convo = null; // an editor's conversation (existing, or null until created below)
  let storedUser; // the editor's new user message, as stored
  let history = [];
  if (isEditor) {
    const text = typeof body?.message === "string" ? body.message.trim().slice(0, MAX_USER_CHARS) : "";
    if (!text) return reply({ error: "Send a message to start the chat." }, 400);
    storedUser = { role: "user", content: text };
    if (body?.conversation_id !== undefined && body?.conversation_id !== null) {
      try {
        convo = await getConversation(body.conversation_id, caller.userId);
        if (convo) history = historyForModel(await getMessages(convo.id));
      } catch (err) {
        console.error("Loading the conversation failed:", err.message);
        return reply({ error: "The chat isn't available right now." }, 502);
      }
      if (!convo) return reply({ error: "That chat isn't available." }, 404);
    }
    messages = [...history, storedUser];
  } else {
    messages = sanitizeMessages(body?.messages);
    if (!messages.length) return reply({ error: "Send a message to start the chat." }, 400);
  }

  const limit = await checkRateLimit(caller);
  if (!limit.ok) return reply({ error: limit.message }, 429, { "Retry-After": String(limit.retryAfter) });

  const turnId = newId();
  let title;
  if (isEditor) {
    try {
      if (!convo) {
        title = titleFrom(storedUser.content);
        convo = await createConversation({ userId: caller.userId, title });
      }
      await appendMessages(convo.id, [storedUser], { turnId });
    } catch (err) {
      console.error("Saving the chat failed:", err.message);
      return reply({ error: "The chat isn't available right now." }, 502);
    }
  }

  const model = isEditor ? config.chatEditorModel : config.chatPublicModel;
  const clientConversationId = typeof body?.conversation_id === "string" ? body.conversation_id.replace(/[^\w-]/g, "").slice(0, 64) : undefined;
  const lastText = isEditor ? storedUser.content : messages[messages.length - 1].content;
  const trace = startTrace({
    name: "chat",
    sessionId: isEditor ? convo.id : clientConversationId,
    userId: isEditor ? caller.userId : `public:${hashIp(ip)}`, // the Supabase user id, never the email or the IP
    tags: [isEditor ? "editor" : "public"],
    metadata: { mode: isEditor ? "editor" : "public", model, turnId: isEditor ? turnId : undefined, page: page.page === "recipe" ? { page: "recipe", slug: page.slug } : { page: page.page } },
    input: lastText,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const emit = ({ type, ...data }) => send(type, data);
      let output;
      try {
        if (isEditor) {
          send("meta", { conversation_id: convo.id, turn_id: turnId });
          if (title) send("title", { conversation_id: convo.id, title });
        }
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
        const result = await runChat({
          caller,
          messages,
          page,
          emit,
          trace,
          signal: request.signal,
          model,
          apiKey: isEditor ? config.chatEditorKey : config.chatPublicKey,
          origin: host ? `https://${host}` : new URL(request.url).origin,
        });
        output = result.reply;
        if (isEditor) {
          try {
            await appendMessages(convo.id, result.produced, { turnId, traceId: trace.traceId });
          } catch (err) {
            console.error("Saving the answer failed:", err.message);
          }
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          if (!(err instanceof ChatError)) console.error(err);
          else if (err.kind === "out-of-credit") trace.event({ name: "out-of-credit", level: "ERROR" });
          const message = err instanceof ChatError ? err.message : "Something went wrong with the chat. Try again in a moment.";
          send("error", { message });
          output = `error: ${message}`;
        }
      } finally {
        trace.finish(output);
        closed = true;
        try {
          controller.close();
        } catch {
          // the client already went away
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
