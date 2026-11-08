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

async function rest(path, { method = "GET", body, prefer, query } = {}) {
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

const q = (params) => new URLSearchParams(params).toString();
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
    query: q({ select: "id,title,created_at,updated_at", user_id: `eq.${userId}`, archived: "eq.false", updated_at: `gt.${cutoffIso(now())}`, order: "updated_at.desc", limit: String(MAX_CONVERSATIONS) }),
  });
  return rows.map((c) => ({ id: c.id, title: c.title || "New chat", updated_at: c.updated_at, expires_at: expiresAt(c.updated_at) }));
}

/** The conversation if it exists, is this user's, and hasn't expired; else null. */
export async function getConversation(id, userId, { now = () => clock.now() } = {}) {
  if (!isUuid(id) || !userId) return null;
  const rows = await rest("conversations", { query: q({ select: "id,user_id,title,created_at,updated_at", id: `eq.${id}`, user_id: `eq.${userId}`, updated_at: `gt.${cutoffIso(now())}`, limit: "1" }) });
  return rows[0] || null;
}

export async function createConversation({ userId, title, id = newId() }) {
  const rows = await rest("conversations", { method: "POST", prefer: "return=representation", body: { id, user_id: userId, title } });
  return rows[0];
}

export async function deleteConversation(id, userId) {
  if (!isUuid(id) || !userId) return false;
  const rows = await rest("conversations", { method: "DELETE", prefer: "return=representation", query: q({ id: `eq.${id}`, user_id: `eq.${userId}` }) });
  return rows.length > 0;
}

/** Stored rows of a conversation in order: { id, role, content (the message object), turn_id, trace_id, feedback }. */
export async function getMessages(conversationId) {
  return rest("messages", { query: q({ select: "id,role,content,turn_id,trace_id,feedback,created_at", conversation_id: `eq.${conversationId}`, order: "seq.asc" }) });
}

/** Appends message objects ({ role, content, ... }) and marks the conversation as just active (retention counts from here). */
export async function appendMessages(conversationId, messages, { turnId, traceId, now = () => clock.now() } = {}) {
  if (!messages.length) return;
  await rest("messages", {
    method: "POST",
    body: messages.map((m) => ({ conversation_id: conversationId, role: m.role, content: m, turn_id: turnId, trace_id: m.role === "user" ? undefined : traceId })),
  });
  await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}` }), body: { updated_at: new Date(now()).toISOString() } });
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
  const out = [];
  for (const row of rows) {
    const { ui, ...m } = row.content || {};
    if (!m.role || (m.role === "assistant" && !m.content && !m.tool_calls)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user") prev.content = `${prev.content}\n\n${m.content}`;
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
  for (const row of rows) {
    const m = row.content || {};
    if (row.role === "user") {
      out.push({ role: "user", content: String(m.content || "") });
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
      if (row.feedback) turn.feedback = row.feedback;
    }
  }
  return out.filter((m) => m.role === "user" || m.content || m.cards?.length);
}

/** A short title from the first message: its first line, cut at a word boundary. No model call, no spend. */
export function titleFrom(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line || "New chat";
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24)).replace(/[\s,.;:!?-]+$/, "")}…`;
}
