// Editors' chats in Supabase (docs/chatbot-design.md section 5, supabase/migrations/*_chat_conversations.sql), reached with the
// service-role key through PostgREST. The server owns the history: the client only ever sends its message and a conversation id.
// Every read and write of a conversation takes the verified caller's userId, and a conversation that isn't theirs looks exactly
// like one that doesn't exist (callers answer 404, never 403, so ids can't be probed). The browser can't reach these tables:
// RLS is on with no policies for anon/authenticated.
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { Now } from "./types/common.ts";
import type {
  Conversation,
  ConversationListing,
  ConversationLock,
  ConversationRow,
  Feedback,
  MessageRow,
  MessageUi,
  ModelMessage,
  PanelMessage,
  PhotoNumber,
  PhotoReadRow,
  StoredAssistantMessage,
  StoredImage,
  StoredMessage,
  StoredRow,
  StoredUserMessage,
} from "./types/rows.ts";

/** Chats are deleted this long after their last message (Q8). Keep in step with purge_old_chats() in the migration. */
export const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const MAX_CONVERSATIONS = 50;
/** Messages (user, assistant and tool rows) sent to the model from the stored history. TODO: summarise older turns instead of dropping them. */
export const MAX_HISTORY_MESSAGES = 40;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const newId = () => randomUUID();
/** The clock the store uses for expiry; tests move it. */
export const clock = { now: () => Date.now() };

export class StoreError extends Error {}

export const storeConfigured = () => !!(config.supabaseUrl && config.supabaseServiceKey);

export interface RestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** The Prefer header, e.g. "return=representation". */
  prefer?: string;
  /** The query string, from q(). */
  query?: string;
}

/**
 * One PostgREST call. Resolves the parsed JSON, or null when the answer has no body (a 204, or a PATCH / DELETE that didn't ask for
 * `return=representation`). `T` is what the caller expects the JSON to be: PostgREST isn't checked against it.
 */
export async function rest<T = unknown>(path: string, { method = "GET", body, prefer, query }: RestOptions = {}): Promise<T | null> {
  const url = `${config.supabaseUrl}/rest/v1/${path}${query ? `?${query}` : ""}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        apikey: config.supabaseServiceKey as string,
        Authorization: `Bearer ${config.supabaseServiceKey}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new StoreError(`Supabase unreachable: ${errorMessage(err)}`);
  }
  if (!res.ok) throw new StoreError(`Supabase ${method} ${path} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

/** `rest` for calls that answer rows: the rows, [] when there is no body. */
export async function rows<T>(path: string, options?: RestOptions): Promise<T[]> {
  return (await rest<T[]>(path, options)) ?? [];
}

export const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();
const cutoffIso = (now = Date.now()) => new Date(now - RETENTION_MS).toISOString();

/** When a chat last touched at `updatedAt` goes away. */
export const expiresAt = (updatedAt: string | number | Date): string => new Date(new Date(updatedAt).getTime() + RETENTION_MS).toISOString();

let lastPurge = 0;
/** Runs the retention function at most once an hour per server instance; never throws. */
export async function purgeOldChats({ now = () => clock.now(), force = false }: { now?: Now; force?: boolean } = {}) {
  if (!force && now() - lastPurge < 60 * 60 * 1000) return null;
  lastPurge = now();
  try {
    return await rest("rpc/purge_old_chats", { method: "POST", body: {} });
  } catch (err) {
    console.error("Purging old chats failed:", errorMessage(err));
    return null;
  }
}
export function resetPurgeThrottle() {
  lastPurge = 0;
}

/** The caller's chats, newest first, minus expired ones (a purge may not have run yet). */
export async function listConversations(userId: string, { now = () => clock.now() }: { now?: Now } = {}): Promise<ConversationListing[]> {
  await purgeOldChats({ now });
  const list = await rows<Pick<ConversationRow, "id" | "title" | "created_at" | "updated_at">>("conversations", {
    // a conversation with no title yet was made by a photo upload before its first message: not a chat yet
    query: q({ select: "id,title,created_at,updated_at", user_id: `eq.${userId}`, archived: "eq.false", title: "not.is.null", updated_at: `gt.${cutoffIso(now())}`, order: "updated_at.desc", limit: String(MAX_CONVERSATIONS) }),
  });
  return list.map((c) => ({ id: c.id, title: c.title || "New chat", updated_at: c.updated_at, expires_at: expiresAt(c.updated_at) }));
}

/** The conversation if it exists, is this user's, and hasn't expired; else null. */
export async function getConversation(id: unknown, userId: string | undefined, { now = () => clock.now() }: { now?: Now } = {}): Promise<Conversation | null> {
  if (!isUuid(id) || !userId) return null;
  const found = await rows<Conversation>("conversations", { query: q({ select: "id,user_id,title,created_at,updated_at,turn_lock_until,turn_lock_id,last_reply_at", id: `eq.${id}`, user_id: `eq.${userId}`, updated_at: `gt.${cutoffIso(now())}`, limit: "1" }) });
  return found[0] || null;
}

export async function createConversation({ userId, title, id = newId() }: { userId: string; title?: string | null; id?: string }): Promise<ConversationRow> {
  const created = await rows<ConversationRow>("conversations", { method: "POST", prefer: "return=representation", body: { id, user_id: userId, title: title ?? null } });
  return created[0];
}

/** Gives a conversation made by a photo upload (no title yet) its title from the first message. */
export async function setTitle(conversationId: string, title: string) {
  await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}`, title: "is.null" }), body: { title } });
}

