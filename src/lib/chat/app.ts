// The chat's state and its conversation log (docs/chatbot-design.md 9). One `ChatApp` per page, made by the island (src/islands/chat/Chat.tsx) once
// it is in the browser. The logic is split by seam, each a module of functions over the app: the answer to a message (turn.ts), sign-in, the
// editor's chats and the chats list (session.ts), the plan tray (tray.ts), photos (photos.ts), and the page around the panel (start.ts).
//
// How it draws: the components draw only what the app holds. Everything they show is set here at the moments the chat decides it changes (the
// "paint" steps), as plain fields; `redraw()` asks Preact to draw again and `after(fn)` runs fn once the new DOM is in place (scrolling, focus).
// The conversation log is a list of entries in the order they were added (`entries`), so an answer streaming in, a status line, a question
// and the chips sit exactly where they were put; `renderAll()` rebuilds it from the conversation, as a page load does.
import { signal } from "@preact/signals";
import type { Auth } from "../auth.ts";
import type { Message, OptionalCard, PhotoState, Question, Reply, Review } from "./clean.ts";
import { contextLabel, startersFor } from "./labels.ts";
import type { PendingPhoto } from "./photo-files.ts";
import {
  EDITOR_KEY, PENDING_KEY, SEEN_KEY, STORE_KEY, cleanPending, loadChat, loadTrayFold, loadUi, newId, readJson, rememberOff, saveChat as storeChat, saveUi as storeUi,
  startVisit, storageOf, switchedOff, writeJson, type PendingTurn,
} from "./storage.ts";
import type { Reading, Tray, TrayButton, TrayItem } from "./tray-data.ts";
import { closeViewer, paintPhotoLine, paintShelf, schedulePhotoPoll } from "./photos.ts";
import { setListing } from "./session.ts";
import { layoutPanel } from "./start.ts";
import { loadTray, watchPublishing } from "./tray.ts";

export interface ChatConfig {
  /** The backend's /chat address (the build's CHAT_API_URL). */
  api: string;
  /** CHAT_PUBLIC=false: the bubble only for a signed-in visitor (the server enforces it). */
  publicOff: boolean;
  /** The Supabase project's address (the build's SUPABASE_URL): signed photo links are accepted only from it. "" without sign-in. */
  photoBase: string;
}

/** A visitor's chat (kept in this browser), or an editor's (`server`: the messages live on the server, `id` is its id once it has one). */
export interface Chat {
  server?: boolean;
  id: string | null;
  title?: string;
  messages: Message[];
}
export type Locked = null | "off" | "signin" | "account";

/** One thing in the conversation log, in the order it was added. `key` changes when the log is drawn again, as a page load would. */
export type Entry = { key: number } & (
  | { kind: "locked"; locked: Exclude<Locked, null>; email: string; canSignIn: boolean }
  | { kind: "wait"; text: string }
  | { kind: "intro"; starters: string[]; old: boolean }
  | { kind: "message"; m: Message; nav: boolean; navOld: boolean; partial: boolean; cards: Message["cards"]; numbers: number[] | undefined }
  | { kind: "feedback"; m: Message; old: boolean; convId: string | null }
  | { kind: "question"; q: Question; old: boolean }
  | { kind: "review"; review: Review; old: boolean }
  | { kind: "optional"; card: OptionalCard; old: boolean }
  | { kind: "chips"; replies: Reply[]; old: boolean }
  | { kind: "status"; text: string; hidden: boolean; reading?: boolean }
  | { kind: "error"; text: string }
);
export type EntryOf<K extends Entry["kind"]> = Extract<Entry, { kind: K }>;

/** What the tray strip shows, worked out when the tray is drawn (tray.ts renderTray). */
export interface TrayView {
  hidden: boolean;
  /** Nothing staged yet, only photos being read: the strip is just those lines. */
  readingOnly: boolean;
  reading: Reading[];
  folded: boolean;
  label: string;
  changedDot: boolean;
  balance: string;
  notice: string;
  button: TrayButton;
  items: { item: TrayItem; isNew: boolean }[];
  detail: TrayItem | null;
  msg: string;
  blocked: string;
  waitNote: string;
  goDisabled: boolean;
  /** Bumped by each draw, so the cards' own state (a failed thumbnail) starts again with it. */
  gen: number;
}

export interface ShelfView {
  hidden: boolean;
  items: { p: PendingPhoto; n: number }[];
  note: string;
}

