// The chat on the page (docs/chatbot-design.md 9): starting up (the panel as it was on the last page of this tab, the server asked who is
// signed in), the phone's keyboard (the panel is as tall as the visual viewport; the tray folds while the keyboard is up), and the bubble lifted
// above the page's sticky bars (the shopping page's Save bar, the recipe page's cook bar).
import type { ChatApp } from "./app.ts";
import { onAuthChange, refreshMe } from "./session.ts";
import { closeViewer } from "./photos.ts";
import { loadUi } from "./storage.ts";
import { narrowScreen, renderTray, setAutoFold } from "./tray.ts";
import { send } from "./turn.ts";

/** On phones the panel is as tall as the visual viewport, so the input stays above the on-screen keyboard. */
export function layoutPanel(app: ChatApp): void {
  const vv = app.win.visualViewport;
  const panel = app.els.panel;
  if (!vv || !panel) return;
  panel.style.setProperty("--chat-h", `${vv.height}px`);
  panel.style.setProperty("--chat-top", `${vv.offsetTop}px`);
}

/** The tray folds to one line while the on-screen keyboard is up, and opens again when it closes or a message is sent. */
export function checkKeyboard(app: ChatApp): void {
  const vv = app.win.visualViewport;
  const open = !!vv && app.win.innerHeight - vv.height > 120 && app.doc.activeElement === app.els.input;
  if (open === app.keyboardOpen) return;
  app.keyboardOpen = open;
  app.redraw(); // the panel's kb-open
  if (!open) app.keyboardForcedOpen = false;
  if (app.trayData) renderTray(app);
}
export function onInputFocus(app: ChatApp): void {
  checkKeyboard(app);
  // iOS can report the viewport before the keyboard has finished sliding up: measure again once it has.
  setTimeout(() => {
    layoutPanel(app);
    checkKeyboard(app);
    if (!app.panelHidden) app.toBottom();
  }, 350);
}
export function onInputBlur(app: ChatApp): void {
  setTimeout(() => checkKeyboard(app), 50);
}
/** Enter sends on a keyboard (Shift+Enter is a new line); on a touch screen Enter is a new line and the button sends. */
export function onInputKeydown(app: ChatApp, e: KeyboardEvent): void {
  const coarse = !!(app.win.matchMedia && app.win.matchMedia("(pointer: coarse)").matches);
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) {
    e.preventDefault();
    send(app, app.els.input?.value);
  }
}
export function onInput(app: ChatApp): void {
  app.autosize();
  app.saveUi();
}

/** Scrolling up in the conversation folds the tray (phones), so the older messages get the room. It opens again on a tap, a new card or the end of a turn. */
export function onLogScroll(app: ChatApp): void {
  const log = app.els.log;
  if (!log) return;
  const top = log.scrollTop;
  const up = top < app.lastLogTop - 4;
  app.lastLogTop = top;
  if (!up || Date.now() < app.foldLockUntil || !narrowScreen(app) || !app.trayData || app.autoFold) return;
  if (log.scrollHeight - top - log.clientHeight > 120) {
    app.foldLockUntil = Date.now() + 500; // folding resizes the log: ignore the scroll events that causes
    setAutoFold(app, true);
  }
}

/** The bubble sits above any sticky bar that reaches the bottom of the screen (a bar that stops short of the bubble, on a desktop, needs no lift). */
function lift(app: ChatApp): void {
  const { win, doc } = app;
  const bubble = app.els.bubble;
  if (!bubble) return;
  let px = 0;
  doc.querySelectorAll<HTMLElement>(".save-bar, .cook-bar").forEach((bar) => {
    if (bar.hidden) return;
    const pos = win.getComputedStyle(bar).position;
    if (pos !== "sticky" && pos !== "fixed") return;
    const r = bar.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const overlapsBubble = r.left < b.right && r.right > b.left;
    if (overlapsBubble && r.height > 0 && r.top < win.innerHeight && r.bottom > win.innerHeight - 8) px = Math.max(px, win.innerHeight - r.top);
  });
  bubble.style.setProperty("--chat-lift", px ? `${px}px` : "0px");
  app.els.panel?.style.setProperty("--chat-lift", px ? `${px}px` : "0px");
}

/**
 * Starts the chat once the panel is in the page: listens to the page, sign-in and the keyboard, and comes back to the panel as it was on the
 * last page of this tab (open, same conversation, the unsent draft, scrolled to the end). Returns a function that stops it (tests).
 */
export function start(app: ChatApp): () => void {
  const { win, doc } = app;
  const stop = new AbortController();
  const signal = stop.signal;
  const cleanups: (() => void)[] = [() => stop.abort()];

  if (app.canSignIn) cleanups.push(app.auth.onChange((session, info) => onAuthChange(app, session, info)));

  doc.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || app.panelHidden || doc.body.classList.contains("sheet-open")) return;
      if (app.viewer) closeViewer(app, true); // an enlarged photo goes back to the chat first
      else app.close();
    },
    { signal },
  );

  layoutPanel(app); // as tall as the visual viewport from the start (the old script usually caught the page's first viewport resize)
  const vv = win.visualViewport;
  if (vv) {
    vv.addEventListener("resize", () => checkKeyboard(app), { signal });
    vv.addEventListener(
      "resize",
      () => {
        layoutPanel(app);
        if (!app.panelHidden) app.toBottom();
      },
      { signal },
    );
    vv.addEventListener("scroll", () => layoutPanel(app), { signal });
  }
  win.addEventListener(
    "pagehide",
    () => {
      app.leaving = true;
      app.saveUi();
    },
    { signal },
  );
  win.addEventListener("beforeunload", () => (app.leaving = true), { signal });
  win.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && (app.leaving = false), { signal }); // back from the bfcache: alive again

  let liftQueued = false;
  const queueLift = () => {
    if (liftQueued) return;
    liftQueued = true;
    win.requestAnimationFrame(() => {
      liftQueued = false;
      lift(app);
    });
  };
  win.addEventListener("scroll", queueLift, { passive: true, signal });
  win.addEventListener("resize", queueLift, { signal });
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(queueLift);
    mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    cleanups.push(() => mo.disconnect());
  }
  queueLift();

  // The new page's context chip already shows this page; the next message carries it to the server.
  const restored = loadUi(app.session);
  app.paintBubble();
  app.paintNotice();
  app.renderAll();
  app.paintHeader();
  if (app.checkingMe) void refreshMe(app);
  if ((restored.id === app.chat.id || app.checkingMe) && typeof restored.draft === "string" && restored.draft) app.setInput(restored.draft.slice(0, 2000));
  if (restored.open === true) {
    app.open({ restore: true });
    win.requestAnimationFrame(() => app.toBottom());
  }
  return () => cleanups.forEach((fn) => fn());
}
