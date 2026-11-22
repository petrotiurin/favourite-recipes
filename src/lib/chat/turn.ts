// A turn: the message goes to POST /chat and the answer streams in (src/lib/chat/stream.ts). An editor sends only the new message and the
// conversation id (the server owns the history); a visitor sends their own. An editor's turn isn't tied to the connection: when the stream
// drops (a phone switching apps), the panel waits for that turn on the server and shows it as stored (resumeTurn).
import type { ChatApp, EntryOf, Streaming } from "./app.ts";
import { MAX_SENT, cleanCards, cleanNav, cleanNumbers, cleanOptional, cleanQuestion, cleanReplyItems, cleanReview, wellFormed, type Message } from "./clean.ts";
import { paintShelf, schedulePhotoPoll } from "./photos.ts";
import { authedFetch, loadConversation } from "./session.ts";
import { readChatStream } from "./stream.ts";
import { loadTray, keyboardUnfold, renderTray, setAutoFold, watchPublishing } from "./tray.ts";

export interface SendOptions {
  /** A tray button or a review card's Done (answered by the server; no photos go with it). */
  action?: "finalise" | "review_drafts" | "review_optional";
  answers?: Record<string, string>;
}

class Named extends Error {
  kind?: "off" | "signin" | "account";
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

/** Sends a message (typed, a chip, a review card's Done, a tray button) and draws the answer as it streams in. */
export function send(app: ChatApp, rawText: unknown, opts?: SendOptions): void {
  const text = String(rawText || "").trim();
  const action = opts && opts.action;
  keyboardUnfold(app);
  const photos = app.mode === "editor" && app.chat.server && !action ? app.pending.slice() : [];
  if ((!text && !photos.length) || app.streaming || app.checkingMe) return;
  // photos still uploading: the message goes as soon as they are up (the input keeps it until then)
  const uploading = photos.filter((p) => p.state === "uploading");
  if (uploading.length) {
    if (app.sendQueued) return;
    app.sendQueued = true;
    app.photoNote = "Sending as soon as the photos are uploaded…";
    app.sendDisabled = true; // it's on its way: no second tap
    app.sendLabel = "Sending when the photos are uploaded";
    paintShelf(app);
    void Promise.all(uploading.map((p) => p.promise)).then(() => {
      app.sendQueued = false;
      app.sendDisabled = false;
      app.sendLabel = "Send";
      app.photoNote = "";
      if (app.pending.some((p) => p.state === "failed")) {
        app.photoNote = "A photo didn't upload: tap it to try again, or remove it.";
        paintShelf(app);
        return;
      }
      app.redraw();
      send(app, text, opts);
    });
    return;
  }
  if (photos.some((p) => p.state === "failed")) {
    app.photoNote = "A photo didn't upload: tap it to try again, or remove it.";
    paintShelf(app);
    return;
  }
  app.retireChips();
  for (const e of app.entries) if (e.kind === "feedback") e.old = true; // earlier turns keep their thumbs, dimmed
  const editorTurn = app.mode === "editor" && !!app.chat.server;
  app.clearStatus();
  app.entries = app.entries.filter((e) => e.kind !== "intro" && e.kind !== "error");

  const sent: Message = { role: "user", content: text };
  if (photos.length) sent.images = photos.map((p) => p.url);
  app.chat.messages.push(sent);
  const sentEntry = app.push(app.messageEntry(sent));
  if (app.photoLine && app.has(app.photoLine)) app.moveToEnd(app.photoLine); // the reading line stays last
  app.saveChat();
  if (photos.length) app.pending = [];
  paintShelf(app);
  app.autoFoldSuppressed = false;
  setAutoFold(app, true); // the reply is coming: give the conversation the room
  app.setInput("");
  app.saveUi();

  const reply: Message = { role: "assistant", content: "" };
  const botEntry = app.messageEntry(reply);
  let added = false;
  const controller = new AbortController();
  const mine: Streaming = { abort: () => controller.abort() };
  app.streaming = mine;
  app.setBusy(true);
  app.setStatus("Thinking…");

  const ensureAdded = () => {
    if (!added) {
      added = true;
      app.insertBeforeStatus(botEntry);
    }
  };
  const onText = (delta: string) => {
    ensureAdded();
    app.hideStatus();
    const stick = app.atBottom();
    reply.content += delta;
    app.redraw();
    if (stick) app.toBottom();
  };
  const finish = (ok: boolean) => {
    if (app.streaming !== mine) return; // "New chat" already replaced this conversation
    if (!app.leaving) {
      app.pendingTurn = null;
      app.saveUi();
    }
    app.streaming = null;
    app.setBusy(false);
    app.clearStatus();
    app.autoFold = false; // the turn is over: the tray opens again (loadTray below redraws it)
    if (editorTurn) void loadTray(app, { highlight: true });
    else if (app.trayData) renderTray(app);
    if (ok && (reply.content.trim() || (reply.cards && reply.cards.length) || reply.question || reply.review || reply.optional)) {
      app.chat.messages.push(reply);
      app.saveChat();
      if (reply.nav) {
        ensureAdded();
        botEntry.nav = true;
      }
      if (editorTurn && reply.turn_id) app.push({ key: app.key(), kind: "feedback", m: reply, old: false, convId: app.chat.id });
      if (reply.question) app.push({ key: app.key(), kind: "question", q: reply.question, old: false });
      else if (reply.review && editorTurn) app.push({ key: app.key(), kind: "review", review: reply.review, old: false });
      else if (reply.optional && editorTurn) app.push({ key: app.key(), kind: "optional", card: reply.optional, old: false });
      else if (reply.replies && reply.replies.length) app.push({ key: app.key(), kind: "chips", replies: reply.replies, old: false });
      watchPublishing(app);
      app.markUnread();
    } else if (added && app.has(botEntry)) {
      botEntry.partial = true; // a partial answer that errored out is not kept in the history
    }
    app.redraw();
    app.toBottom();
  };

  // Photos uploaded on pick go as their paths (in picked order); photos that couldn't use the upload route go as data, as before.
  const byPath = photos.length > 0 && photos.every((p) => !!p.path);
  const payload = editorTurn
    ? {
        conversation_id: app.chat.id || undefined,
        message: text,
        page: pageState(app),
        action: action || undefined,
        answers: (action === "review_drafts" || action === "review_optional") && opts!.answers ? opts!.answers : undefined,
        image_paths: byPath ? photos.map((p) => p.path) : undefined,
        images: photos.length && !byPath ? photos.map((p) => p.data) : undefined,
      }
    : { conversation_id: app.chat.id, messages: wellFormed(app.chat.messages.slice(-MAX_SENT)), page: pageState(app) };
  let busyTries = 0;
  const attempt = (): Promise<void> =>
    (editorTurn ? authedFetch(app, app.config.api, request()) : fetch(app.config.api, request())).then(onResponse);
  const request = (): RequestInit => ({ method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

  async function onResponse(res: Response): Promise<void> {
    if (editorTurn && res.status === 409) throw new Named("Busy"); // another turn of this chat is running (the photos' follow-up): wait, then send again
    if (editorTurn && res.status === 404) {
      app.chat.id = null; // that conversation is gone (expired or deleted): the next message starts a new one
      app.rememberEditorChat();
      throw new Error("That chat isn't available any more. Your next message starts a new one.");
    }
    if (!res.ok) {
      let j: { disabled?: boolean; signin?: boolean; error?: string } | null;
      try {
        j = await res.json();
      } catch {
        throw new Error("The chat isn't available right now.");
      }
      const kind = j && j.disabled === true ? "off" : j && j.signin === true ? (app.me.signedIn ? "account" : "signin") : null;
      if (kind) {
        const stop = new Named("Locked", "locked");
        stop.kind = kind;
        throw stop;
      }
      throw new Error((j && j.error) || "The chat isn't available right now.");
    }
    await readChatStream(res.body!, (ev) => {
      const data = ev.data as Record<string, unknown>;
      switch (ev.name) {
        case "text":
          onText(String(data.delta || ""));
          break;
        case "status":
          app.setStatus(String(data.text || ""));
          break;
        case "meta":
          if (typeof data.turn_id === "string") reply.turn_id = data.turn_id.slice(0, 64);
          if (app.chat.server && typeof data.conversation_id === "string") {
            app.chat.id = data.conversation_id;
            app.rememberEditorChat();
            if (reply.turn_id) app.pendingTurn = { conv: app.chat.id, turn: reply.turn_id, t: Date.now() };
            app.saveUi();
          }
          break;
        case "photos": {
          const nums = cleanNumbers(data.numbers, (sent.images || []).length);
          if (nums.length) {
            sent.numbers = nums;
            sentEntry.numbers = nums.slice();
            app.redraw();
            app.saveChat();
          }
          break;
        }
        case "title":
          if (app.chat.server && data.conversation_id === app.chat.id && typeof data.title === "string") {
            app.chat.title = data.title.slice(0, 80);
            app.paintHeader();
          }
          break;
        case "suggestions":
          reply.replies = cleanReplyItems(data.replies, app.origin);
          break;
        case "question":
          reply.question = cleanQuestion(data) || reply.question;
          break;
        case "review":
          reply.review = cleanReview(data, app.origin) || reply.review;
          break;
        case "optional":
          reply.optional = cleanOptional(data, app.origin, app.config.photoBase) || reply.optional;
          break;
        case "tray":
          break; // the tray is loaded once, when the turn ends (finish)
        case "cards": {
          const more = cleanCards(data.cards, app.origin);
          if (more.length) {
            ensureAdded();
            reply.cards = (reply.cards || []).concat(more).slice(0, 8);
            app.setCards(botEntry, reply.cards);
            app.hideStatus();
            app.toBottom();
          }
          break;
        }
        case "navigation":
          reply.nav = cleanNav(data, app.origin) || reply.nav;
          break;
      }
    });
  }
  const onDone = () => {
    finish(true);
    if (editorTurn) schedulePhotoPoll(app, app.photoState, true); // photos may be on their way now (and the reply's time marks it seen)
  };
  const onFail = (err: Named | Error | undefined) => {
    if (err && err.name === "Busy" && app.streaming === mine && busyTries++ < 75) {
      app.setStatus("Sending when I'm done…");
      setTimeout(() => {
        if (app.streaming === mine) attempt().then(onDone, onFail);
      }, 4000);
      return;
    }
    if (err && err.name === "AuthExpired") {
      // The sign-in sheet is open: put the message back so it isn't lost, and keep the panel open through a page-reloading sign-in.
      app.setInput(text);
      app.pending = photos;
      paintShelf(app);
      app.saveUi();
    }
    if (err && err.name === "Locked") {
      if (app.streaming === mine) app.streaming = null;
      app.setBusy(false);
      app.lock((err as Named).kind!);
      return;
    }
    const stillMine = app.streaming === mine;
    // A dropped connection is a bare TypeError from the browser ("network error", "Load failed", "Failed to fetch"), e.g. a phone that
    // switched to another app or tab. An editor's turn carries on on the server and is stored: wait for it instead of failing.
    const cut = !!err && (err.name === "TypeError" || err.name === "Dropped");
    if (stillMine && cut && editorTurn && app.chat.server && app.chat.id && reply.turn_id) {
      resumeTurn(app, mine, app.chat.id, reply.turn_id, botEntry);
      return;
    }
    finish(false);
    if (!stillMine || (err && err.name === "AbortError")) return;
    if (cut) app.showError("The connection to the chat dropped before the answer finished. Try again in a moment.");
    else app.showError(err && err.name === "Busy" ? "I'm still busy with the last answer. Try again in a moment." : err && err.message ? err.message : "Something went wrong with the chat.");
    app.markUnread();
  };
  attempt().then(onDone, onFail);
}

export const RESUME_EVERY_MS = 4000;
export const RESUME_MAX_MS = 6 * 60 * 1000; // past any turn's lifetime on the server (Vercel stops a function at 5 minutes)

/**
 * The stream of an editor's turn dropped (the phone switched apps, the tab was put away): the turn carries on on the server and its
 * answer is stored, so the panel stays busy and checks the conversation until that turn has ended, then shows it as stored.
 */
export function resumeTurn(app: ChatApp, mine: Streaming, convId: string, turnId: string, partial: EntryOf<"message"> | null, startedAt?: number, now?: boolean): void {
  const started = startedAt || Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const onVisible = () => {
    if (app.doc.visibilityState === "visible") check();
  };
  mine.abort = () => {
    stopped = true;
    clearTimeout(timer);
    app.doc.removeEventListener("visibilitychange", onVisible);
  };
  app.setStatus("Still working on it… The answer will show here when it's ready.");
  function end(errorText: string): void {
    mine.abort();
    if (app.streaming !== mine) return;
    app.pendingTurn = null;
    app.saveUi();
    app.streaming = null;
    app.setBusy(false);
    app.clearStatus();
    if (partial) app.remove(partial); // the stored answer replaces what had streamed so far
    void loadTray(app, { highlight: true });
    void loadConversation(app, convId).then(() => {
      if (errorText) app.showError(errorText);
      app.markUnread();
      watchPublishing(app);
    });
  }
  function later(): void {
    clearTimeout(timer);
    timer = setTimeout(check, RESUME_EVERY_MS);
  }
  function check(): void {
    if (stopped || app.streaming !== mine) return;
    if (Date.now() - started > RESUME_MAX_MS) return end("That answer didn't come through. Anything already in the tray is still there: try again in a moment.");
    if (app.doc.visibilityState === "hidden") return later(); // checked again as soon as the page is back
    authedFetch(app, `${app.apiBase}/conversations/${encodeURIComponent(convId)}`)
      .then((res) => {
        if (res.status === 404) return { gone: true };
        return res.ok ? res.json() : null;
      })
      .then(
        (j: { gone?: boolean; ended_turns?: Record<string, unknown> } | null) => {
          if (stopped || app.streaming !== mine) return;
          if (j && j.gone) return end("That chat isn't available any more.");
          const ended = j && j.ended_turns && typeof j.ended_turns === "object" ? j.ended_turns : {};
          if (Object.prototype.hasOwnProperty.call(ended, turnId)) return end(ended[turnId] ? String(ended[turnId]).slice(0, 300) : "");
          later();
        },
        (err: Error) => {
          if (stopped || app.streaming !== mine) return;
          if (err && err.name === "AuthExpired") return end(""); // the sign-in sheet is open; the answer is in the chat after it
          later(); // still offline: try again
        },
      );
  }
  app.doc.addEventListener("visibilitychange", onVisible);
  if (now) check();
  else later();
}

/** A page left while an editor's turn was still answering (the panel closed, a tapped link): wait for that turn here. */
export function resumePending(app: ChatApp): void {
  const p = app.pendingTurn;
  if (!p || app.streaming || app.mode !== "editor" || app.chat.id !== p.conv) return;
  if (!(Date.now() - p.t < RESUME_MAX_MS)) {
    app.pendingTurn = null;
    app.saveUi();
    return;
  }
  const mine: Streaming = { abort() {} };
  app.streaming = mine;
  app.setBusy(true);
  resumeTurn(app, mine, p.conv, p.turn, null, p.t, true);
}

/** The page context baked in at build time plus the live UI state that matters. Untrusted: the server re-resolves it. */
export function pageState(app: ChatApp): Record<string, unknown> {
  const { ctx, doc } = app;
  if (app.contextDismissed) return { page: ctx.page, dismissed: true };
  const state: Record<string, unknown> = { page: ctx.page };
  if (ctx.page === "recipe") {
    state.slug = ctx.slug;
    const pressed = doc.querySelector('.servings-picker [aria-pressed="true"]');
    const n = pressed ? parseInt(pressed.getAttribute("data-serves") as string, 10) : NaN;
    if (n > 0) state.servings = n;
  } else if (ctx.page === "index") {
    const search = doc.getElementById("recipe-search") as HTMLInputElement | null;
    if (search && search.value.trim()) state.search = search.value.trim();
    const checked = doc.querySelector<HTMLInputElement>(".filter-input:checked");
    const label = checked && doc.querySelector(`label[for="${checked.id}"]`);
    if (label && label.textContent!.trim() !== "All") state.filter = label.textContent!.trim();
  }
  return state;
}
