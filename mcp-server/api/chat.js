import { config, assertChatConfigured, warnSharedKeys } from "../lib/config.js";
import { verifyUser } from "../lib/auth.js";
import { makeCaller } from "../lib/tools.js";
import { checkRateLimit, checkPanelLimit, clientIp, hashIp, authBlocked, recordAuthFailure } from "../lib/rate-limit.js";
import { runChat, sanitizeMessages, ChatError, MAX_USER_CHARS } from "../lib/chat.js";
import { PROMPT_VERSION } from "../lib/chat-prompt.js";
import { startTrace, setScore, deleteScore } from "../lib/langfuse.js";
import { loadTray, trayView, trayAction, trayNote, dropItem, regeneratePhoto, startFinalise, settleFinalise, trayEvent } from "../lib/tray.js";
import { chatEnabled, publicChatEnabled, DISABLED_BODY, SIGNIN_BODY } from "../lib/chat-switch.js";
import { isNotYet, promoteQuestionOpen, NOT_YET_REPLY } from "../lib/shortcuts.js";
import { applyPlan, pagesLive, PlanError } from "../lib/plan-apply.js";
import { sanitizeUploads, storeUploads, signedUploadUrl, removeConversationUploads, sweepOrphans, isUploadPath, UploadError, MAX_IMAGES } from "../lib/chat-uploads.js";
import { background } from "../lib/background.js";
import { readsOf, statusOf, progressNote, enqueuePhotos, readingEntries, kick, drain, internalSecretOk } from "../lib/photo-queue.js";
import { runFollowUp, afterTurn, TURN_LOCK_MS } from "../lib/follow-up.js";
import {
  postAssistantMessage,
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
  withPhotoNotes,
  photoList,
  setTitle,
  takeTurnLock,
  claimEvents,
  unhandledEvents,
  lockHeld,
  lastReply,
  messagesForPanel,
  endedTurns,
  titleFrom,
  expiresAt,
} from "../lib/chat-store.js";

// The site's chat widget (templates/chat.js) talks to this function. Routes (all under /chat, see vercel.json):
//   POST   /chat                      one chat turn, streamed as Server-Sent Events (below). An editor may add `images` (up to 4 data URLs, re-encoded
//                                     and stored server-side); anyone else sending images gets a 403
//   GET    /chat/me                   who the server thinks the caller is: { role: "public" | "editor", signedIn, email? }
//   GET    /chat/conversations        an editor's own chats (title, last updated, when each expires)
//   GET    /chat/conversations/:id    one of them, as the panel shows it
//   DELETE /chat/conversations/:id    delete one
//   POST   /chat/feedback             an editor's thumbs up / down on a turn (a Langfuse score)
//   GET    /chat/plan                 the household's plan tray as the panel draws it (editors only, household-wide)
//   DELETE /chat/plan/items/:id       drop one tray item (and its staged photo)
//   POST   /chat/plan/items/:id/photo "New photo": remake a staged item's photo
//   POST   /chat/plan/apply           Save: commit the whole tray (or one item: { item_id }, "Save now") in ONE commit. A button a person taps,
//                                     never a model tool: the token and EDITORS are checked afresh on this request
//   GET    /chat/status?slugs=a,b     which of these recipe pages are live yet (a HEAD to the Pages URL, server-side), for "Publishing…"
//   POST   /chat { action: "finalise" } the Finalise list button: a fixed request to the agent (editors only)
//   POST   /chat/uploads              one photo, uploaded as soon as it is picked ({ image: data URL, conversation_id? }): checked and re-encoded like
//                                     `images`, stored, answered with { path, conversation_id } (a new conversation is made for a first message).
//                                     The message then sends `image_paths` (picked order) instead of the photos themselves
//   POST   /chat/internal/continue    the server's own follow-up turn for a note from the site ({ event_id }); POST /chat/internal/drain a fresh
//                                     photo drainer ({ conversation_id }). Both need the X-Chat-Internal-Secret header (CHAT_INTERNAL_SECRET),
//                                     take nothing else from the request (no role, no user, no message) and answer 202 at once
// Photos (docs/parallel-photo-reading.md): the main model never sees them. read_recipe_photos queues them; a separate reader reads them in the
// background; the report arrives as an `event` message and a follow-up turn. Every turn holds the conversation's turn lock (409 { busy } while
// another turn of it runs).
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
//   event: question     data: { question, options, multi }   ask_user: solid answer chips; the tapped answer is the next message
//   event: tray         data: { added }                       the plan tray changed: the panel reloads it
//   event: cards        data: { cards }       recipe cards built from our own data (show_recipes)
//   event: navigation   data: { label, url }  a button that opens one site page (offer_navigation); never navigates by itself
//   event: title        data: { conversation_id, title }     editors only, when a new chat got its title
//   event: photos       data: { numbers }                     editors only: the numbers of the photos on this message (photo-7…), for the badges
//   event: done         data: { suggestions }
//   event: error        data: { message }     safe to show the visitor

