// Editors' chats in Supabase (docs/chatbot-design.md section 5, supabase/migrations/*_chat_conversations.sql), reached with the
// service-role key through PostgREST. The server owns the history: the client only ever sends its message and a conversation id.
// Every read and write of a conversation takes the verified caller's userId, and a conversation that isn't theirs looks exactly
// like one that doesn't exist (callers answer 404, never 403, so ids can't be probed). The browser can't reach these tables:
// RLS is on with no policies for anon/authenticated.
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/** Chats are deleted this long after their last message (Q8). Keep in step with purge_old_chats() in the migration. */
export const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const MAX_CONVERSATIONS = 50;
/** Messages (user, assistant and tool rows) sent to the model from the stored history. TODO: summarise older turns instead of dropping them. */
export const MAX_HISTORY_MESSAGES = 40;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID.test(v);
export const newId = () => randomUUID();
/** The clock the store uses for expiry; tests move it. */
export const clock = { now: () => Date.now() };

export class StoreError extends Error {}

export const storeConfigured = () => !!(config.supabaseUrl && config.supabaseServiceKey);

export async function rest(path, { method = "GET", body, prefer, query } = {}) {
  const url = `${config.supabaseUrl}/rest/v1/${path}${query ? `?${query}` : ""}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        apikey: config.supabaseServiceKey,
        Authorization: `Bearer ${config.supabaseServiceKey}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new StoreError(`Supabase unreachable: ${err.message}`);
  }
  if (!res.ok) throw new StoreError(`Supabase ${method} ${path} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const q = (params) => new URLSearchParams(params).toString();
const cutoffIso = (now = Date.now()) => new Date(now - RETENTION_MS).toISOString();

/** When a chat last touched at `updatedAt` goes away. */
export const expiresAt = (updatedAt) => new Date(new Date(updatedAt).getTime() + RETENTION_MS).toISOString();

let lastPurge = 0;
/** Runs the retention function at most once an hour per server instance; never throws. */
export async function purgeOldChats({ now = () => clock.now(), force = false } = {}) {
  if (!force && now() - lastPurge < 60 * 60 * 1000) return null;
  lastPurge = now();
  try {
    return await rest("rpc/purge_old_chats", { method: "POST", body: {} });
  } catch (err) {
    console.error("Purging old chats failed:", err.message);
    return null;
  }
}
export function resetPurgeThrottle() {
  lastPurge = 0;
}

/** The caller's chats, newest first, minus expired ones (a purge may not have run yet). */
export async function listConversations(userId, { now = () => clock.now() } = {}) {
  await purgeOldChats({ now });
  const rows = await rest("conversations", {
    // a conversation with no title yet was made by a photo upload before its first message: not a chat yet
    query: q({ select: "id,title,created_at,updated_at", user_id: `eq.${userId}`, archived: "eq.false", title: "not.is.null", updated_at: `gt.${cutoffIso(now())}`, order: "updated_at.desc", limit: String(MAX_CONVERSATIONS) }),
  });
  return rows.map((c) => ({ id: c.id, title: c.title || "New chat", updated_at: c.updated_at, expires_at: expiresAt(c.updated_at) }));
}

/** The conversation if it exists, is this user's, and hasn't expired; else null. */
export async function getConversation(id, userId, { now = () => clock.now() } = {}) {
  if (!isUuid(id) || !userId) return null;
  const rows = await rest("conversations", { query: q({ select: "id,user_id,title,created_at,updated_at,turn_lock_until,turn_lock_id,last_reply_at", id: `eq.${id}`, user_id: `eq.${userId}`, updated_at: `gt.${cutoffIso(now())}`, limit: "1" }) });
  return rows[0] || null;
}

export async function createConversation({ userId, title, id = newId() }) {
  const rows = await rest("conversations", { method: "POST", prefer: "return=representation", body: { id, user_id: userId, title: title ?? null } });
  return rows[0];
}

/** Gives a conversation made by a photo upload (no title yet) its title from the first message. */
export async function setTitle(conversationId, title) {
  await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}`, title: "is.null" }), body: { title } });
}