export interface ListView {
  state: "idle" | "loading" | "failed" | "ready";
  convs: { id: string; title?: string; updated_at: string; expires_at: string }[];
  now: number;
  /** The conversation open when the list was drawn (its row is marked). */
  current: string | null;
  gen: number;
}

export interface Viewer {
  src: string;
  alt: string;
  num: string;
  /** The thumbnail it opened from (its key) and its place among the chat's photos, to give focus back. */
  shotKey: string;
  index: number;
  chatId: string | null;
}

export interface Streaming {
  abort(): void;
}

export interface Deps {
  auth: Auth;
  win?: Window;
}

export class ChatApp {
  readonly config: ChatConfig;
  readonly auth: Auth;
  readonly win: Window;
  readonly doc: Document;
  readonly origin: string;
  readonly local: Storage;
  readonly session: Storage;
  /** The page context the build wrote (`#page-context`): which page this is. */
  readonly ctx: { page?: string; slug?: string; title?: string };

  /** Bumped by `redraw()`: the island draws again. */
  readonly rev = signal(0);
  private afterQueue: (() => void)[] = [];
  private keySeq = 0;
  els: { panel?: HTMLElement | null; bubble?: HTMLElement | null; log?: HTMLElement | null; input?: HTMLTextAreaElement | null; picker?: HTMLInputElement | null; tray?: HTMLElement | null } = {};

  // --- the conversation ---
  switchedOffEarlier: boolean;
  newVisit: boolean;
  anonChat: Chat;
  chat: Chat;
  mode: "public" | "editor" = "public";
  me = { signedIn: false, email: "" };
  checkingMe: boolean;
  locked: Locked;
  listing = false;
  contextDismissed = false;
  streaming: Streaming | null = null;
  unread: boolean;
  pendingTurn: PendingTurn | null;
  leaving = false;
  visitResumeId: string | null = null;
  loadSeq = 0;
  lastReplyAt = "";

  // --- photos being read, and photos to send (photos.ts) ---
  photoState: PhotoState | null = null;
  photoTimer: ReturnType<typeof setTimeout> | undefined;
  photoChangedAt = 0;
  pending: PendingPhoto[] = [];
  photoNote = "";
  sendQueued = false;
  creating: Promise<string | null> | null = null;
  viewer: Viewer | null = null;

  // --- the tray (tray.ts) ---
  trayData: Tray | null = null;
  trayMsg = "";
  revealDetail = false;
  trayDetail: string | null = null;
  traySeen: Record<string, boolean> | null = null;
  trayManualFold: boolean;
  trayChanged: boolean;
  keyboardOpen = false;
  keyboardForcedOpen = false;
  trayTimer: ReturnType<typeof setTimeout> | undefined;
  trayReading: Reading[] = [];
  traySeq = 0;
  trayBusy = false;
  autoFold = false;
  autoFoldSuppressed = false;
  trayLoading: Promise<void> | null = null;
  trayHighlight = false;
  /** Buttons on the tray's cards pressed since it was last drawn ("drop:<id>", "photo:<id>"): disabled until the next draw. */
  trayPressed = new Set<string>();
  publishTimer: ReturnType<typeof setTimeout> | undefined;
  publishTries = 0;
  lastLogTop = 0;
  foldLockUntil = 0;

  // --- what the panel shows (set by the paint steps) ---
  entries: Entry[] = [];
  /** The one status line of a turn ("Thinking…"), when there is one. */
  statusEntry: EntryOf<"status"> | null = null;
  photoLine: EntryOf<"status"> | null = null;
  panelHidden = true;
  /** The panel's locked look (no input), set when the log is drawn. */
  panelLocked = false;
  busy = false;
  inputBusy: "true" | "false" | null = null;
  sendDisabled = false;
  sendLabel = "Send";
  attachHidden = true;
  attachDisabled = false;
  head = { title: "Recipe chat", chatsHidden: true, banner: "" };
  bubble = { hidden: false, working: false, dot: false, label: "Chat about recipes" };
  context = { hidden: true, label: "" };
  shelf: ShelfView = { hidden: true, items: [], note: "" };
  tray: TrayView | null = null;
  trayGen = 0;
  list: ListView = { state: "idle", convs: [], now: 0, current: null, gen: 0 };

