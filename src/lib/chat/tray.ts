// The plan tray (editors; docs/chatbot-design.md 7.1): what the chat has staged for the site, shared by the household. Nothing here is saved until a
// person taps Save to site. The server draws the tray (GET /chat/plan, reduced by tray-data.ts); the buttons call it. `renderTray` works out what
// the strip shows (src/islands/chat/Tray.tsx draws it).
import type { ChatApp } from "./app.ts";
import { PLAN_LABELS, cleanCards, type Message, type PlanAction } from "./clean.ts";
import { saveTrayFold } from "./storage.ts";
import { authedFetch } from "./session.ts";
import { balanceLine, cleanReading, cleanTray, readingSaveNote, trayButton, trayExpiryNotice, trayLine } from "./tray-data.ts";
import { send } from "./turn.ts";

/** On a phone the tray is a big strip (wide screens have the room). */
export function narrowScreen(app: ChatApp): boolean {
  return !!(app.win.matchMedia && app.win.matchMedia("(max-width: 719px)").matches);
}

function setManualFold(app: ChatApp, on: boolean): void {
  app.trayManualFold = on;
  if (!on) app.trayChanged = false;
  saveTrayFold(app.session, app.trayManualFold, app.trayChanged);
}
/**
 * It folds itself to its header line while a reply streams, while a review card waits for its answer, and when the reader scrolls up in the
 * conversation (phones); folded by the reader (a tap on the head), it stays folded for the rest of the tab's visit, and a change shows as a dot.
 */
export function setAutoFold(app: ChatApp, on: boolean): void {
  if (app.autoFold === on) return;
  app.autoFold = on;
  if (app.trayData) renderTray(app);
}
export function trayFolded(app: ChatApp): boolean {
  return app.trayManualFold || (app.keyboardOpen && !app.keyboardForcedOpen) || ((app.autoFold || app.reviewLive()) && !app.autoFoldSuppressed && narrowScreen(app));
}
export function keyboardUnfold(app: ChatApp): void {
  if (app.keyboardOpen) app.keyboardForcedOpen = true; // a fold the reader chose themselves stays
  if (app.trayData) renderTray(app);
}

/** A tap on the strip's head: folds or unfolds it. */
export function toggleTrayHead(app: ChatApp): void {
  if (app.tray?.folded) {
    if (app.autoFold || app.reviewLive()) app.autoFoldSuppressed = true; // tapped open while it was folded on its own
    if (app.keyboardOpen) app.keyboardForcedOpen = true;
    setManualFold(app, false);
  } else {
    app.keyboardForcedOpen = false;
    setManualFold(app, true); // stays folded for this tab until tapped open again
  }
  renderTray(app);
}

/** The Save chip's count follows the tray as it is now, whatever it was when the chip was drawn. */
export function actionChipLabel(app: ChatApp, action: PlanAction): string {
  return PLAN_LABELS[action] + (action === "apply_plan" && app.trayData && app.trayData.count ? ` (${app.trayData.count})` : "");
}

/** Works out what the strip shows now. highlight: cards that weren't there before (in `seen`) get the new-card treatment and the row scrolls to them. */
export function renderTray(app: ChatApp, opts?: { highlight?: boolean; seen?: Record<string, boolean> } | null): void {
  app.trayPressed.clear();
  const gen = ++app.trayGen;
  const data = app.trayData;
  const base = { reading: app.trayReading, gen, folded: false, label: "", changedDot: false, balance: "", notice: "", button: { kind: "blocked" as const, label: "" }, items: [], detail: null, msg: "", blocked: "", waitNote: "", goDisabled: true };
  if (app.mode === "editor" && app.trayReading.length && (!data || !data.count)) {
    // nothing staged yet, but photos are being read (someone's): the strip says so, nothing to save
    app.tray = { ...base, hidden: false, readingOnly: true };
    app.redraw();
    return;
  }
  if (!data || app.mode !== "editor" || !data.count) {
    app.tray = { ...base, hidden: true, readingOnly: false, folded: app.tray ? app.tray.folded : false }; // hidden as it was (folded or not)
    app.redraw();
    return;
  }
  const folded = trayFolded(app);
  const button = trayButton(data);
  const fresh: string[] = [];
  const items = data.items.map((item) => {
    const isNew = !!(opts && opts.highlight && opts.seen && !opts.seen[item.id]);
    if (isNew) fresh.push(item.id);
    return { item, isNew };
  });
  const detail = (app.trayDetail && data.items.filter((i) => i.id === app.trayDetail)[0]) || null;
  app.tray = {
    ...base,
    hidden: false,
    readingOnly: false,
    folded,
    label: trayLine(data, folded),
    changedDot: folded && app.trayManualFold && app.trayChanged,
    balance: balanceLine(data.balance),
    notice: trayExpiryNotice(data, Date.now()),
    button,
    items,
    detail,
    msg: app.trayMsg,
    blocked: button.kind === "blocked" ? data.blocked : "",
    waitNote: button.kind === "save" ? readingSaveNote(app.trayReading) : "",
    goDisabled: button.kind === "finalising" || button.kind === "blocked" || app.trayBusy,
  };
  app.redraw();
  if (folded) return;
  const tray = () => app.els.tray;
  if (detail && app.revealDetail) {
    app.revealDetail = false;
    // the tray scrolls inside .tray-scroll and the button sits in its own row below, so "nearest" is enough
    app.after(() => tray()?.querySelector<HTMLElement>(".tray-detail")?.scrollIntoView?.({ block: "nearest" }));
  }
  if (fresh.length) {
    app.after(() => tray()?.querySelector<HTMLElement>(`.tray-card[data-id="${fresh[0]}"]`)?.scrollIntoView?.({ inline: "start", block: "nearest" }));
    setTimeout(() => {
      if (app.tray && app.tray.gen === gen) {
        app.tray.items = app.tray.items.map((x) => (x.isNew ? { ...x, isNew: false } : x));
        app.redraw();
      }
    }, 4000);
  }
}

