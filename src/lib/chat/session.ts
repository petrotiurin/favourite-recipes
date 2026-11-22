// Who is chatting (docs/chatbot-design.md 4, 5): requests with the signed-in user's token through the sign-in store (src/lib/auth.ts), the server's
// answer to "who am I" (GET /chat/me decides the role from the token), the editor's server-owned chats, the chats list and the thumbs up / down.
import type { AuthInfo, Session } from "../auth.ts";
import type { ChatApp, Locked } from "./app.ts";
import { cleanPhotos, cleanServerMessages, type Feedback, type Message } from "./clean.ts";
import { clearTray, loadTray } from "./tray.ts";
import { paintShelf, schedulePhotoPoll } from "./photos.ts";
import { EDITOR_KEY, PENDING_KEY, SIGNIN_PENDING_MS, loadUi, readJson, writeJson } from "./storage.ts";
import { resumePending } from "./turn.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sheet's words when it is opened from the chat's header, and from the locked panel ("editors only"). */
export const SIGNIN_COPY = { title: "Sign in to the chat", lede: "Family editors can sign in to keep their chats, on any of their devices." };
export const LOCKED_SIGNIN_COPY = { title: "Sign in to the chat", lede: "Family editors can sign in to ask about the recipes." };

function authError(): Error {
  const e = new Error("Your sign-in has expired. Sign in again.");
  e.name = "AuthExpired";
  return e;
}

/**
 * fetch with the signed-in user's token (refreshed when it is about to expire). A 401 refreshes once and retries; if that fails too the
 * session is over: the sign-in sheet opens and the promise rejects with an "AuthExpired" error. Without a session it is a plain fetch.
 */
