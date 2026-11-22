// What the chat keeps in the browser. The keys are the ones the chat has always used, so a chat (or a tray fold, an unsent draft) in progress
// when the site is deployed carries on after it. Storage can throw (private mode, blocked): everything still works without it.
//
// localStorage (this browser):
//   recipes-chat          the visitor's chat { id, updated, messages } (the last 40 messages, two weeks)
//   recipes-chat-editor   { email, id }: an editor's open conversation (an id only; the messages live on the server)
//   recipes-chat-signin   { t, open, draft }: the sign-in sheet was opened from the chat (a magic link back reopens the panel with the draft)
//   recipes-chat-seen     { email, at }: the newest reply this browser has seen (a newer one on the server is the bubble's dot)
// sessionStorage (this tab, across page loads):
//   recipes-chat-visit    "1": this tab's visit has started (without it, a new visit starts a new chat)
//   recipes-chat-ui       { open, id, draft, unread, pending }: the panel as it was, for the next page
//   recipes-chat-off      "1": the server said the chat is switched off (no bubble on later pages)
//   recipes-chat-tray-fold { folded, changed }: the tray folded by hand
import { MAX_STORED, cleanHistory, type Message } from "./clean.ts";

export const STORE_KEY = "recipes-chat";
export const EDITOR_KEY = "recipes-chat-editor";
export const PENDING_KEY = "recipes-chat-signin";
export const SEEN_KEY = "recipes-chat-seen";
export const VISIT_KEY = "recipes-chat-visit";
export const UI_KEY = "recipes-chat-ui";
export const OFF_KEY = "recipes-chat-off";
export const TRAY_FOLD_KEY = "recipes-chat-tray-fold";

/** A sign-in from the chat less than this long ago continues the visit it was sent from (and reopens the panel). */
export const SIGNIN_PENDING_MS = 30 * 60 * 1000;

export function readJson(storage: Storage, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) as string);
  } catch {
    return null;
  }
}
export function writeJson(storage: Storage, key: string, value: unknown): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered, the chat still works
  }
}

export function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The visitor's chat kept in this browser, or a fresh one. */
export function loadChat(storage: Storage, origin: string, now = Date.now()): { id: string; messages: Message[] } {
  try {
    const h = cleanHistory(JSON.parse(storage.getItem(STORE_KEY) as string), now, origin);
    if (h) return { id: h.id || newId(), messages: h.messages };
  } catch {
    // no storage, or it holds something else: start fresh
  }
  return { id: newId(), messages: [] };
}
export function saveChat(storage: Storage, chat: { id: string | null; messages: Message[] }, now = Date.now()): void {
  try {
    storage.setItem(STORE_KEY, JSON.stringify({ id: chat.id, updated: now, messages: chat.messages.slice(-MAX_STORED) }));
  } catch {
    // private mode or full: the chat still works, it just isn't remembered
  }
}

/**
 * Whether this page load starts a new visit, and marks the visit as started. A new visit (a new tab, or the site opened again later) starts a
 * new conversation; the tray stays (it is the household's, on the server), and an editor's earlier chats stay in the Chats list. Pages loaded
 * in the same tab are the same visit. A magic link that just signed in from the chat (PENDING_KEY, fresh) continues the visit it was sent from.
 * If sessionStorage can't be used, nothing counts as a new visit (the conversation is kept).
 */
export function startVisit(session: Storage, local: Storage, now = Date.now()): boolean {
  try {
    if (session.getItem(VISIT_KEY) === "1") return false;
    session.setItem(VISIT_KEY, "1");
    if (session.getItem(VISIT_KEY) !== "1") return false;
  } catch {
    return false;
  }
  const signin = readJson(local, PENDING_KEY) as { t?: unknown } | null;
  return !(signin && now - Number(signin.t) < SIGNIN_PENDING_MS);
}

/** An editor's turn still running on the server, carried to the next page of the tab. */
export interface PendingTurn {
  conv: string;
  turn: string;
  t: number;
}
export interface UiState {
  open?: boolean;
  id?: string | null;
  draft?: string;
  unread?: boolean;
  pending?: PendingTurn | null;
}
export function loadUi(session: Storage): UiState {
  try {
    const v = JSON.parse(session.getItem(UI_KEY) as string);
    return v && typeof v === "object" ? (v as UiState) : {};
  } catch {
    return {};
  }
}
export function saveUi(session: Storage, ui: Required<UiState>): void {
  try {
    session.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    // not remembered, the chat still works
  }
}
export function cleanPending(p: unknown): PendingTurn | null {
  const v = p as Partial<PendingTurn> | null;
  return v && typeof v.conv === "string" && typeof v.turn === "string" && Number(v.t) > 0 ? { conv: v.conv.slice(0, 64), turn: v.turn.slice(0, 64), t: Number(v.t) } : null;
}

export function loadTrayFold(session: Storage): { folded: boolean; changed: boolean } {
  try {
    const v = JSON.parse(session.getItem(TRAY_FOLD_KEY) as string);
    return v && v.folded === true ? { folded: true, changed: v.changed === true } : { folded: false, changed: false };
  } catch {
    return { folded: false, changed: false };
  }
}
export function saveTrayFold(session: Storage, folded: boolean, changed: boolean): void {
  try {
    if (folded) session.setItem(TRAY_FOLD_KEY, JSON.stringify({ folded: true, changed }));
    else session.removeItem(TRAY_FOLD_KEY);
  } catch {
    // not remembered: it opens again on the next page
  }
}

export function switchedOff(session: Storage): boolean {
  try {
    return session.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberOff(session: Storage): void {
  try {
    session.setItem(OFF_KEY, "1");
  } catch {
    // not remembered
  }
}

/** `window.localStorage` / `sessionStorage`, or (where reading the property itself throws) a stand-in whose every call throws, like a blocked one. */
export function storageOf(win: Window, which: "localStorage" | "sessionStorage"): Storage {
  try {
    return win[which];
  } catch {
    const blocked = () => {
      throw new Error("storage blocked");
    };
    return { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked, key: blocked, length: 0 } as Storage;
  }
}
