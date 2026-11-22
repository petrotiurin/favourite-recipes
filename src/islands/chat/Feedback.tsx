// Thumbs up / down under a turn's last message (editors only; docs/chatbot-design.md 9 "Feedback controls"). Up is sent at once with "Thanks";
// down is sent at once and opens a small box (reasons, a note, Skip / Send); tapping the chosen thumb again clears it. Earlier turns keep theirs,
// dimmed (`old`). What was chosen is kept on the message, so a redraw keeps it.
import { useState } from "preact/hooks";
import type { ChatApp } from "../../lib/chat/app.ts";
import { FEEDBACK_REASONS, type Feedback, type Message } from "../../lib/chat/clean.ts";
import { feedbackNote } from "../../lib/chat/labels.ts";
import { postFeedback } from "../../lib/chat/session.ts";
import { DownIcon, UpIcon } from "./icons.tsx";

const tf = (b: boolean): "true" | "false" => (b ? "true" : "false");

export function FeedbackView({ app, m, old, convId }: { app: ChatApp; m: Message; old: boolean; convId: string | null }) {
  const [s, setS] = useState(() => {
    const fb = m.feedback || null;
    return {
      fb,
      sent: !!(fb && fb.value === 0 && ((fb.reasons && fb.reasons.length) || fb.note)),
      picked: fb && fb.reasons ? fb.reasons.slice() : ([] as string[]),
      note: fb && fb.note ? fb.note : "",
      box: false,
      failed: false,
    };
  });
  const post = (value: 0 | 1 | null, fb: Feedback | null) => {
    void postFeedback(app, convId, m, value, fb).then((ok) => !ok && setS((x) => ({ ...x, failed: true })));
  };
  const choose = (value: 0 | 1) => {
    if (s.fb && s.fb.value === value) {
      m.feedback = null; // tapping the chosen thumb again takes it back
      setS({ ...s, fb: null, sent: false, box: false, failed: false });
      post(null, null);
    } else {
      const fb: Feedback = { value, reasons: [], note: "" };
      m.feedback = fb;
      setS({ ...s, fb, sent: false, picked: [], note: "", box: value === 0, failed: false });
      post(value, fb);
    }
  };
  const sendBox = () => {
    if (!s.fb || s.fb.value !== 0) return;
    const fb: Feedback = { value: 0, reasons: s.picked.slice(), note: s.note.trim().slice(0, 300) };
    m.feedback = fb;
    setS({ ...s, fb, sent: true, box: false, failed: false });
    post(0, fb);
  };
  return (
    <div class={`chat-feedback${old ? " is-old" : ""}`}>
      <div class="fb-row">
        <button type="button" class="fb-btn" aria-label="Good reply" aria-pressed={tf(!!s.fb && s.fb.value === 1)} onClick={() => choose(1)}>
          <UpIcon />
        </button>
        <button type="button" class="fb-btn" aria-label="Bad reply" aria-pressed={tf(!!s.fb && s.fb.value === 0)} onClick={() => choose(0)}>
          <DownIcon />
        </button>
        <span class="fb-note" role="status">{s.failed ? "Couldn't save that" : feedbackNote(s.fb, s.sent)}</span>
      </div>
      <div class="fb-box" hidden={!s.box}>
        <p class="fb-q">What went wrong? (optional)</p>
        <div class="fb-chips">
          {FEEDBACK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              class="fb-chip"
              aria-pressed={tf(s.picked.indexOf(r) !== -1)}
              onClick={() => setS((x) => ({ ...x, picked: x.picked.indexOf(r) === -1 ? [...x.picked, r] : x.picked.filter((p) => p !== r) }))}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          class="fb-input"
          type="text"
          maxLength={300}
          placeholder="Add a note"
          aria-label="Add a note"
          autocomplete="off"
          value={s.note}
          onInput={(e) => {
            const note = e.currentTarget.value;
            setS((x) => ({ ...x, note }));
          }}
        />
        <div class="fb-actions">
          <button type="button" class="text-button is-quiet" onClick={() => setS((x) => ({ ...x, box: false }))}>
            Skip
          </button>
          <button type="button" class="fb-send" onClick={sendBox}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