export async function deleteConversation(id, userId) {
  if (!isUuid(id) || !userId) return false;
  const rows = await rest("conversations", { method: "DELETE", prefer: "return=representation", query: q({ id: `eq.${id}`, user_id: `eq.${userId}` }) });
  return rows.length > 0;
}

/** Stored rows of a conversation in order: { id, role, content (the message object), turn_id, trace_id, feedback }. */
export async function getMessages(conversationId) {
  return rest("messages", { query: q({ select: "id,role,content,turn_id,trace_id,feedback,created_at,handled_at", conversation_id: `eq.${conversationId}`, order: "seq.asc" }) });
}

/** Appends message objects ({ role, content, ... }) and marks the conversation as just active (retention counts from here). */
export async function appendMessages(conversationId, messages, { turnId, traceId, now = () => clock.now() } = {}) {
  if (!messages.length) return;
  await rest("messages", {
    method: "POST",
    body: messages.map((m) => ({ conversation_id: conversationId, role: m.role, content: m, turn_id: turnId, trace_id: m.role === "user" ? undefined : traceId })),
  });
  const at = new Date(now()).toISOString();
  const reply = messages.some((m) => m.role === "assistant" || m.role === "event");
  await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}` }), body: { updated_at: at, ...(reply ? { last_reply_at: at } : {}) } });
}

// --- notes from the site (role "event") and the turn lock (docs/parallel-photo-reading.md 2.5) -------------------------------------

/**
 * Stores a note from the site in the conversation: `content` is what the model is handed (as a user-role note), `summary` the panel's status
 * line. Returns the row id. Unhandled until a turn claims it (claimEvents).
 */
export async function appendEvent(conversationId, { content, summary, kind = "photos" }, { now = () => clock.now() } = {}) {
  const id = newId();
  await rest("messages", { method: "POST", body: [{ id, conversation_id: conversationId, role: "event", content: { role: "event", kind, content, summary } }] });
  const at = new Date(now()).toISOString();
  await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}` }), body: { updated_at: at, last_reply_at: at } });
  return id;
}

/** Atomically marks every unhandled event of the conversation handled and returns them (whoever calls first gets them). */
export async function claimEvents(conversationId, { now = () => clock.now() } = {}) {
  return (await rest("messages", { method: "PATCH", prefer: "return=representation", query: q({ conversation_id: `eq.${conversationId}`, role: "eq.event", handled_at: "is.null" }), body: { handled_at: new Date(now()).toISOString() } })) || [];
}

export async function unhandledEvents(conversationId) {
  return rest("messages", { query: q({ select: "id,created_at", conversation_id: `eq.${conversationId}`, role: "eq.event", handled_at: "is.null", order: "seq.asc" }) });
}

/** One event row (with its conversation), or null. */
export async function getEvent(id) {
  if (!isUuid(id)) return null;
  return (await rest("messages", { query: q({ select: "id,conversation_id,role,content,handled_at,created_at", id: `eq.${id}`, role: "eq.event", limit: "1" }) }))[0] || null;
}

/** The conversation's owner, by id alone (the server's own follow-up turn; never from a request). */
export async function conversationById(id) {
  if (!isUuid(id)) return null;
  return (await rest("conversations", { query: q({ select: "id,user_id,title,updated_at,turn_lock_until,turn_lock_id", id: `eq.${id}`, limit: "1" }) }))[0] || null;
}

/** Takes the conversation's turn lock for `ms` (true) unless another turn holds it (false). `token` identifies the holder ("u:…" a user turn, "f:…" a follow-up). */
export async function takeTurnLock(conversationId, token, ms) {
  return (await rest("rpc/take_turn_lock", { method: "POST", body: { p_conversation: conversationId, p_token: token, p_ms: Math.round(ms) } })) === true;
}