export const STILL_WORKING_MS = 15_000;
const MAX_BODY_BYTES = 100_000;
const MAX_EDITOR_BODY_BYTES = 4_300_000; // an editor's message may carry photos (Vercel allows 4.5 MB bodies)
const MAX_UPLOAD_BODY_BYTES = 4_300_000; // one photo per /chat/uploads request
const originOf = (request) => {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  return config.chatInternalUrl || (host ? `https://${host}` : new URL(request.url).origin);
};
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
  const ip = clientIp(request);
  // A visitor that keeps presenting bad tokens is stopped before we ask Supabase again (it counts failures per address).
  if (authBlocked(ip)) return { refusal: { status: 429, error: "Too many failed sign-in attempts. Try again in a while." } };
  const user = await verifyUser(request);
  if (user.error) {
    if (user.status === 401) await recordAuthFailure(ip);
    return { refusal: { status: user.status, error: user.error } };
  }
  return { user };
}

export async function GET(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  const route = routeOf(request);
  if (!chatEnabled()) return reply(DISABLED_BODY, 503); // switched off: before any auth, model, GitHub or Supabase work

  if (route === "me") {
    const { user, refusal } = await whoIs(request);
    if (refusal) return reply({ error: refusal.error }, refusal.status);
    let last = null;
    if (user?.isEditor && storeConfigured()) last = await lastReply(user.userId).catch(() => null); // the bubble's dot on a new page
    return reply({ role: user?.isEditor ? "editor" : "public", signedIn: !!user, public_enabled: publicChatEnabled(), ...(user ? { email: user.email } : {}), ...(last ? { last_reply: last } : {}) });
  }
  if (route === "conversations" || route.startsWith("conversations/")) {
    const editor = await requireEditor(request, reply);
    if (editor.response) return editor.response;
    const id = route.slice("conversations/".length);
    try {
      if (route === "conversations") {
        const conversations = await listConversations(editor.userId);
        background(() => sweepOrphans()); // photos of expired chats (throttled, never throws)
        return reply({ conversations });
      }
      const convo = await getConversation(id, editor.userId);
      if (!convo) return reply({ error: "That chat isn't available." }, 404);
      const rows = await getMessages(convo.id);
      const messages = messagesForPanel(rows);
      for (const m of messages) {
        if (!m.images) continue;
        const urls = await Promise.all(m.images.map((p) => signedUploadUrl(p)));
        m.photo_numbers = m.photo_numbers.filter((_, i) => urls[i]); // a photo that's gone keeps its number for the others
        m.images = urls.filter(Boolean);
      }
      const reads = await readsOf(convo.id).catch(() => []);
      const st = statusOf(reads);
      const pendingNotes = await unhandledEvents(convo.id).catch(() => []);
      // a note waiting for its follow-up counts for 10 minutes; one that can never be handed over (its owner left EDITORS) doesn't keep the panel polling
      const fresh = pendingNotes.filter((e) => Date.now() - Date.parse(e.created_at) < 10 * 60_000);
      const followUp = fresh.length > 0 || (lockHeld(convo) && String(convo.turn_lock_id || "").startsWith("f:"));
      if (st.active || pendingNotes.length) background(() => kick(convo.id, { origin: originOf(request) })); // restarts what a dead instance left behind
      return reply({
        id: convo.id,
        title: convo.title || "New chat",
        expires_at: expiresAt(convo.updated_at),
        messages,
        ended_turns: endedTurns(rows),
        last_reply_at: convo.last_reply_at || null,
        photos: { total: st.total, read: st.read + st.failed, reading: st.queued + st.reading, active: st.active, follow_up: followUp },
      });
    } catch (err) {
      console.error("Loading chats failed:", err.message);
      return reply({ error: "Couldn't load your chats. Try again in a moment." }, 502);
    }
  }
  if (route === "plan") {
    const editor = await requireEditor(request, reply, { limited: true });
    if (editor.response) return editor.response;
    try {
      const caller = editorCaller(editor, request);
      const tray = await loadTray();
      const [view, reading] = await Promise.all([trayView(tray, caller), readingEntries(editor.userId)]);
      return reply({ tray: view, reading });
    } catch (err) {
      console.error("Loading the tray failed:", err.message);
      return reply({ error: "Couldn't load the tray. Try again in a moment." }, 502);
    }
  }
  if (route === "status") {
    const editor = await requireEditor(request, reply, { limited: true });
    if (editor.response) return editor.response;
    const slugs = (new URL(request.url).searchParams.get("slugs") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
    return reply({ live: await pagesLive(slugs) });
  }
  return reply({ error: "Not found" }, 404);
}

const editorCaller = (editor, request) => makeCaller({ role: "editor", email: editor.email, userId: editor.userId, ip: clientIp(request) });
const ITEM_ID = /^[a-f0-9]{8}$/;

export async function DELETE(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  const route = routeOf(request);
  if (!chatEnabled()) return reply(DISABLED_BODY, 503);
  const planItem = route.match(/^plan\/items\/([^/]+)$/);
  if (planItem) {
    const editor = await requireEditor(request, reply, { limited: true });
    if (editor.response) return editor.response;
    if (!ITEM_ID.test(planItem[1])) return reply({ error: "That item isn't in the tray." }, 404);
    try {
      const dropped = await dropItem(planItem[1], editorCaller(editor, request), { userId: editor.userId });
      return dropped ? reply({ ok: true }) : reply({ error: "That item isn't in the tray any more." }, 404);
    } catch (err) {
      console.error("Dropping a tray item failed:", err.message);
      return reply({ error: "Couldn't drop that. Try again in a moment." }, 502);
    }
  }
  if (!route.startsWith("conversations/")) return reply({ error: "Not found" }, 404);
  const editor = await requireEditor(request, reply);
  if (editor.response) return editor.response;
  try {
    const gone = await deleteConversation(route.slice("conversations/".length), editor.userId);
    if (gone) await removeConversationUploads(route.slice("conversations/".length));
    return gone ? reply({ ok: true }) : reply({ error: "That chat isn't available." }, 404);
  } catch (err) {
    console.error("Deleting a chat failed:", err.message);
    return reply({ error: "Couldn't delete that chat. Try again in a moment." }, 502);
  }
}

/** Editor-only endpoints: 401 without a (good) token, 403 for a signed-in non-editor, 503 if chats aren't set up. */
async function requireEditor(request, reply, { limited = false } = {}) {
  if (!storeConfigured()) return { response: reply({ error: "Saved chats aren't available right now." }, 503) };
  if (!request.headers.get("authorization")) return { response: reply({ error: "Sign in first." }, 401) };
  const { user, refusal } = await whoIs(request);
  if (refusal) return { response: reply({ error: refusal.error }, refusal.status) };
  if (!user.isEditor) {
    console.warn("A non-editor tried an editor-only chat endpoint");
    return { response: reply({ error: `${user.email || "This account"} can't edit, so there are no saved chats.` }, 403) };
  }
  if (limited) {
    const limit = await checkPanelLimit(user.userId);
    if (!limit.ok) return { response: reply({ error: "Too many requests. Try again in a while." }, 429, { "Retry-After": String(limit.retryAfter) }) };
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

/** Save, or Save now ({ item_id }): the human tap. The token is verified on THIS request (requireEditor), so a removed editor is refused at once. */
async function planApply(request, reply) {
  const editor = await requireEditor(request, reply);
  if (editor.response) return editor.response;
  let body = {};
  try {
    body = JSON.parse((await request.text()) || "{}") || {};
  } catch {
    return reply({ error: "Send JSON: { item_id?, conversation_id? }" }, 400);
  }
  if (body.item_id !== undefined && !(typeof body.item_id === "string" && ITEM_ID.test(body.item_id))) return reply({ error: "That item isn't in the tray." }, 404);
  const caller = editorCaller(editor, request);
  const trace = startTrace({ name: "tray-save", sessionId: isUuid(body.conversation_id) ? body.conversation_id : undefined, userId: caller.userId, tags: ["editor", "tray"], metadata: { mode: body.item_id ? "save-now" : "save" }, input: body.item_id ? "save now" : "save" });
  try {
    const out = await applyPlan({ caller, itemId: body.item_id, trace });
    let posted = false;
    if (isUuid(body.conversation_id)) {
      try {
        posted = !!(await postAssistantMessage(body.conversation_id, caller.userId, out.summary, out.cards.length ? { cards: out.cards } : undefined));
      } catch (err) {
        console.error("Posting the save summary failed:", err.message);
      }
    }
    trace.finish(`saved ${out.saved}`);
    return reply({ ok: true, saved: out.saved, left: out.left, commit: out.commit, summary: out.summary, cards: out.cards, posted });
  } catch (err) {
    trace.finish(`refused: ${err.message}`.slice(0, 200));
    if (err instanceof PlanError) return reply({ error: err.message, ...err.extra }, err.status);
    console.error("Saving the tray failed:", err.message);
    return reply({ error: "Couldn't save just now, and nothing was committed. Try again in a moment." }, 502);
  }
}

async function planPhoto(request, reply, id) {
  const editor = await requireEditor(request, reply, { limited: true });
  if (editor.response) return editor.response;
  if (!ITEM_ID.test(id)) return reply({ error: "That item isn't in the tray." }, 404);
  try {
    const item = await regeneratePhoto(id, editorCaller(editor, request));
    return item ? reply({ ok: true }) : reply({ error: "That item has no photo to remake." }, 404);
  } catch (err) {
    console.error("Remaking a photo failed:", err.message);
    return reply({ error: "Couldn't do that. Try again in a moment." }, 502);
  }
}

/** One photo, uploaded on pick (design P7): validated and re-encoded like a message's photos, stored under the conversation (made if needed). */
async function upload(request, reply) {
  const editor = await requireEditor(request, reply, { limited: true });
  if (editor.response) return editor.response;
  if (Number(request.headers.get("content-length") || 0) > MAX_UPLOAD_BODY_BYTES) return reply({ error: "That photo is too big." }, 413);
  const raw = await request.text();
  if (raw.length > MAX_UPLOAD_BODY_BYTES) return reply({ error: "That photo is too big." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: "Send JSON: { image, conversation_id? }" }, 400);
  }
  let images;
  try {
    images = await sanitizeUploads([body?.image]);
  } catch (err) {
    if (err instanceof UploadError) return reply({ error: err.message }, err.status);
    return reply({ error: "Couldn't read that photo. Try again." }, 400);
  }
  try {
    let convo;
    if (body?.conversation_id !== undefined && body?.conversation_id !== null) {
      convo = await getConversation(body.conversation_id, editor.userId);
      if (!convo) return reply({ error: "That chat isn't available." }, 404);
    } else convo = await createConversation({ userId: editor.userId, title: null }); // titled by its first message
    const [stored] = await storeUploads(convo.id, images);
    return reply({ path: stored.path, conversation_id: convo.id, width: stored.width, height: stored.height });
  } catch (err) {
    console.error("Storing an uploaded photo failed:", err.message);
    return reply({ error: "Couldn't keep that photo. Try again in a moment." }, 502);
  }
}

/** The server's own routes: the follow-up turn and a fresh drainer. Only with the secret; the work runs after the 202. */
async function internal(request, reply, route) {
  if (!internalSecretOk(request.headers.get("x-chat-internal-secret"))) {
    console.warn(`Refused ${route}: bad or missing internal secret`);
    return reply({ error: "Not found" }, 404);
  }
  let body = {};
  try {
    body = JSON.parse((await request.text()) || "{}") || {};
  } catch {
    return reply({ error: "Send JSON." }, 400);
  }
  const origin = originOf(request);
  if (route === "internal/continue") {
    if (!isUuid(body.event_id)) return reply({ error: "event_id" }, 400);
    background(() => runFollowUp(body.event_id, { origin }));
  } else {
    if (!isUuid(body.conversation_id)) return reply({ error: "conversation_id" }, 400);
    background(() => drain(body.conversation_id, { origin }));
  }
  return reply({ accepted: true }, 202);
}

export async function POST(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

  const route = routeOf(request);
  if (!chatEnabled()) return reply(DISABLED_BODY, 503);
  if (route === "feedback") return feedback(request, reply);
  if (route === "plan/apply") return planApply(request, reply);
  if (route === "uploads") return upload(request, reply);
  if (route === "internal/continue" || route === "internal/drain") return internal(request, reply, route);
  const photo = route.match(/^plan\/items\/([^/]+)\/photo$/);
  if (photo) return planPhoto(request, reply, photo[1]);
  if (route) return reply({ error: "Not found" }, 404);

  warnSharedKeys();
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
  if (!isEditor && !publicChatEnabled()) return reply(SIGNIN_BODY, 403); // editors only: before the rate limit and any model call
  if (isEditor && (!config.chatEditorKey || !storeConfigured())) {
    console.error("Editor chat is not set up: OPENROUTER_CHAT_EDITOR_KEY (or OPENROUTER_API_KEY) and SUPABASE_SERVICE_ROLE_KEY are needed");
    return reply({ error: "The chat isn't available right now." }, 503);
  }
  const caller = isEditor ? makeCaller({ role: "editor", email: user.email, userId: user.userId, ip }) : makeCaller({ role: "public", ip });

  const limitBytes = isEditor ? MAX_EDITOR_BODY_BYTES : MAX_BODY_BYTES;
  if (Number(request.headers.get("content-length") || 0) > limitBytes) return reply({ error: isEditor ? "Those photos are too big." : "That message is too long." }, 413);
  const raw = await request.text();
  if (raw.length > limitBytes) return reply({ error: isEditor ? "Those photos are too big." : "That message is too long." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: isEditor ? "Send JSON: { conversation_id?, message, page }" : "Send JSON: { messages: [{ role, content }], page }" }, 400);
  }

  // Photos are an editor feature (design 3 D3): a visitor, a non-editor account and an editor-looking request without an editor token all get a refusal.
  if (!isEditor && body && typeof body === "object" && body.images !== undefined && body.images !== null) {
    console.warn("A non-editor sent photos to /chat");
    return reply({ error: "Sending photos needs a signed-in editor." }, 403);
  }
  const page = pageFrom(body?.page);
  let messages; // what the loop starts from
  let convo = null; // an editor's conversation (existing, or null until created below)
  let storedUser; // the editor's new user message, as stored
  let finalise = false;
  let history = [];
  let rows = []; // the conversation's stored rows (an editor's)
  let imagePaths = []; // photos uploaded on pick (POST /chat/uploads), in picked order
  if (isEditor) {
    finalise = body?.action === "finalise";
    const hasImages = Array.isArray(body?.images) && body.images.length > 0 && !finalise;
    if (body?.images !== undefined && body?.images !== null && !Array.isArray(body.images)) return reply({ error: "Photos must be a list." }, 400);
    if (body?.image_paths !== undefined && body?.image_paths !== null && !(Array.isArray(body.image_paths) && body.image_paths.every(isUploadPath) && new Set(body.image_paths).size === body.image_paths.length)) return reply({ error: "Those photos weren't uploaded properly. Attach them again." }, 400);
    if (Array.isArray(body?.image_paths) && body.image_paths.length && finalise) return reply({ error: "Photos can't go with Finalise." }, 400);
    imagePaths = Array.isArray(body?.image_paths) ? body.image_paths : [];
    if ((Array.isArray(body?.images) ? body.images.length : 0) + imagePaths.length > MAX_IMAGES) return reply({ error: `At most ${MAX_IMAGES} photos per message.` }, 400);
    if (imagePaths.length && !isUuid(body?.conversation_id)) return reply({ error: "Those photos weren't uploaded properly. Attach them again." }, 400);
    const text = finalise ? "Finalise list" : typeof body?.message === "string" ? body.message.trim().slice(0, MAX_USER_CHARS) : "";
    if (!text && !hasImages && !imagePaths.length) return reply({ error: "Send a message to start the chat." }, 400);
    if (finalise) {
      try {
        const view = await trayView(await loadTray(), caller);
        if (!view?.count) return reply({ error: "The tray is empty." }, 400);
        if (!view.needs_list) return reply({ error: "No shopping list is needed: the tray can be saved as it is." }, 409);
        // startFinalise runs once this turn holds the chat's lock (below): a busy chat must not leave the tray "finalising"
      } catch (err) {
        console.error("Starting Finalise failed:", err.message);
        return reply({ error: "The tray isn't available right now." }, 502);
      }
    }
    storedUser = { role: "user", content: text };
    if (body?.conversation_id !== undefined && body?.conversation_id !== null) {
      try {
        convo = await getConversation(body.conversation_id, caller.userId);
        if (convo) {
          rows = await getMessages(convo.id);
          history = historyForModel(rows);
        }
      } catch (err) {
        console.error("Loading the conversation failed:", err.message);
        return reply({ error: "The chat isn't available right now." }, 502);
      }
      if (!convo) return reply({ error: "That chat isn't available." }, 404);
      // photos uploaded on pick belong to this conversation, and only once
      const used = new Set(photoList(rows).map((p) => p.path));
      if (imagePaths.some((p) => !p.startsWith(`${convo.id}/`) || used.has(p))) return reply({ error: "Those photos weren't uploaded properly. Attach them again." }, 400);
      // another turn of this chat is running (a follow-up, usually): say so before anything is counted; the panel sends again when it's done
      if (lockHeld(convo)) return reply({ busy: true, error: "I'm still working on the last answer. Your message goes as soon as I'm done." }, 409);
    }
    // `messages` is built after the photos are checked and stored (below)
  } else {
    messages = sanitizeMessages(body?.messages);
    if (!messages.length) return reply({ error: "Send a message to start the chat." }, 400);
  }

  const limit = await checkRateLimit(caller);
  if (!limit.ok) return reply({ error: limit.message }, 429, { "Retry-After": String(limit.retryAfter) });

  let images = []; // the editor's validated, re-encoded photos
  if (isEditor && !finalise && body?.images) {
    try {
      images = await sanitizeUploads(body.images);
    } catch (err) {
      if (err instanceof UploadError) return reply({ error: err.message }, err.status);
      console.error("Checking photos failed:", err.message);
      return reply({ error: "Couldn't read those photos. Try again." }, 400);
    }
  }

  const notYet = isEditor && !finalise && !images.length && !imagePaths.length && promoteQuestionOpen(history) && isNotYet(storedUser.content);
  const turnId = newId();
  let title;
  let attachments = []; // [{ path, n }] stored for this message, numbered on from the conversation's earlier photos
  let photos = []; // every photo of the conversation, this message's included: [{ n, path }]
  let reads = []; // the conversation's photo_reads rows
  let lockToken = null;
  if (isEditor) {
    try {
      if (!convo) {
        title = titleFrom(storedUser.content || "Photos");
        convo = await createConversation({ userId: caller.userId, title });
      } else if (!convo.title) {
        title = titleFrom(storedUser.content || "Photos"); // made by a photo upload: its first message names it
        await setTitle(convo.id, title);
      }
      lockToken = `u:${turnId}`;
      if (!(await takeTurnLock(convo.id, lockToken, TURN_LOCK_MS()))) {
        return reply({ busy: true, error: "I'm still working on the last answer. Your message goes as soon as I'm done." }, 409);
      }
      await claimEvents(convo.id); // any note from the site not handed over yet goes to the model in THIS turn
      if (body?.conversation_id !== undefined && body?.conversation_id !== null) {
        // read the chat again now that this turn holds the lock: a note stored while this request was being checked (uploads re-encoded, limits
        // counted) is in the history the model gets, and the photo numbers can't collide with a turn that just finished in another tab
        rows = await getMessages(convo.id);
        history = historyForModel(rows);
        const used = new Set(photoList(rows).map((p) => p.path));
        if (imagePaths.some((p) => used.has(p))) {
          await afterTurn(convo.id, lockToken, { origin: originOf(request) });
          return reply({ error: "Those photos were already sent. Attach them again." }, 400);
        }
      }
      if (finalise) await startFinalise(caller);
      const before = photoList(rows);
      const stored = images.length ? await storeUploads(convo.id, images) : [];
      attachments = [...imagePaths.map((path) => ({ path })), ...stored].map((a, i) => ({ ...a, n: before.length + i + 1 }));
      if (attachments.length) storedUser.images = attachments.map(({ path, width, height }) => ({ path, ...(width ? { width, height } : {}) }));
      await appendMessages(convo.id, [storedUser], { turnId });
      photos = [...before, ...attachments.map(({ n, path }) => ({ n, path }))];
      reads = await readsOf(convo.id).catch(() => []);
      // the main model never sees photos: earlier ones become a line saying what was read, this message's are named by number
      messages = withPhotoNotes(history, before, reads);
      const newText = storedUser.content || "(no message, just the photos)";
      const prev = messages[messages.length - 1];
      // a note from the site just before (photos read) and the user's message go to the model as ONE user message: providers want turns to alternate
      if (prev?.role === "user" && typeof prev.content === "string") messages[messages.length - 1] = { ...prev, content: `${prev.content}\n\n${newText}` };
      else messages.push({ role: "user", content: newText });
    } catch (err) {
      console.error("Saving the chat failed:", err.message);
      if (finalise) await settleFinalise(caller);
      if (lockToken && convo) await afterTurn(convo.id, lockToken, { origin: originOf(request) });
      return reply({ error: "The chat isn't available right now." }, 502);
    }
  }
  // Photos sent with no words while others are still being read need no model: they join the queue and the report covers them all.
  const photosOnly = isEditor && !finalise && attachments.length > 0 && !storedUser.content && reads.some((r) => r.status === "queued" || r.status === "reading");

  let extraNote = "";
  if (isEditor) {
    try {
      extraNote = await trayNote(await loadTray(), caller);
      if (finalise) extraNote += '\nThe user tapped "Finalise list": run the Finalise steps now.';
      if (attachments.length) {
        const ns = attachments.map((a) => a.n);
        extraNote += `\nThe user attached ${ns.length} photo${ns.length === 1 ? "" : "s"} to this message: ${ns.length === 1 ? `photo-${ns[0]}` : `photo-${ns[0]} to photo-${ns[ns.length - 1]}`} (numbered on through this chat, in the order they picked them; the panel shows these numbers). You can't see photos: call read_recipe_photos to have them read (a separate reader reads them in the background), tell the user, and end your turn. Never describe or guess what is in them.`;
      }
      const progress = progressNote(reads, photos.filter((p) => !attachments.some((a) => a.path === p.path)));
      if (progress) extraNote += `\n${progress}`;
    } catch (err) {
      console.error("Reading the tray for the note failed:", err.message);
    }
  }
  const model = isEditor ? config.chatEditorModel : config.chatPublicModel;
  const clientConversationId = typeof body?.conversation_id === "string" ? body.conversation_id.replace(/[^\w-]/g, "").slice(0, 64) : undefined;
  const lastText = isEditor ? storedUser.content || (attachments.length ? "[photo]" : "") : messages[messages.length - 1].content;
  const trace = startTrace({
    name: "chat",
    version: PROMPT_VERSION,
    sessionId: isEditor ? convo.id : clientConversationId,
    userId: isEditor ? caller.userId : `public:${hashIp(ip)}`, // the Supabase user id, never the email or the IP
    tags: [isEditor ? "editor" : "public"],
    metadata: { mode: isEditor ? "editor" : "public", model, turnId: isEditor ? turnId : undefined, photos: attachments.length ? attachments.map((a) => `photo-${a.n}: chat-uploads/${a.path}`) : undefined, page: page.page === "recipe" ? { page: "recipe", slug: page.slug } : { page: page.page } },
    input: lastText,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // An editor's turn runs to the end even if the panel goes away (a phone switching apps or tabs drops the stream): its answer and tray
      // changes are stored, and the panel picks them up when it comes back. waitUntil keeps the function alive for it. A visitor's turn,
      // stored nowhere, stops with the connection.
      const job = (async () => {
        let closed = false;
        let content = false; // something the user can see (or an error) went out
        let lastEvent = Date.now();
        // Long tool-heavy turns can be quiet for a while: say we're still on it instead of leaving "Thinking…" up
        const heartbeat = setInterval(() => {
          if (!closed && Date.now() - lastEvent > STILL_WORKING_MS) send("status", { text: "Still working on it…" });
        }, 5000);
        const send = (event, data) => {
          if (closed) return;
          lastEvent = Date.now();
          if (!["meta", "title", "done", "status"].includes(event)) content = true;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const emit = ({ type, ...data }) => send(type, data);
        let output;
        let shown; // cards, chips, a question: recorded on the trace next to the text
        try {
          if (isEditor) {
            send("meta", { conversation_id: convo.id, turn_id: turnId });
            if (title) send("title", { conversation_id: convo.id, title });
            if (attachments.length) send("photos", { numbers: attachments.map((a) => a.n) });
          }
          const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
          if (photosOnly) {
            let queued = 0;
            for (let i = 0; i < attachments.length; i++) {
              if (!(await checkRateLimit(caller)).ok) break; // each photo read counts toward the editor's limit
              queued++;
            }
            const out = queued ? await enqueuePhotos({ conversationId: convo.id, caller, photos: attachments.slice(0, queued).map(({ n, path }) => ({ n, path })), origin: originOf(request) }) : { queued: [], status: statusOf(reads) };
            const n = out.queued.length;
            const reading = out.status.queued + out.status.reading;
            const line = n
              ? `Added ${n} more photo${n === 1 ? "" : "s"}: reading ${reading} in all. I'll come back when they're all read.`
              : "I couldn't add those photos to the reading just now (too many waiting, or the hourly limit). Try again in a while.";
            emit({ type: "text", delta: line });
            emit({ type: "done", suggestions: false });
            output = line;
            await appendMessages(convo.id, [{ role: "assistant", content: line }], { turnId, traceId: trace.traceId }).catch((err) => console.error("Saving the answer failed:", err.message));
            return;
          }
          if (notYet) {
            // "Not yet" to the promote question: nothing is staged, the tray goes back to collecting, no model call (design 7.1)
            await settleFinalise(caller);
            let chips = [];
            try {
              if (trayAction(await trayView(await loadTray(), caller)) === "finalise_plan") chips = [{ label: "Finalise list", action: "finalise_plan" }];
            } catch {
              // no chip
            }
            emit({ type: "text", delta: NOT_YET_REPLY });
            if (chips.length) emit({ type: "suggestions", replies: chips });
            emit({ type: "done", suggestions: chips.length > 0 });
            output = NOT_YET_REPLY;
            try {
              await appendMessages(convo.id, [{ role: "assistant", content: NOT_YET_REPLY, ...(chips.length ? { ui: { replies: chips } } : {}) }], { turnId, traceId: trace.traceId });
            } catch (err) {
              console.error("Saving the answer failed:", err.message);
            }
            return;
          }
          const result = await runChat({
            caller,
            messages,
            page,
            emit,
            trace,
            signal: isEditor ? undefined : request.signal,
            attachments,
            photos,
            ...(isEditor ? { userText: storedUser.content } : {}), // "use this as the photo" counts only in the editor's own words, never a merged note
            model,
            apiKey: isEditor ? config.chatEditorKey : config.chatPublicKey,
            origin: isEditor ? originOf(request) : host ? `https://${host}` : new URL(request.url).origin,
            extraNote,
            conversation: isEditor ? { id: convo.id, title: convo.title || title } : undefined,
          });
          output = result.reply;
          shown = result.shown;
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
            if (isEditor) {
              // a marker row so a panel that lost the stream learns the turn ended (the model never sees it: no content)
              await appendMessages(convo.id, [{ role: "assistant", content: "", ui: { error: message } }], { turnId, traceId: trace.traceId }).catch((e) => console.error("Saving the error failed:", e.message));
            }
          }
        } finally {
          clearInterval(heartbeat);
          if (!content && !closed) send("error", { message: "The chat didn't answer. Try again in a moment." }); // a stream is never empty
          if (finalise) {
            await settleFinalise(caller);
            trayEvent("tray-finalise", { trace, userId: caller.userId });
          }
          trace.finish(output, shown ? { shown } : undefined);
          if (isEditor && lockToken) await afterTurn(convo.id, lockToken, { origin: originOf(request) }); // a note that came in meanwhile gets its follow-up
          closed = true;
          try {
            controller.close();
          } catch {
            // the client already went away
          }
        }
      })();
      if (isEditor) background(job);
      return job;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
