// The foot of the panel: the "On: Steamed Rice" chip (which page "this" means; dismissable), the photos picked for the next message (editors), and
// the message box with its attach and send buttons. The box keeps its own text (the app reads and sets it), so typing never redraws the panel.
import type { ChatApp } from "../../lib/chat/app.ts";
import { openPicker, pickFiles, removePhoto, retryPhoto } from "../../lib/chat/photos.ts";
import { onInput, onInputBlur, onInputFocus, onInputKeydown } from "../../lib/chat/start.ts";
import { send } from "../../lib/chat/turn.ts";
import { AttachIcon, CloseIcon, SendIcon } from "./icons.tsx";

function Shelf({ app }: { app: ChatApp }) {
  const { shelf } = app;
  return (
    <div class="chat-attachments" aria-label="Photos to send" hidden={shelf.hidden}>
      {shelf.items.map(({ p, n }) => (
        <div key={p.url} class={`chat-attachment${p.state === "uploading" ? " is-uploading" : p.state === "failed" ? " is-failed" : ""}`}>
          <img class="chat-attachment-img" src={p.url} alt={`Photo ${n}`} />
          {/* the number it will have in this chat */}
          <span class="chat-photo-num" aria-hidden="true">{String(n)}</span>
          {p.state === "uploading" && <span class="chat-attachment-state" role="status">Uploading…</span>}
          {p.state === "failed" && (
            <button type="button" class="chat-attachment-state" onClick={() => retryPhoto(app, p)}>
              Retry
            </button>
          )}
          <button type="button" class="chat-attachment-remove" aria-label={`Remove photo ${n}`} onClick={() => removePhoto(app, p)}>
            <CloseIcon />
          </button>
        </div>
      ))}
      {shelf.note && <p class="chat-attachment-note" role="status">{shelf.note}</p>}
    </div>
  );
}

export function Composer({ app }: { app: ChatApp }) {
  const live = app.liveQuestion();
  return (
    <div class="chat-foot">
      <div class="chat-context" hidden={app.context.hidden}>
        <span class="chat-context-label">{app.context.label}</span>
        <button type="button" class="chat-context-close" aria-label="Don't use this page as context" onClick={() => app.dismissContext()}>
          <CloseIcon />
        </button>
      </div>
      <Shelf app={app} />
      <form
        class="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(app, app.els.input?.value);
        }}
      >
        {/* editors only: the camera / photo library; the picked photos are downscaled here and listed above the input */}
        <button type="button" class="chat-attach" aria-label="Attach photos" hidden={app.attachHidden} disabled={app.attachDisabled} onClick={() => openPicker(app)}>
          <AttachIcon />
        </button>
        <input
          type="file"
          class="chat-file"
          accept="image/*"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          ref={(el) => { app.els.picker = el; }}
          onChange={(e) => void pickFiles(app, e.currentTarget.files)}
        />
        <textarea
          class="chat-input"
          rows={1}
          placeholder={live ? "Or type an answer" : "Ask about our recipes"}
          aria-label="Message"
          maxLength={2000}
          enterkeyhint="send"
          autocomplete="off"
          aria-busy={app.inputBusy ?? undefined}
          ref={(el) => { app.els.input = el; }}
          onInput={() => onInput(app)}
          onKeyDown={(e) => onInputKeydown(app, e)}
          onFocus={() => onInputFocus(app)}
          onBlur={() => onInputBlur(app)}
        />
        <button type="submit" class="chat-send" aria-label={app.sendLabel} disabled={app.sendDisabled}>
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