  constructor(config: ChatConfig, deps: Deps) {
    this.config = config;
    this.auth = deps.auth;
    this.win = deps.win ?? window;
    this.doc = this.win.document;
    this.origin = this.win.location.origin;
    this.local = storageOf(this.win, "localStorage");
    this.session = storageOf(this.win, "sessionStorage");
    this.ctx = (() => {
      try {
        return JSON.parse(this.doc.getElementById("page-context")!.textContent as string) || {};
      } catch {
        return {};
      }
    })();
    this.switchedOffEarlier = switchedOff(this.session);
    // A new visit (a new tab, or the site opened again later) starts a new conversation (storage.ts startVisit); the tray stays.
    this.newVisit = startVisit(this.session, this.local);
    if (this.newVisit) writeJson(this.local, STORE_KEY, null);
    this.anonChat = loadChat(this.local, this.origin); // the visitor's chat, kept in this browser (for this visit)
    this.chat = this.anonChat;
    this.checkingMe = !!(this.auth.enabled && this.auth.getSession()); // until /chat/me has answered we don't know which chat to show
    this.locked = this.switchedOffEarlier ? "off" : null;
    const ui = loadUi(this.session);
    this.unread = ui.unread === true;
    this.pendingTurn = cleanPending(ui.pending);
    const fold = loadTrayFold(this.session);
    this.trayManualFold = fold.folded;
    this.trayChanged = fold.changed;
  }

  get apiBase(): string {
    return this.config.api.replace(/\/+$/, "");
  }
  /** Sign-in is on this build (the Supabase values were set; src/lib/auth-boot.ts started the store). */
  get canSignIn(): boolean {
    return this.auth.enabled;
  }

  // --- drawing ---
  redraw(): void {
    this.rev.value++;
  }
  /** Runs fn once the next draw is in the page. */
  after(fn: () => void): void {
    this.afterQueue.push(fn);
    this.redraw();
  }
  /** Called by the island after each draw. */
  flushAfter(): void {
    const queue = this.afterQueue;
    this.afterQueue = [];
    for (const fn of queue) fn();
  }
  key(): number {
    return ++this.keySeq;
  }

  // --- the log ---
  push<E extends Entry>(e: E): E {
    this.entries.push(e);
    this.redraw();
    return e;
  }
  remove(e: Entry | null): void {
    if (!e) return;
    const i = this.entries.indexOf(e);
    if (i !== -1) this.entries.splice(i, 1);
    this.redraw();
  }
  has(e: Entry | null): boolean {
    return !!e && this.entries.indexOf(e) !== -1;
  }
  /** Puts e just before the status line (at the end when there is none), or moves it there. */
  insertBeforeStatus(e: Entry): void {
    const at = this.entries.indexOf(e);
    if (at !== -1) this.entries.splice(at, 1);
    const s = this.statusEntry ? this.entries.indexOf(this.statusEntry) : -1;
    if (s === -1) this.entries.push(e);
    else this.entries.splice(s, 0, e);
    this.redraw();
  }
  /** Moves e to the end of the log. */
  moveToEnd(e: Entry): void {
    const at = this.entries.indexOf(e);
    if (at !== -1) this.entries.splice(at, 1);
    this.entries.push(e);
    this.redraw();
  }
  messageEntry(m: Message, live?: boolean): EntryOf<"message"> {
    return { key: this.key(), kind: "message", m, nav: !!(live && m.role !== "user" && m.nav), navOld: false, partial: false, cards: m.role === "user" ? undefined : cloneCards(m.cards), numbers: m.role === "user" && m.numbers ? m.numbers.slice() : undefined };
  }
  /** The cards on a message changed (an answer still streaming in). */
  setCards(e: EntryOf<"message">, cards: Message["cards"]): void {
    e.cards = cloneCards(cards);
    this.redraw();
  }