export async function deleteConversation(id: unknown, userId: string | undefined): Promise<boolean> {
  if (!isUuid(id) || !userId) return false;
  const deleted = await rows<ConversationRow>("conversations", { method: "DELETE", prefer: "return=representation", query: q({ id: `eq.${id}`, user_id: `eq.${userId}` }) });
  return deleted.length > 0;
}

/** Stored rows of a conversation in order: { id, role, content (the message object), turn_id, trace_id, feedback }. */
export async function getMessages(conversationId: string): Promise<StoredRow[]> {
  return rows<StoredRow>("messages", { query: q({ select: "id,role,content,turn_id,trace_id,feedback,created_at,handled_at", conversation_id: `eq.${conversationId}`, order: "seq.asc" }) });
}

/** Appends message objects ({ role, content, ... }) and marks the conversation as just active (retention counts from here). */
export async function appendMessages(conversationId: string, messages: StoredMessage[], { turnId, traceId, now = () => clock.now() }: { turnId?: string; traceId?: string; now?: Now } = {}) {
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
export async function appendEvent(conversationId: string, { content, summary, kind = "photos" }: { content: string; summary: string; kind?: string }, { now = () => clock.now() }: { now?: Now } = {}): Promise<string> {
  const id = newId();
  await rest("messages", { method: "POST", body: [{ id, conversation_id: conversationId, role: "event", content: { role: "event", kind, content, summary } }] });
  const at = new Date(now()).toISOString();
  await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}` }), body: { updated_at: at, last_reply_at: at } });
  return id;
}

/** Atomically marks every unhandled event of the conversation handled and returns them (whoever calls first gets them). */
export async function claimEvents(conversationId: string, { now = () => clock.now() }: { now?: Now } = {}): Promise<MessageRow[]> {
  return rows<MessageRow>("messages", { method: "PATCH", prefer: "return=representation", query: q({ conversation_id: `eq.${conversationId}`, role: "eq.event", handled_at: "is.null" }), body: { handled_at: new Date(now()).toISOString() } });
}

export async function unhandledEvents(conversationId: string): Promise<Pick<MessageRow, "id" | "created_at">[]> {
  return rows<Pick<MessageRow, "id" | "created_at">>("messages", { query: q({ select: "id,created_at", conversation_id: `eq.${conversationId}`, role: "eq.event", handled_at: "is.null", order: "seq.asc" }) });
}

/** One event row (with its conversation), or null. */
export async function getEvent(id: unknown): Promise<Pick<MessageRow, "id" | "conversation_id" | "role" | "content" | "handled_at" | "created_at"> | null> {
  if (!isUuid(id)) return null;
  return (await rows<Pick<MessageRow, "id" | "conversation_id" | "role" | "content" | "handled_at" | "created_at">>("messages", { query: q({ select: "id,conversation_id,role,content,handled_at,created_at", id: `eq.${id}`, role: "eq.event", limit: "1" }) }))[0] || null;
}

/** The conversation's owner, by id alone (the server's own follow-up turn; never from a request). */
export async function conversationById(id: unknown): Promise<ConversationLock | null> {
  if (!isUuid(id)) return null;
  return (await rows<ConversationLock>("conversations", { query: q({ select: "id,user_id,title,updated_at,turn_lock_until,turn_lock_id", id: `eq.${id}`, limit: "1" }) }))[0] || null;
}

/** Takes the conversation's turn lock for `ms` (true) unless another turn holds it (false). `token` identifies the holder ("u:…" a user turn, "f:…" a follow-up). */
export async function takeTurnLock(conversationId: string, token: string, ms: number): Promise<boolean> {
  return (await rest("rpc/take_turn_lock", { method: "POST", body: { p_conversation: conversationId, p_token: token, p_ms: Math.round(ms) } })) === true;
}

/** Releases the lock if this holder still has it. Never throws. */
export async function releaseTurnLock(conversationId: string, token: string) {
  try {
    await rest("conversations", { method: "PATCH", query: q({ id: `eq.${conversationId}`, turn_lock_id: `eq.${token}` }), body: { turn_lock_until: null, turn_lock_id: null } });
  } catch (err) {
    console.error("Releasing the turn lock failed:", errorMessage(err));
  }
}

export const lockHeld = (convo: { turn_lock_until?: string | null } | null | undefined, now: number = clock.now()): boolean => !!convo?.turn_lock_until && Date.parse(convo.turn_lock_until) > now;

/** The newest reply across the user's chats ({ conversation_id, at }) for the bubble's unread dot, or null. */
export async function lastReply(userId: string, { now = () => clock.now() }: { now?: Now } = {}): Promise<{ conversation_id: string; at: string } | null> {
  const latest = await rows<Pick<ConversationRow, "id" | "last_reply_at">>("conversations", { query: q({ select: "id,last_reply_at", user_id: `eq.${userId}`, last_reply_at: "not.is.null", updated_at: `gt.${cutoffIso(now())}`, order: "last_reply_at.desc", limit: "1" }) });
  return latest[0] ? { conversation_id: latest[0].id, at: latest[0].last_reply_at! } : null;
}

// --- photo numbers ---------------------------------------------------------------------------------------------------------------

/**
 * Every photo attached in the conversation, numbered in order (messages in order, each message's photos in picked order): [{ n, path }]. The
 * panel's badges, the photo_reads rows and the model's "photo-7" all use these numbers.
 */
export function photoList(messages: Pick<StoredRow, "role" | "content">[]): PhotoNumber[] {
  const out: PhotoNumber[] = [];
  for (const row of messages) {
    if (row.role !== "user") continue;
    for (const i of (row.content as Partial<StoredUserMessage> | null)?.images || []) {
      const path = typeof i === "string" ? i : i?.path;
      if (path) out.push({ n: out.length + 1, path });
    }
  }
  return out;
}

/** The last assistant row of a turn (where its feedback lives), or null. */
export async function lastAssistantRow(conversationId: string, turnId: unknown): Promise<Pick<MessageRow, "id" | "trace_id" | "feedback"> | null> {
  if (typeof turnId !== "string" || !turnId || turnId.length > 64) return null;
  const found = await rows<Pick<MessageRow, "id" | "trace_id" | "feedback">>("messages", { query: q({ select: "id,trace_id,feedback", conversation_id: `eq.${conversationId}`, turn_id: `eq.${turnId}`, role: "eq.assistant", order: "seq.desc", limit: "1" }) });
  return found[0] || null;
}

export async function setFeedback(messageId: string, feedback: Feedback | null) {
  await rest("messages", { method: "PATCH", query: q({ id: `eq.${messageId}` }), body: { feedback } });
}

// --- stored rows <-> what the model and the panel see ---------------------------------------------------------------

/**
 * The stored messages as the model should see them: the message objects without our `ui` extras, consecutive user messages
 * (a turn whose answer failed) merged, at most `max` of them and never starting in the middle of a tool exchange.
 */
/** A stored message read defensively: whatever is in the jsonb column, with the keys these functions look at. */
interface LooseMessage {
  role?: string;
  content?: unknown;
  images?: unknown;
  ui?: MessageUi;
  summary?: unknown;
}
const imagePaths = (images: unknown[]): string[] => images.map((i) => (typeof i === "string" ? i : (i as { path?: string } | null)?.path)).filter((p): p is string => !!p);

export function historyForModel(messages: Pick<StoredRow, "role" | "content">[], max = MAX_HISTORY_MESSAGES): ModelMessage[] {
  // user messages keep `images` (paths) here; withPhotoNotes() turns them into a text line before the model sees them
  const out: LooseMessage[] = [];
  for (const row of messages) {
    const { ui: _ui, ...stored } = (row.content || {}) as LooseMessage;
    let m: LooseMessage = stored;
    // a note from the site goes to the model as a user-role note (several providers only take a system message at the start)
    if (row.role === "event") m = { role: "user", content: `[Note from the site, not from the user: ${String(m.content || "")}]` };
    if (!m.role || (m.role === "assistant" && !m.content && !(m as { tool_calls?: unknown }).tool_calls)) continue;
    if (Array.isArray(m.images)) m.images = imagePaths(m.images);
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user") {
      prev.content = `${prev.content}\n\n${m.content}`;
      if ((m.images as string[] | undefined)?.length) prev.images = [...((prev.images as string[] | undefined) || []), ...(m.images as string[])];
    }
    else out.push(m);
  }
  const tail = out.slice(-max);
  while (tail.length && tail[0].role !== "user") tail.shift();
  return tail as ModelMessage[];
}

/**
 * The stored rows as the panel shows them: user messages, and one assistant message per turn (the text of all its model
 * rounds, with the cards, button and suggested replies of the turn), carrying the turn id and any feedback.
 */
export function messagesForPanel(messages: Pick<StoredRow, "role" | "content" | "turn_id" | "feedback">[]): PanelMessage[] {
  const out: PanelMessage[] = [];
  let turn: Extract<PanelMessage, { role: "assistant" }> | null = null;
  let photoN = 0;
  for (const row of messages) {
    const m = (row.content || {}) as LooseMessage;
    if (row.role === "user") {
      const images = Array.isArray(m.images) ? imagePaths(m.images) : [];
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
      if (m.content) turn.content = turn.content ? `${turn.content}\n\n${m.content}` : String(m.content);
      const ui = m.ui || {};
      if (ui.cards?.length) turn.cards = [...(turn.cards || []), ...ui.cards].slice(0, 8);
      if (ui.nav) turn.nav = ui.nav;
      if (ui.replies?.length) turn.replies = ui.replies;
      if (ui.question) turn.question = ui.question;
      if (ui.review) turn.review = ui.review;
      if (ui.optional) turn.optional = ui.optional;
      if (row.feedback) turn.feedback = row.feedback;
    }
  }
  return out.filter((m) => m.role === "user" || m.role === "event" || (m.role === "assistant" && (m.content || m.cards?.length || m.question || m.review || m.optional)));
}

/**
 * The turns that have ended, as { turnId: null (answered) | "error message" }: a turn's answer is stored when it ends, even when the
 * panel lost the stream, so a panel that came back checks here for the turn it was waiting on.
 */
export function endedTurns(messages: Pick<StoredRow, "role" | "content" | "turn_id">[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const row of messages) {
    if (row.role !== "assistant" || !row.turn_id) continue;
    const err = (row.content as Partial<StoredAssistantMessage> | null)?.ui?.error;
    if (!(row.turn_id in out) || out[row.turn_id] !== null) out[row.turn_id] = typeof err === "string" && err ? err.slice(0, 300) : null;
  }
  return out;
}

/** A short title from the first message: its first line, cut at a word boundary. No model call, no spend. */
export function titleFrom(text: unknown): string {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line || "New chat";
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24)).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/**
 * Posts a message from the bot into a chat on the user's behalf (Save's summary): an assistant row with its panel extras (`ui`), as a turn of
 * its own. The model sees the text on later turns, not the extras. Only if the conversation is this user's; returns the turn id or null.
 */
export async function postAssistantMessage(conversationId: string, userId: string | undefined, content: string, ui?: MessageUi | null): Promise<string | null> {
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
export function withPhotoNotes(history: ModelMessage[], photos: PhotoNumber[], reads: Pick<PhotoReadRow, "path" | "status" | "result" | "group_id" | "tray_item_id">[] = []): ModelMessage[] {
  const nOf = new Map(photos.map((p) => [p.path, p.n]));
  const byPath = new Map(reads.map((r) => [r.path, r]));
  return history.map((m0) => {
    const m = { ...m0 };
    if (m.role !== "user") return m;
    const paths = m.images;
    delete m.images;
    if (!paths?.length) return m;
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