function trayCall(app: ChatApp, method: string, path: string, body?: unknown): Promise<Response> {
  return authedFetch(app, app.apiBase + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

function scheduleTrayPoll(app: ChatApp): void {
  clearTimeout(app.trayTimer);
  if ((!app.trayData && !app.trayReading.length) || app.panelHidden || app.mode !== "editor") return;
  if (!app.trayData) {
    app.trayTimer = setTimeout(() => void loadTray(app, { highlight: true }), 10000);
    return;
  }
  const waiting = app.trayReading.length > 0 || app.trayData.state === "finalising" || app.trayData.items.some((i) => i.photo && i.photo.status === "pending");
  if (waiting) app.trayTimer = setTimeout(() => void loadTray(app, { highlight: true }), 10000); // each load is a server dry run: poll slowly, and only while something is pending
}

/** Fetches the household's tray and draws it. A request in flight is joined, not repeated (each is a dry run on the server). */
export function loadTray(app: ChatApp, opts?: { highlight?: boolean }): Promise<void> {
  if (app.mode !== "editor" || !app.canSignIn || !app.auth.getSession()) return Promise.resolve();
  if (opts && opts.highlight) app.trayHighlight = true;
  if (app.trayLoading) return app.trayLoading;
  clearTimeout(app.trayTimer);
  const seq = ++app.traySeq;
  let o: { highlight?: boolean } | undefined = app.trayHighlight ? { highlight: true } : opts;
  app.trayHighlight = false;
  const request = trayCall(app, "GET", "/plan")
    .then(
      (res) => (res.ok ? res.json() : null),
      () => null,
    )
    .then((j: { tray?: unknown; reading?: unknown } | null) => {
      if (seq !== app.traySeq || app.mode !== "editor" || !j) return;
      const next = cleanTray(j.tray, app.origin, app.config.photoBase);
      app.trayReading = cleanReading(j.reading);
      const wasSeen = app.traySeen;
      const seen: Record<string, boolean> = {};
      app.traySeen = seen;
      if (next) next.items.forEach((i) => (seen[i.id] = true));
      if (!wasSeen && o && o.highlight === undefined) o = {};
      app.trayData = next;
      const landed = !!wasSeen && !!next && next.items.some((i) => !wasSeen[i.id]);
      const gone = !!wasSeen && Object.keys(wasSeen).some((id) => !seen[id]);
      if (landed) app.autoFold = false; // something new landed: show it (unless the reader folded it: then the dot says so)
      if ((landed || gone) && app.trayManualFold && !app.trayChanged) {
        app.trayChanged = true;
        saveTrayFold(app.session, app.trayManualFold, app.trayChanged);
      }
      if (app.trayDetail && (!next || !next.items.some((i) => i.id === app.trayDetail))) app.trayDetail = null;
      renderTray(app, o && o.highlight && wasSeen ? { highlight: true, seen: wasSeen } : null); // compared with what was shown BEFORE this load
      scheduleTrayPoll(app);
    });
  app.trayLoading = request;
  const done = () => {
    if (app.trayLoading === request) app.trayLoading = null;
  };
  request.then(done, done);
  return request;
}

export function clearTray(app: ChatApp): void {
  app.trayLoading = null;
  app.traySeq++;
  app.trayData = null;
  app.trayReading = [];
  app.traySeen = null;
  app.trayMsg = "";
  app.trayDetail = null;
  clearTimeout(app.trayTimer);
  renderTray(app);
}

/** A tap on a card: a flagged clash asks the bot about it (the bot resolves clashes); anything else opens or closes its staged recipe / list. */
export function pressCard(app: ChatApp, id: string): void {
  const item = app.trayData?.items.find((i) => i.id === id);
  if (!item) return;
  if (item.clash) {
    send(app, `Saving hit a clash on ${item.title}: ${item.clash.reason}. Help me resolve it.`);
  } else {
    app.trayDetail = app.trayDetail === item.id ? null : item.id;
    app.revealDetail = !!app.trayDetail;
    renderTray(app);
  }
}
export function closeDetail(app: ChatApp): void {
  app.trayDetail = null;
  renderTray(app);
}
/** × on a card (the list card has none: it follows next week). */
export function dropItem(app: ChatApp, id: string): void {
  app.trayPressed.add(`drop:${id}`);
  app.redraw();
  void trayCall(app, "DELETE", `/plan/items/${id}`).then(() => {
    if (app.trayDetail === id) app.trayDetail = null;
    void loadTray(app);
  });
}
/** "New photo" on a new recipe's card: the server makes another. */
export function newPhoto(app: ChatApp, id: string): void {
  app.trayPressed.add(`photo:${id}`);
  app.redraw();
  void trayCall(app, "POST", `/plan/items/${id}/photo`).then(() => void loadTray(app));
}

/** The two buttons the tray has (and the chips that press them): Finalise list, and Save to site. Always a tap by a person. */
export function pressTray(app: ChatApp, action: PlanAction): void {
  if (app.streaming || !app.trayData) return;
  if (action === "finalise_plan") {
    if (app.trayData.state === "finalising") return;
    // the drafts review card is still open: answering it is the next step of Finalise, so take them there instead of starting over
    const openReview = app.els.log?.querySelector<HTMLElement>(".chat-review:not(.is-old)");
    if (openReview) {
      openReview.scrollIntoView({ block: "nearest", behavior: "smooth" });
      openReview.querySelector<HTMLElement>(".chat-review-done")?.focus({ preventScroll: true });
      return;
    }
    app.trayData.state = "finalising";
    renderTray(app);
    send(app, "Finalise list", { action: "finalise" });
  } else if (action === "apply_plan") {
    const b = trayButton(app.trayData);
    if (b.kind === "save") saveTray(app);
    else if (b.kind === "finalise") pressTray(app, "finalise_plan");
  }
}

/** Save to site (or Save now on one card): POST /plan/apply. One commit; the summary lands in the chat, new recipes as "Publishing…" cards. */
export function saveTray(app: ChatApp, itemId?: string): void {
  if (app.trayBusy || app.streaming) return;
  app.trayBusy = true;
  app.trayMsg = itemId ? "Saving that change…" : "Saving…";
  renderTray(app);
  app.paintNotice();
  trayCall(app, "POST", "/plan/apply", { item_id: itemId, conversation_id: app.chat.server && app.chat.id ? app.chat.id : undefined })
    .then((res) =>
      res.json().then(
        (j) => ({ status: res.status, body: (j || {}) as { summary?: unknown; cards?: unknown; clash?: { reason?: unknown }[]; error?: unknown } }),
        () => ({ status: res.status, body: {} as { summary?: unknown; cards?: unknown; clash?: { reason?: unknown }[]; error?: unknown } }),
      ),
    )
    .then(
      (r) => {
        app.trayBusy = false;
        app.markUnread();
        app.paintNotice();
        if (r.status === 200) {
          app.trayMsg = "";
          const msg: Message = { role: "assistant", content: String(r.body.summary || "Saved."), cards: cleanCards(r.body.cards, app.origin) };
          app.chat.messages.push(msg);
          app.retireChips();
          app.push(app.messageEntry(msg, true));
          app.toBottom();
          watchPublishing(app);
          void loadTray(app);
        } else if (r.status === 409 && r.body.clash) {
          app.trayMsg = "";
          void loadTray(app).then(() => {
            send(app, `Saving hit a clash: ${String((r.body.clash![0] && r.body.clash![0].reason) || "a recipe changed on the site")}. Help me resolve it.`);
          });
        } else {
          app.trayMsg = String(r.body.error || "Couldn't save just now.").slice(0, 200);
          void loadTray(app);
        }
      },
      (err: Error) => {
        app.trayBusy = false;
        app.markUnread();
        app.paintNotice();
        app.trayMsg = err && err.name === "AuthExpired" ? "" : "Couldn't save just now. Nothing was changed.";
        renderTray(app);
      },
    );
}

/** "Publishing…": a saved recipe's page isn't live for a minute or two; its card stays inert until the server sees the page (GET /chat/status). */
export function watchPublishing(app: ChatApp): void {
  clearTimeout(app.publishTimer);
  if (app.mode !== "editor" || !app.canSignIn) return;
  const slugs: string[] = [];
  app.chat.messages.forEach((m) => {
    (m.cards || []).forEach((c) => {
      if (c.publishing && c.slug && slugs.indexOf(c.slug) === -1) slugs.push(c.slug);
    });
  });
  if (!slugs.length || app.publishTries > 60) return;
  app.publishTimer = setTimeout(
    () => {
      app.publishTries++;
      authedFetch(app, `${app.apiBase}/status?slugs=${encodeURIComponent(slugs.slice(0, 8).join(","))}`)
        .then(
          (res) => (res.ok ? res.json() : null),
          () => null,
        )
        .then((j: { live?: Record<string, unknown> } | null) => {
          const live = (j && j.live) || {};
          let changed = false;
          app.chat.messages.forEach((m) => {
            (m.cards || []).forEach((c) => {
              if (c.publishing && live[c.slug] === true) {
                c.publishing = false;
                changed = true;
              }
            });
          });
          if (changed && !app.streaming) app.renderAll();
          else watchPublishing(app);
        });
    },
    app.publishTries ? 6000 : 3000,
  );
}