  atBottom(): boolean {
    const log = this.els.log;
    return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }
  toBottom(): void {
    this.after(() => {
      const log = this.els.log;
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  intro(): EntryOf<"intro"> {
    const page = this.ctx.page === "recipe" && this.contextDismissed ? "" : this.ctx.page;
    return { key: this.key(), kind: "intro", starters: startersFor(page, this.mode === "editor"), old: false };
  }

  /** Draws the whole log again from the conversation (as a page load would). */
  renderAll(): void {
    if (this.viewer && (this.locked || this.viewer.chatId !== this.chat.id)) closeViewer(this); // a poll redraws the same chat: the enlarged photo stays open
    this.entries = [];
    this.statusEntry = null;
    this.photoLine = null;
    this.panelLocked = !!this.locked;
    this.redraw();
    if (this.locked) {
      this.push({ key: this.key(), kind: "locked", locked: this.locked, email: this.me.email, canSignIn: this.canSignIn });
      return;
    }
    if (this.checkingMe) {
      this.push({ key: this.key(), kind: "wait", text: "Checking your sign-in…" });
      return;
    }
    const editorChat = this.mode === "editor" && !!this.chat.server;
    if (!this.chat.messages.length) this.push(this.intro());
    this.chat.messages.forEach((m, i) => {
      const last = i === this.chat.messages.length - 1;
      this.push(this.messageEntry(m, last));
      if (editorChat && m.role === "assistant" && m.turn_id) this.push({ key: this.key(), kind: "feedback", m, old: !last, convId: this.chat.id });
      if (m.question && last) this.push({ key: this.key(), kind: "question", q: m.question, old: false });
      if (m.review && last && editorChat) this.push({ key: this.key(), kind: "review", review: m.review, old: false });
      if (m.optional && last && editorChat) this.push({ key: this.key(), kind: "optional", card: m.optional, old: false });
      if (m.replies && m.replies.length && last) this.push({ key: this.key(), kind: "chips", replies: m.replies, old: false });
    });
    paintPhotoLine(this);
    this.toBottom();
    watchPublishing(this);
  }

  /** Only the last message's chips and buttons are live; older ones fade and stop responding. */
  retireChips(): void {
    for (const e of this.entries) {
      if (e.kind === "intro" || e.kind === "chips" || e.kind === "question" || e.kind === "review" || e.kind === "optional") e.old = true;
      else if (e.kind === "message" && e.nav) e.navOld = true;
    }
    this.redraw();
  }
  /** A question or a review card is waiting for an answer (the input then invites a typed one; on a phone the tray folds for a review). */
  liveQuestion(): boolean {
    return this.entries.some((e) => (e.kind === "question" || e.kind === "review" || e.kind === "optional") && !e.old);
  }
  reviewLive(): boolean {
    return this.entries.some((e) => (e.kind === "review" || e.kind === "optional") && !e.old);
  }

  setStatus(text: string): void {
    if (!this.statusEntry) this.statusEntry = this.push({ key: this.key(), kind: "status", text: "", hidden: false });
    this.statusEntry.text = text;
    this.statusEntry.hidden = !text;
    this.redraw();
    this.toBottom();
  }
  hideStatus(): void {
    if (this.statusEntry) {
      this.statusEntry.hidden = true;
      this.redraw();
    }
  }
  clearStatus(): void {
    this.remove(this.statusEntry);
    this.statusEntry = null;
  }
  showError(text: string): void {
    this.clearStatus();
    this.push({ key: this.key(), kind: "error", text });
    this.toBottom();
  }

  // --- what is kept between pages ---
  saveChat(): void {
    if (this.chat.server) return;
    storeChat(this.local, this.chat);
  }
  saveUi(): void {
    storeUi(this.session, { open: !this.panelHidden, id: this.chat.id, draft: (this.els.input?.value ?? "").slice(0, 2000), unread: this.unread, pending: this.pendingTurn });
  }
  rememberEditorChat(): void {
    writeJson(this.local, EDITOR_KEY, this.chat.server && this.chat.id ? { email: this.me.email, id: this.chat.id } : null);
  }
  markSeen(at: unknown): void {
    if (typeof at !== "string" || !at) return;
    const seen = readJson(this.local, SEEN_KEY) as { email?: string; at?: string } | null;
    if (!seen || seen.email !== this.me.email || !((seen.at as string) >= at)) writeJson(this.local, SEEN_KEY, { email: this.me.email, at: at.slice(0, 40) });
  }
  seenAt(): string {
    const seen = readJson(this.local, SEEN_KEY) as { email?: string; at?: unknown } | null;
    return seen && seen.email === this.me.email && typeof seen.at === "string" ? seen.at : "";
  }
  /** Remembers that the sign-in sheet was opened from the chat, so a sign-in that reloads the page (the magic link) reopens the panel with the draft. */
  markSigninPending(): void {
    writeJson(this.local, PENDING_KEY, { t: Date.now(), open: !this.panelHidden, draft: (this.els.input?.value ?? "").slice(0, 2000) });
  }

  // --- the bubble, the header, the context chip ---
  /** Whether the bubble shows: not on pages loaded after the server said the chat is off (this page keeps it, with the message), and with CHAT_PUBLIC=false only for a signed-in visitor. */
  paintBubble(): void {
    const hidden = (this.locked === "off" && this.switchedOffEarlier) || (this.config.publicOff && !(this.canSignIn && this.auth.getSession()));
    this.bubble.hidden = hidden;
    this.redraw();
    if (hidden && !this.panelHidden) this.close();
  }
  /** The bubble's notice while the panel is closed: a ring while an answer (or a Save) is on its way, a dot once it has arrived. */
  paintNotice(): void {
    const working = this.panelHidden && !this.unread && !!(this.streaming || this.trayBusy || this.photoState);
    const dotOn = this.panelHidden && this.unread;
    this.bubble.dot = dotOn;
    this.bubble.working = working;
    this.bubble.label = dotOn ? "Chat about recipes: new reply" : working ? "Chat about recipes: still answering" : "Chat about recipes";
    this.redraw();
  }
  /** Something arrived (an answer, an error, a save) while the panel was closed: the dot on the bubble until it is opened. */
  markUnread(): void {
    if (!this.panelHidden) return;
    this.unread = true;
    this.paintNotice();
    this.saveUi();
  }
  paintHeader(): void {
    const editor = this.mode === "editor";
    this.head.chatsHidden = !editor;
    this.attachHidden = !editor || !(this.chat && this.chat.server);
    if (this.attachHidden && this.pending.length) {
      this.pending = [];
      paintShelf(this);
    }
    this.head.title = editor && this.chat.title ? this.chat.title : "Recipe chat";
    this.head.banner = this.me.signedIn && !editor ? `Signed in as ${this.me.email} — this account can't edit, so the chat is read-only.` : "";
    this.redraw();
    if (!editor && this.listing) setListing(this, false);
  }
  paintContext(): void {
    const label = contextLabel(this.ctx);
    this.context = { hidden: !label || this.contextDismissed, label: `On: ${label}` };
    this.redraw();
  }
  dismissContext(): void {
    this.contextDismissed = true;
    this.paintContext();
  }

  setBusy(busy: boolean): void {
    this.sendDisabled = busy;
    this.busy = busy;
    this.inputBusy = busy ? "true" : "false";
    this.paintNotice();
  }

  /** Switch the panel into a locked state (from a server answer) and remember "off" for the rest of this tab session. */
  lock(kind: Exclude<Locked, null>): void {
    this.locked = kind;
    if (kind === "off") rememberOff(this.session);
    this.streaming = null;
    this.setBusy(false);
    this.renderAll();
    this.paintBubble();
  }

  // --- the panel ---
  open(opts?: { restore?: boolean }): void {
    if (!this.panelHidden) return;
    this.panelHidden = false;
    this.doc.body.classList.add("chat-open");
    this.unread = false;
    if (this.lastReplyAt) this.markSeen(this.lastReplyAt);
    this.paintNotice();
    this.paintContext();
    layoutPanel(this);
    this.toBottom();
    if (this.mode === "editor") void loadTray(this);
    if (!(opts && opts.restore)) this.after(() => this.els.input?.focus({ preventScroll: true })); // a restored panel must not pop the keyboard up
    this.saveUi();
  }
  close(): void {
    if (this.panelHidden) return;
    closeViewer(this);
    this.panelHidden = true;
    this.doc.body.classList.remove("chat-open");
    this.paintNotice();
    this.els.bubble?.focus({ preventScroll: true });
    this.saveUi();
  }
  toggle(): void {
    if (this.panelHidden) this.open();
    else this.close();
  }
  newChat(): void {
    if (this.streaming) this.streaming.abort();
    this.streaming = null;
    this.setBusy(false);
    this.pending = [];
    this.creating = null;
    this.photoNote = "";
    paintShelf(this);
    schedulePhotoPoll(this, null);
    if (this.mode === "editor") {
      this.chat = { server: true, id: null, title: "", messages: [] };
      this.rememberEditorChat();
    } else {
      this.chat = this.anonChat = { id: newId(), messages: [] };
      this.saveChat();
    }
    setListing(this, false);
    this.paintHeader();
    this.saveUi();
    this.renderAll();
    this.after(() => this.els.input?.focus({ preventScroll: true }));
  }

  autosize(): void {
    const input = this.els.input;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  setInput(value: string): void {
    if (this.els.input) this.els.input.value = value;
    this.autosize();
  }
}

function cloneCards(cards: Message["cards"]): Message["cards"] {
  return cards ? cards.map((c) => ({ ...c, kicker: { ...c.kicker } })) : undefined;
}