export function authedFetch(app: ChatApp, url: string, opts: RequestInit = {}): Promise<Response> {
  const { auth } = app;
  if (!app.canSignIn || !auth.getSession()) return fetch(url, opts);
  const withToken = (token: string) => fetch(url, { ...opts, headers: { ...(opts.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  const expired = (): never => {
    app.markSigninPending();
    auth.sessionExpired("Your sign-in has expired. Sign in again to keep chatting.");
    throw authError();
  };
  return auth.getAccessToken().then((token) => {
    if (!token) return expired();
    return withToken(token).then((res) => {
      if (res.status !== 401) return res;
      return auth.refresh().then((fresh) => {
        if (!fresh) return expired();
        return withToken(fresh).then((again) => (again.status === 401 ? expired() : again));
      });
    });
  });
}

/** The Sign in button in the header (and on the locked panel) opens the sheet with the chat's own wording, and remembers the open panel and draft. */
export function signInFromChat(app: ChatApp, copy = SIGNIN_COPY): void {
  app.markSigninPending();
  app.auth.openSignIn(copy);
}

/** After a sign-in: a sheet opened from the chat less than 30 minutes ago reopens the panel with the draft (a magic link reloads the page). */
export function handlePending(app: ChatApp): void {
  const p = readJson(app.local, PENDING_KEY) as { t?: unknown; open?: boolean; draft?: unknown } | null;
  writeJson(app.local, PENDING_KEY, null);
  if (!p || !(Date.now() - Number(p.t) < SIGNIN_PENDING_MS)) return;
  if (p.open && app.panelHidden) app.open({ restore: true });
  if (typeof p.draft === "string" && p.draft && !(app.els.input?.value ?? "")) app.setInput(p.draft.slice(0, 2000));
}

/** The store's sign-in / sign-out: the server decides again who this is. */
export function onAuthChange(app: ChatApp, _session: Session | null, info: AuthInfo): void {
  app.paintBubble();
  if (info.type === "sign-in") {
    if (app.locked === "signin" || app.locked === "account") app.locked = null; // the server decides again for the new account
    handlePending(app);
    void refreshMe(app);
  } else if (info.type === "sign-out") {
    const keepEmail = info.reason === "expired" ? app.me.email : "";
    app.me = { signedIn: false, email: "" };
    app.checkingMe = false;
    goPublic(app, { keepEmail });
  }
}

/** Back to the visitor's chat (signed out, expired, or a signed-in account that can't edit). The editor's chat leaves the panel. */
export function goPublic(app: ChatApp, opts?: { keepEmail?: string }): void {
  const keepId = app.chat.server && app.chat.id && opts && opts.keepEmail ? { email: opts.keepEmail, id: app.chat.id } : null;
  if (app.streaming && app.chat.server) app.streaming.abort();
  if (app.chat.server) {
    app.streaming = null;
    app.setBusy(false);
  }
  app.mode = "public";
  app.pending = [];
  app.creating = null;
  paintShelf(app);
  schedulePhotoPoll(app, null);
  clearTray(app);
  app.chat = app.anonChat;
  // An expired session keeps the open conversation's id, so signing in again comes back to it; only an explicit sign-out forgets it.
  writeJson(app.local, EDITOR_KEY, keepId);
  setListing(app, false);
  app.paintHeader();
  app.renderAll();
}

export function enterEditor(app: ChatApp): void {
  if (app.mode === "editor" && app.chat.server) {
    app.paintHeader();
    return;
  }
  if (app.streaming) app.streaming.abort();
  app.streaming = null;
  app.setBusy(false);
  app.mode = "editor";
  // A new visit starts a new chat (the last one stays in the Chats list) unless a reply in it hasn't been seen yet; later sign-ins
  // on this page (an expired session signed in again) come back to the stored one as before.
  const stored = app.newVisit ? null : (readJson(app.local, EDITOR_KEY) as { email?: string; id?: string } | null);
  const uiId = loadUi(app.session).id;
  const wantId =
    (UUID.test(uiId || "") && uiId) ||
    (UUID.test(app.visitResumeId || "") && app.visitResumeId) ||
    (stored && stored.email === app.me.email && UUID.test(stored.id || "") && stored.id) ||
    null;
  if (app.newVisit) {
    app.newVisit = false;
    app.visitResumeId = null;
    if (!wantId) writeJson(app.local, EDITOR_KEY, null);
  }
  app.chat = { server: true, id: null, title: "", messages: [] };
  app.paintHeader();
  app.renderAll();
  void loadTray(app);
  if (wantId) void loadConversation(app, wantId).then(() => resumePending(app));
}

export function loadConversation(app: ChatApp, id: string): Promise<void> {
  const seq = ++app.loadSeq;
  app.push({ key: app.key(), kind: "wait", text: "Opening your chat…" });
  return authedFetch(app, `${app.apiBase}/conversations/${encodeURIComponent(id)}`)
    .then((res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("load");
      return res.json();
    })
    .then(
      (j: { id: string; title?: unknown; messages?: unknown; photos?: unknown; last_reply_at?: unknown } | null) => {
        if (seq !== app.loadSeq || app.mode !== "editor") return;
        if (!j) app.chat = { server: true, id: null, title: "", messages: [] }; // expired or deleted: start fresh
        else app.chat = { server: true, id: j.id, title: String(j.title || "").slice(0, 80), messages: cleanServerMessages(j.messages, app.origin, app.config.photoBase) };
        app.rememberEditorChat();
        setListing(app, false);
        app.paintHeader();
        app.photoState = j ? cleanPhotos(j.photos) : null;
        app.renderAll();
        app.saveUi();
        if (j && !app.panelHidden) app.markSeen(j.last_reply_at);
        schedulePhotoPoll(app, app.photoState);
      },
      (err: Error) => {
        if (seq !== app.loadSeq || (err && err.name === "AuthExpired")) return;
        app.renderAll();
        app.showError("Couldn't open that chat. Try again in a moment.");
      },
    );
}

/** Asks the server who we are (it decides the role from the token) and shows the matching chat. */
export function refreshMe(app: ChatApp): Promise<void> {
  if (!app.canSignIn || !app.auth.getSession()) {
    app.me = { signedIn: false, email: "" };
    app.checkingMe = false;
    goPublic(app);
    return Promise.resolve();
  }
  app.checkingMe = true;
  app.renderAll();
  return authedFetch(app, `${app.apiBase}/me`)
    .then(async (res) => {
      if (!res.ok) {
        let j: { disabled?: boolean } | null;
        try {
          j = await res.json();
        } catch {
          throw new Error("me");
        }
        if (j && j.disabled === true) {
          const stop = new Error("locked");
          stop.name = "Locked";
          throw stop;
        }
        throw new Error("me");
      }
      return res.json();
    })
    .then(
      (j: { signedIn?: boolean; email?: unknown; role?: string; public_enabled?: boolean; last_reply?: { at?: unknown; conversation_id?: unknown } }) => {
        app.me = { signedIn: !!j.signedIn, email: String(j.email || "") };
        app.checkingMe = false;
        // a reply that came while this browser wasn't looking (a follow-up after the photos were read): the bubble's dot
        const last = j.last_reply && typeof j.last_reply.at === "string" ? j.last_reply.at : "";
        if (last && j.role === "editor") {
          if (!app.seenAt()) app.markSeen(last); // first time on this browser: nothing is "new"
          else if (last > app.seenAt() && app.panelHidden) {
            // a new visit opens the chat with the unseen reply (a follow-up after the photos were read), not a blank one
            if (app.newVisit && typeof j.last_reply!.conversation_id === "string") app.visitResumeId = j.last_reply!.conversation_id;
            app.unread = true;
            app.paintNotice();
            app.saveUi();
          }
          app.lastReplyAt = last;
        }
        if (j.role === "editor") {
          app.locked = app.locked === "off" ? null : app.locked;
          enterEditor(app);
        } else if (j.public_enabled === false) {
          app.lock(j.signedIn ? "account" : "signin"); // editors only: this account (or no account) can't use it
        } else goPublic(app);
      },
      (err: Error) => {
        app.checkingMe = false;
        if (err && err.name === "Locked") return app.lock("off");
        if (err && err.name === "AuthExpired") return; // the sign-out event has taken the panel back to the visitor chat
        app.me = { signedIn: false, email: "" };
        goPublic(app); // couldn't reach the server: stay a visitor
      },
    );
}

// --- the chats list ---
export function setListing(app: ChatApp, on: boolean): void {
  app.listing = !!on;
  app.redraw();
  if (app.listing) loadList(app);
}
function loadList(app: ChatApp): void {
  app.list = { state: "loading", convs: [], now: 0, current: null, gen: app.list.gen + 1 };
  app.redraw();
  authedFetch(app, `${app.apiBase}/conversations`)
    .then((res) => {
      if (!res.ok) throw new Error("list");
      return res.json();
    })
    .then(
      (j: { conversations?: unknown }) => {
        if (!app.listing) return;
        const convs = (Array.isArray(j.conversations) ? j.conversations : []).filter((c: unknown) => !!c && typeof (c as { id?: unknown }).id === "string");
        app.list = { state: "ready", convs, now: Date.now(), current: app.chat.server ? app.chat.id : null, gen: app.list.gen + 1 };
        app.redraw();
      },
      (err: Error) => {
        if (!app.listing || (err && err.name === "AuthExpired")) return;
        app.list = { ...app.list, state: "failed" };
        app.redraw();
      },
    );
}
export function toggleListing(app: ChatApp): void {
  setListing(app, !app.listing);
}
/** A chat picked from the list. */
export function openChat(app: ChatApp, c: { id: string; title?: unknown }): void {
  if (app.streaming) app.streaming.abort();
  app.streaming = null;
  app.setBusy(false);
  app.chat = { server: true, id: c.id, title: String(c.title || ""), messages: [] };
  setListing(app, false);
  app.paintHeader();
  app.renderAll();
  void loadConversation(app, c.id);
}
/** Deletes a chat from the list: true when it is gone (or was already). */
export function deleteChat(app: ChatApp, id: string): Promise<boolean> {
  return authedFetch(app, `${app.apiBase}/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
    (res) => {
      if (!res.ok && res.status !== 404) return false;
      app.list = { ...app.list, convs: app.list.convs.filter((c) => c.id !== id) };
      if (app.chat.server && app.chat.id === id) {
        app.chat = { server: true, id: null, title: "", messages: [] };
        app.rememberEditorChat();
        app.paintHeader();
        app.renderAll();
      }
      app.redraw();
      return true;
    },
    (err: Error) => {
      if (err && err.name === "AuthExpired") throw err;
      return false;
    },
  );
}

// --- thumbs up / down under a turn's last message (editors only) ---
/** Sends (or, with null, clears) the score of a turn; false when the server didn't take it. */
export function postFeedback(app: ChatApp, convId: string | null, m: Message, value: 0 | 1 | null, fb: Feedback | null): Promise<boolean> {
  const body: Record<string, unknown> = { conversation_id: convId, turn_id: m.turn_id, value };
  if (value === 0 && fb) {
    body.reasons = fb.reasons;
    body.note = fb.note;
  }
  return authedFetch(app, `${app.apiBase}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(
    (res) => res.ok,
    () => false,
  );
}

export type { Locked };
