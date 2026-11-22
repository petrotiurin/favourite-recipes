// The two review cards Finalise list can show (drawn by the server from the book or the tray's list; answered by the server, no model call):
// - the drafts review: one row per draft of this week (photo, title, thumbs up / down), no thumb = kept for the coming week, one Done;
// - the optional items: one row per item only garnishes and extras need, every row ticked (kept) to start, one Done that sends every answer.
// Answers are kept on the message too, so a redraw of the panel keeps them. Once answered the card fades and its buttons stop (`old`).
import { useState } from "preact/hooks";
import type { ChatApp } from "../../lib/chat/app.ts";
import { optionalText, reviewText, type OptionalCard, type Review } from "../../lib/chat/clean.ts";
import { send } from "../../lib/chat/turn.ts";
import { DownIcon, TickIcon, UpIcon } from "./icons.tsx";

const tf = (b: boolean): "true" | "false" => (b ? "true" : "false");

export function ReviewView({ app, review, old }: { app: ChatApp; review: Review; old: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const a: Record<string, string> = {};
    review.drafts.forEach((d) => d.answer && (a[d.slug] = d.answer));
    return a;
  });
  const pick = (slug: string, a: "liked" | "remove") => {
    if (old) return;
    const next = { ...answers };
    if (next[slug] === a) delete next[slug]; // tapping the chosen thumb again takes it back: kept for the coming week
    else next[slug] = a;
    const d = review.drafts.find((x) => x.slug === slug)!;
    d.answer = (next[slug] as "liked" | "remove") || ""; // kept on the message, so a redraw of the panel keeps the thumbs
    setAnswers(next);
  };
  return (
    <div class={`chat-review${old ? " is-old" : ""}`} role="group" aria-label="This week's drafts">
      {review.drafts.map((d) => {
        const sub = d.alsoNext ? "Also planned for next week" : d.meta;
        const head = (
          <>
            {d.image ? <img class="chat-review-img" src={d.image} alt="" loading="lazy" /> : <span class="chat-review-img" aria-hidden="true" />}
            <span class="chat-review-words">
              <span class="chat-review-title">{d.title}</span>
              {sub && <span class="chat-review-sub">{sub}</span>}
            </span>
          </>
        );
        return (
          <div key={d.slug} class="chat-review-row">
            {d.url ? <a class="chat-review-head" href={d.url}>{head}</a> : <div class="chat-review-head">{head}</div>}
            <div class="chat-review-thumbs" role="group" aria-label={d.title}>
              <button type="button" class="chat-review-thumb" aria-label={`Liked ${d.title}`} aria-pressed={tf(answers[d.slug] === "liked")} disabled={old} onClick={() => pick(d.slug, "liked")}>
                <UpIcon />
              </button>
              <button type="button" class="chat-review-thumb" aria-label={`Not for us: ${d.title}`} aria-pressed={tf(answers[d.slug] === "remove")} disabled={old} onClick={() => pick(d.slug, "remove")}>
                <DownIcon />
              </button>
            </div>
          </div>
        );
      })}
      <div class="chat-review-foot">
        <p class="chat-review-hint">No thumb: kept for the coming week.</p>
        <button type="button" class="chat-chip is-done chat-review-done" disabled={old} onClick={() => !old && send(app, reviewText(review, answers), { action: "review_drafts", answers })}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A recipe's round photo on an optional row; a staged photo's link expires after a while, and an older card falls back to the plain square. */
function OptionalPhoto({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span class="chat-optional-photo" />;
  return <img class="chat-optional-photo" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function OptionalView({ app, card, old }: { app: ChatApp; card: OptionalCard; old: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const a: Record<string, string> = {};
    card.items.forEach((it) => it.answer === "drop" && (a[it.item] = "drop"));
    return a;
  });
  const toggle = (item: string) => {
    if (old) return;
    const next = { ...answers };
    if (next[item] === "drop") delete next[item];
    else next[item] = "drop";
    card.items.find((x) => x.item === item)!.answer = next[item] === "drop" ? "drop" : ""; // kept on the message, so a redraw keeps the ticks
    setAnswers(next);
  };
  return (
    <div class={`chat-review chat-optional${old ? " is-old" : ""}`} role="group" aria-label="Optional items">
      <div class="chat-optional-top">
        <span class="chat-review-title">Optional this week</span>
        <span class="chat-review-sub">Only garnishes and extras. Everything else is on the list.</span>
      </div>
      {card.items.map((it) => {
        const keep = answers[it.item] !== "drop";
        return (
          <div key={it.item} class={`chat-review-row chat-optional-row${keep ? "" : " is-off"}`}>
            <span class="chat-optional-photos" aria-hidden="true">
              {it.recipes.slice(0, 3).map((r, i) => <OptionalPhoto key={i} src={r.image} />)}
            </span>
            <span class="chat-review-words chat-optional-words">
              <span class="chat-review-title">{it.name}</span>
              <span class="chat-review-sub">{`${it.quantity ? `${it.quantity} · ` : ""}for ${it.recipes.map((r) => r.title).join(", ")}`}</span>
            </span>
            <button type="button" class="chat-optional-tick" aria-label={`Keep ${it.name}`} aria-pressed={tf(keep)} disabled={old} onClick={() => toggle(it.item)}>
              <span class="chat-optional-box" aria-hidden="true"><TickIcon /></span>
            </button>
          </div>
        );
      })}
      <div class="chat-review-foot">
        <p class="chat-review-hint">Ticked items stay on the list.</p>
        <button
          type="button"
          class="chat-chip is-done chat-review-done"
          disabled={old}
          onClick={() => {
            if (old) return;
            const all: Record<string, string> = {};
            card.items.forEach((it) => (all[it.item] = answers[it.item] === "drop" ? "drop" : "keep"));
            send(app, optionalText(card, all), { action: "review_optional", answers: all });
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
