// Photos (editors; .claude/rules/chat.md "Photos"): the ones picked for the next message (downscaled here, uploaded at once on their own with
// POST /chat/uploads while the editor types, so sending is instant), the reading of sent photos on the server (the panel polls the conversation
// and shows "Reading photos… 4 of 6"), and a sent photo enlarged in the panel.
import type { ChatApp, EntryOf } from "./app.ts";
import { cleanPhotos, cleanServerMessages, type Message, type PhotoState } from "./clean.ts";
import { photoProgress } from "./labels.ts";
import { MAX_PHOTOS, chatPhotoCount, downscale, tooManyNote, type PendingPhoto } from "./photo-files.ts";
import { authedFetch } from "./session.ts";
import { loadTray } from "./tray.ts";

/** Uploads one picked photo. The first upload of a chat that doesn't exist yet makes it; the others wait for its id. */
export function uploadPhoto(app: ChatApp, p: PendingPhoto): Promise<void> {
  p.state = "uploading";
  const post = (convId: string | null) =>
    authedFetch(app, `${app.apiBase}/uploads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: p.data, conversation_id: convId || undefined }) }).then((res) =>
      res.json().then(
        (j: { error?: string; conversation_id?: unknown; path?: unknown } | null) => {
          if (res.status === 404 && j && j.error === "Not found") return { local: true as const }; // an older server without the upload route
          if (!res.ok) throw new Error((j && j.error) || "upload");
          return j!;
        },
        () => {
          throw new Error("upload");
        },
      ),
    );
  const forChat = app.chat;
  let run: Promise<{ local?: true; conversation_id?: unknown; path?: unknown; error?: string }>;
  if (app.chat.id) run = post(app.chat.id);
  else if (app.creating) {
    run = app.creating.then((id) => {
      if (id === "local") return { local: true as const };
      if (!id) throw new Error("upload"); // the first one failed: retry this one by hand
      return post(id);
    });
  } else {
    run = post(null);
    const mine = (app.creating = run.then(
      (j) => (j && j.local ? "local" : j && typeof j.conversation_id === "string" ? j.conversation_id : null),
      () => null,
    ));
    void mine.then(() => {
      if (app.creating === mine) app.creating = null;
    });
  }
  p.promise = run
    .then((j) => {
      if (app.chat !== forChat || app.pending.indexOf(p) === -1) return; // a new chat, or the photo was removed meanwhile
      if (j.local) {
        p.state = "local";
      } else {
        if (!app.chat.id && typeof j.conversation_id === "string") {
          app.chat.id = j.conversation_id; // the upload made the chat: the message goes to it
          app.rememberEditorChat();
          app.saveUi();
        }
        if (j.conversation_id !== app.chat.id || typeof j.path !== "string") throw new Error("moved");
        p.path = j.path;
        p.state = "done";
      }
      paintShelf(app);
    })
    .then(null, (err: Error) => {
      if (app.pending.indexOf(p) === -1) return;
      p.state = "failed";
      if (err && err.message && err.message !== "upload" && err.message !== "moved") app.photoNote = err.message;
      paintShelf(app);
    });
  paintShelf(app);
  return p.promise;
}

/** The photos above the input, numbered as they will be in this chat. */
export function paintShelf(app: ChatApp): void {
  const before = chatPhotoCount(app.chat.messages);
  app.shelf = { hidden: !app.pending.length && !app.photoNote, items: app.pending.map((p, i) => ({ p, n: before + i + 1 })), note: app.photoNote };
  app.attachDisabled = app.pending.length >= MAX_PHOTOS;
  app.redraw();
}
export function retryPhoto(app: ChatApp, p: PendingPhoto): void {
  app.photoNote = "";
  void uploadPhoto(app, p);
}
export function removePhoto(app: ChatApp, p: PendingPhoto): void {
  app.pending.splice(app.pending.indexOf(p), 1);
  paintShelf(app);
  app.els.input?.focus({ preventScroll: true }); // the button is gone: keep focus somewhere sensible
}
export function openPicker(app: ChatApp): void {
  if (!app.streaming && app.pending.length < MAX_PHOTOS) app.els.picker?.click();
}
/** Photos picked in the camera / photo library. */
export function pickFiles(app: ChatApp, list: FileList | File[] | null): Promise<void> {
  const picked = Array.prototype.slice.call(list || []) as File[];
  const room = MAX_PHOTOS - app.pending.length;
  const files = picked.slice(0, room);
  if (app.els.picker) app.els.picker.value = "";
  app.photoNote = tooManyNote(picked.length, room);
  return files
    .reduce<Promise<void>>(
      (chain, file) =>
        chain.then(() => {
          if (!/^image\//.test(file.type || "image/")) {
            app.photoNote = `${app.photoNote ? `${app.photoNote} ` : ""}Only photos can be attached.`;
            return;
          }
          return downscale(file, app.doc).then(
            (p) => {
              if (app.pending.length >= MAX_PHOTOS) return;
              app.pending.push(p);
              if (app.mode === "editor" && app.chat.server) void uploadPhoto(app, p);
            },
            () => {
              app.photoNote = `${app.photoNote ? `${app.photoNote} ` : ""}Couldn't read one of those photos. Try a JPEG or PNG.`;
            },
          );
        }),
      Promise.resolve(),
    )
    .then(() => paintShelf(app));
}