/** Releases the lock if this holder still has it. Never throws. */
export async function releaseTurnLock(conversationId, token) {
  try {
    await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}`, turn_lock_id: `eq.${token}` }), body: { turn_lock_until: null, turn_lock_id: null } });
  } catch (err) {
    console.error("Releasing the turn lock failed:", err.message);
  }
}

export const lockHeld = (convo, now = clock.now()) => !!convo?.turn_lock_until && Date.parse(convo.turn_lock_until) > now;

/** The newest reply across the user's chats ({ conversation_id, at }) for the bubble's unread dot, or null. */
export async function lastReply(userId, { now = () => clock.now() } = {}) {
  const rows = await rest("conversations", { query: q({ select: "id,last_reply_at", user_id: `eq.${userId}`, last_reply_at: "not.is.null", updated_at: `gt.${cutoffIso(now())}`, order: "last_reply_at.desc", limit: "1" }) });
  return rows[0] ? { conversation_id: rows[0].id, at: rows[0].last_reply_at } : null;
}

// --- photo numbers ---------------------------------------------------------------------------------------------------------------

/**
 * Every photo attached in the conversation, numbered in order (messages in order, each message's photos in picked order): [{ n, path }]. The
 * panel's badges, the photo_reads rows and the model's "photo-7" all use these numbers.
 */
export function photoList(rows) {
  const out = [];
  for (const row of rows) {
    if (row.role !== "user") continue;
    for (const i of row.content?.images || []) {
      const path = typeof i === "string" ? i : i?.path;
      if (path) out.push({ n: out.length + 1, path });
    }
  }
  return out;
}

/** The last assistant row of a turn (where its feedback lives), or null. */
export async function lastAssistantRow(conversationId, turnId) {
  if (typeof turnId !== "string" || !turnId || turnId.length > 64) return null;
  const rows = await rest("messages", { query: q({ select: "id,trace_id,feedback", conversation_id: `eq.${conversationId}`, turn_id: `eq.${turnId}`, role: "eq.assistant", order: "seq.desc", limit: "1" }) });
  return rows[0] || null;
}

export async function setFeedback(messageId, feedback) {
  await rest("messages", { method: "PATCH", query: q({ id: `eq.${messageId}` }), body: { feedback } });
}

// --- stored rows <-> what the model and the panel see ---------------------------------------------------------------

/**
 * The stored messages as the model should see them: the message objects without our `ui` extras, consecutive user messages
 * (a turn whose answer failed) merged, at most `max` of them and never starting in the middle of a tool exchange.
 */
export function historyForModel(rows, max = MAX_HISTORY_MESSAGES) {
  // user messages keep `images` (paths) here; withPhotoNotes() turns them into a text line before the model sees them
  const out = [];
  for (const row of rows) {
    let { ui, ...m } = row.content || {};
    // a note from the site goes to the model as a user-role note (several providers only take a system message at the start)
    if (row.role === "event") m = { role: "user", content: `[Note from the site, not from the user: ${String(m.content || "")}]` };
    if (!m.role || (m.role === "assistant" && !m.content && !m.tool_calls)) continue;
    if (Array.isArray(m.images)) m.images = m.images.map((i) => (typeof i === "string" ? i : i?.path)).filter(Boolean);
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user") {
      prev.content = `${prev.content}\n\n${m.content}`;
      if (m.images?.length) prev.images = [...(prev.images || []), ...m.images];
    }
    else out.push(m);
  }
  const tail = out.slice(-max);
  while (tail.length && tail[0].role !== "user") tail.shift();
  return tail;
}

/**
 * The stored rows as the panel shows them: user messages, and one assistant message per turn (the text of all its model
 * rounds, with the cards, button and suggested replies of the turn), carrying the turn id and any feedback.
 */
export function messagesForPanel(rows) {
  const out = [];
  let turn = null;
  let photoN = 0;
  for (const row of rows) {
    const m = row.content || {};
    if (row.role === "user") {
      const images = Array.isArray(m.images) ? m.images.map((i) => (typeof i === "string" ? i : i?.path)).filter(Boolean) : [];
      out.push({ role: "user", content: String(m.content || ""), ...(images.length ? { images, photo_numbers: images.map(() => ++photoN) } : {}) });
      turn = null;
    } else if (row.role === "event") {
      if (m.summary) out.push({ role: "event", content: String(m.summary).slice(0, 300) });
      turn = null;
    } else if (row.role === "assistant") {
      if (!turn || turn.turn_id !== row.turn_id) {
        turn = { role: "assistant", content: "", turn_id: row.turn_id || null };
        out.push(turn);
      }
      if (m.content) turn.content = turn.content ? `${turn.content}\n\n${m.content}` : m.content;
      const ui = m.ui || {};
      if (ui.cards?.length) turn.cards = [...(turn.cards || []), ...ui.cards].slice(0, 8);
      if (ui.nav) turn.nav = ui.nav;
      if (ui.replies?.length) turn.replies = ui.replies;
      if (ui.question) turn.question = ui.question;
      if (row.feedback) turn.feedback = row.feedback;
    }
  }
  return out.filter((m) => m.role === "user" || m.role === "event" || m.content || m.cards?.length || m.question);
}

/**
 * The turns that have ended, as { turnId: null (answered) | "error message" }: a turn's answer is stored when it ends, even when the
 * panel lost the stream, so a panel that came back checks here for the turn it was waiting on.
 */
export function endedTurns(rows) {
  const out = {};
  for (const row of rows) {
    if (row.role !== "assistant" || !row.turn_id) continue;
    const err = row.content?.ui?.error;
    if (!(row.turn_id in out) || out[row.turn_id] !== null) out[row.turn_id] = typeof err === "string" && err ? err.slice(0, 300) : null;
  }
  return out;
}

/** A short title from the first message: its first line, cut at a word boundary. No model call, no spend. */
export function titleFrom(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line || "New chat";
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24)).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/**
 * Posts a message from the bot into a chat on the user's behalf (Save's summary): an assistant row with its panel extras (`ui`), as a turn of
 * its own. The model sees the text on later turns, not the extras. Only if the conversation is this user's; returns the turn id or null.
 */
export async function postAssistantMessage(conversationId, userId, content, ui) {
  const convo = await getConversation(conversationId, userId);
  if (!convo) return null;
  const turnId = newId();
  await appendMessages(convo.id, [{ role: "assistant", content, ...(ui ? { ui } : {}) }], { turnId });
  return turnId;
}

// --- photos in the history -------------------------------------------------------------------------------------------------

/**
 * The model-facing history without any image (docs/parallel-photo-reading.md 2.7): the main model never sees photos. Each user message's
 * photos become one text line with their numbers and what the photo reader made of them, e.g.
 * "[Photos on this message: photo-3 (read as "Dal makhani", staged), photo-4 (being read)]". `photos` is photoList() of the conversation,
 * `reads` the conversation's photo_reads rows. The `images` key never goes on.
 */
export function withPhotoNotes(history, photos, reads = []) {
  const nOf = new Map(photos.map((p) => [p.path, p.n]));
  const byPath = new Map(reads.map((r) => [r.path, r]));
  return history.map((m0) => {
    const m = { ...m0 };
    const paths = m.images;
    delete m.images;
    if (m.role !== "user" || !paths?.length) return m;
    const bits = paths.map((path) => {
      const n = nOf.get(path);
      const r = byPath.get(path);
      const label = n ? `photo-${n}` : "a photo";
      if (!r) return `${label} (not read yet)`;
      if (r.status === "queued" || r.status === "reading") return `${label} (being read)`;
      if (r.status === "skipped") return `${label} (skipped)`;
      if (r.status === "failed") return `${label} (couldn't be read)`;
      const kind = r.result?.kind;
      const title = r.result?.recipe?.title;
      const what = kind === "dish" ? "a photo of a dish" : kind === "other" ? "not a recipe" : title ? `read as ${JSON.stringify(title.slice(0, 60))}` : "read";
      return `${label} (${what}${r.group_id && r.group_id.includes("+") ? `, part of photo-${r.group_id}` : ""}${r.tray_item_id ? ", staged" : ""})`;
    });
    const line = `[Photos on this message: ${bits.join(", ")}]`;
    m.content = [String(m.content || "").trim(), line].filter(Boolean).join("\n");
    return m;
  });
}
