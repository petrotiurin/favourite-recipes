// Tappable answers (docs/chatbot-design.md 6.1): suggested replies (outline chips; a plain one is sent as the next message, { label, url } opens a
// page on this site, { label, action } presses one of the tray's own buttons with fixed words), and an ask_user question (solid chips; with
// `multi` they toggle and Done sends them together). Only the last message's are live: older ones fade and stop responding (`old`).
import { useState } from "preact/hooks";
import type { ChatApp } from "../../lib/chat/app.ts";
import type { Question, Reply } from "../../lib/chat/clean.ts";
import { actionChipLabel, pressTray } from "../../lib/chat/tray.ts";
import { send } from "../../lib/chat/turn.ts";
import { guardLink } from "./Message.tsx";
import { ArrowIcon } from "./icons.tsx";

const off = (old: boolean) => (old ? "true" : undefined);

export function Chips({ app, replies, old, starters }: { app: ChatApp; replies: Reply[]; old: boolean; starters?: boolean }) {
  return (
    <div class={`chat-chips${starters ? " chat-starters" : ""}${old ? " is-old" : ""}`} aria-disabled={off(old)}>
      {replies.map((r, i) => {
        if (typeof r === "string") {
          return (
            <button key={i} type="button" class="chat-chip" disabled={old} onClick={() => !old && send(app, r)}>
              {r}
            </button>
          );
        }
        if ("action" in r) {
          // presses the tray's own button: still a tap by a person; the words are fixed, never the model's
          return (
            <button key={i} type="button" class="chat-chip is-action" data-action={r.action} disabled={old} onClick={() => !old && pressTray(app, r.action)}>
              {actionChipLabel(app, r.action)}
            </button>
          );
        }
        return (
          <a key={i} class="chat-chip is-nav" href={r.url} aria-disabled={off(old)} tabIndex={old ? -1 : undefined} onClick={guardLink(app, old)}>
            {r.label}
            <span class="chat-nav-arrow"><ArrowIcon /></span>
          </a>
        );
      })}
    </div>
  );
}

export function QuestionView({ app, q, old }: { app: ChatApp; q: Question; old: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div class={`chat-question${old ? " is-old" : ""}`} role="group" aria-label={q.question} aria-disabled={off(old)}>
      <p class="chat-q">{q.question}</p>
      <div class={`chat-chips${old ? " is-old" : ""}`} aria-disabled={off(old)}>
        {q.options.map((o) => (
          <button
            key={o}
            type="button"
            class="chat-chip is-solid"
            aria-pressed={q.multi ? (picked.indexOf(o) !== -1 ? "true" : "false") : undefined}
            disabled={old}
            onClick={() => {
              if (old) return;
              if (!q.multi) return send(app, o);
              setPicked((p) => (p.indexOf(o) === -1 ? [...p, o] : p.filter((x) => x !== o)));
            }}
          >
            {o}
          </button>
        ))}
        {q.multi && (
          <button type="button" class="chat-chip is-done" disabled={old || !picked.length} onClick={() => !old && picked.length && send(app, picked.join(", "))}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