// --- photos being read on the server ---
export function paintPhotoLine(app: ChatApp): void {
  app.remove(app.photoLine);
  app.photoLine = null;
  const text = app.mode === "editor" && app.chat.server ? photoProgress(app.photoState) : "";
  if (!text || app.locked || app.checkingMe) return;
  app.photoLine = app.push({ key: app.key(), kind: "status", text, hidden: false, reading: true });
}

/** Photos are being read (or the follow-up is on its way): ask the conversation again in a while, and show the line under it. */
export function schedulePhotoPoll(app: ChatApp, photos: PhotoState | null, soon?: boolean): void {
  clearTimeout(app.photoTimer);
  const was = app.photoState;
  if (soon || !was || !photos || was.read !== photos.read || was.reading !== photos.reading) app.photoChangedAt = Date.now();
  if (photos && Date.now() - app.photoChangedAt > 10 * 60 * 1000) photos = null; // after 10 quiet minutes the panel stops waiting (the server can't finish it)
  app.photoState = photos || null;
  paintPhotoLine(app);
  app.paintNotice();
  if (app.mode !== "editor" || !app.chat.server || !app.chat.id || (!app.photoState && !soon)) return;
  app.photoTimer = setTimeout(() => pollPhotos(app), soon ? 1500 : app.panelHidden ? 15000 : 5000); // closed panel: slower, but the ring and the dot still work
}
function sameMessages(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].role !== b[i].role || a[i].content !== b[i].content) return false;
  return true;
}
function pollPhotos(app: ChatApp): void {
  const convId = app.chat.id;
  if (app.mode !== "editor" || !app.chat.server || !convId) return;
  if (app.streaming || app.listing) return schedulePhotoPoll(app, app.photoState); // a turn of our own is running: it reloads when it ends
  authedFetch(app, `${app.apiBase}/conversations/${encodeURIComponent(convId)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then(
      (j: { messages?: unknown; photos?: unknown; last_reply_at?: unknown } | null) => {
        if (!j || app.chat.id !== convId || app.mode !== "editor") return;
        if (app.streaming) return schedulePhotoPoll(app, app.photoState);
        const next = cleanServerMessages(j.messages, app.origin, app.config.photoBase);
        const photos = cleanPhotos(j.photos);
        if (!sameMessages(next, app.chat.messages)) {
          app.photoChangedAt = Date.now();
          const grew = next.length > app.chat.messages.length;
          app.chat.messages = next;
          app.photoState = photos;
          app.renderAll();
          void loadTray(app, { highlight: true });
          if (grew) app.markUnread();
        }
        if (!app.panelHidden) app.markSeen(j.last_reply_at);
        schedulePhotoPoll(app, photos);
      },
      () => schedulePhotoPoll(app, app.photoState),
    );
}

// --- a sent photo, enlarged: it fills the panel (the photo whole, on a dark backdrop, its number kept); a tap or Escape goes back ---
export function openViewer(app: ChatApp, e: EntryOf<"message">, i: number, shot: HTMLElement): void {
  const src = e.m.images && e.m.images[i];
  if (!src) return;
  closeViewer(app);
  const n = e.numbers && e.numbers[i];
  const shots = app.els.log ? Array.prototype.slice.call(app.els.log.querySelectorAll(".chat-shot")) : [];
  app.viewer = { src, alt: n ? `Photo ${n} you sent` : "A photo you sent", num: n ? String(n) : "", shotKey: `${e.key}:${i}`, index: shots.indexOf(shot), chatId: app.chat.id };
  app.after(() => app.els.panel?.querySelector<HTMLElement>(".chat-viewer")?.focus({ preventScroll: true }));
}
export function closeViewer(app: ChatApp, refocus?: boolean): void {
  const v = app.viewer;
  if (!v) return;
  app.viewer = null;
  app.redraw();
  if (refocus) {
    // the same thumbnail, or (the log was drawn again while it was open) the same photo's new one
    app.after(() => {
      const from = app.els.log?.querySelectorAll<HTMLElement>(".chat-shot")[v.index];
      if (from && from.isConnected) from.focus({ preventScroll: true });
    });
  }
}
