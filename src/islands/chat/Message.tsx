// One message in the conversation: the user's (their words as text, their photos with the numbers the chat uses for them) or the bot's (model text
// through RichText, recipe cards built from server data, and the "Open Steamed Rice" button once the answer is complete), or a note from the site.
import type { ChatApp, EntryOf } from "../../lib/chat/app.ts";
import { KICKER_CLASSES, type Card } from "../../lib/chat/clean.ts";
import { openViewer } from "../../lib/chat/photos.ts";
import { ArrowIcon } from "./icons.tsx";
import { RichText } from "./RichText.tsx";

/** Links stay put while a reply is still streaming: a tap then would drop the answer on the floor. A link that goes is remembered for the next page. */
export function guardLink(app: ChatApp, old?: boolean) {
  return (e: MouseEvent) => {
    if (app.streaming || old || (e.currentTarget as Element).getAttribute("aria-disabled") === "true") e.preventDefault();
    else app.saveUi();
  };
}

const LISTITEM = { role: "listitem" };

function CardView({ app, c }: { app: ChatApp; c: Card }) {
  const kicker = `kicker${KICKER_CLASSES[c.kicker.kind] ? ` ${KICKER_CLASSES[c.kicker.kind]}` : ""}`;
  const inner = (
    <>
      {c.image && !c.publishing ? <img class="tile-image" src={c.image} alt="" loading="lazy" /> : <span class="tile-image" />}
      <p class={kicker}>{c.publishing ? "Publishing…" : c.kicker.label}</p>
      <h3 class="tile-title">{c.title}</h3>
      <p class="tile-meta">{c.meta}</p>
    </>
  );
  // a just-saved recipe's page isn't live yet: the card stays inert until it is
  if (c.publishing) return <span class="tile chat-card is-publishing" role="listitem" aria-disabled="true">{inner}</span>;
  // a link in the cards' list, as the chat always wrote it (Preact's types don't allow this role on <a>)
  return <a class="tile chat-card" href={c.url} {...(LISTITEM as object)} onClick={guardLink(app)}>{inner}</a>;
}

export function MessageView({ app, e }: { app: ChatApp; e: EntryOf<"message"> }) {
  const m = e.m;
  if (m.role === "event") return <p class="chat-event" role="status">{m.content}</p>;
  const user = m.role === "user";
  const viewer = app.viewer;
  return (
    <div class={`chat-msg ${user ? "is-user" : "is-bot"}${e.partial ? " is-partial" : ""}`}>
      <div class="chat-body">
        {user ? (
          <>
            {m.images && m.images.length > 0 && (
              <div class="chat-photos">
                {m.images.map((u, i) => {
                  const n = e.numbers && e.numbers[i];
                  return (
                    <button
                      key={i}
                      type="button"
                      class="chat-shot"
                      aria-label={n ? `Enlarge photo ${n}` : "Enlarge photo"}
                      aria-expanded={viewer && viewer.shotKey === `${e.key}:${i}` ? "true" : "false"}
                      onClick={(ev) => openViewer(app, e, i, ev.currentTarget)}
                    >
                      <img class="chat-photo" src={u} alt={n ? `Photo ${n} you sent` : "A photo you sent"} loading="lazy" decoding="async" />
                      {n ? <span class="chat-photo-num" aria-hidden="true">{String(n)}</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
            {m.content && <span class="chat-text">{m.content}</span>}
          </>
        ) : (
          <RichText text={m.content} origin={app.origin} />
        )}
      </div>
      {!user && e.cards && e.cards.length > 0 && (
        <div class="chat-cards" role="list" aria-label="Recipes">
          {e.cards.map((c, i) => <CardView key={i} app={app} c={c} />)}
        </div>
      )}
      {!user && e.nav && m.nav && (
        <a
          class={`chat-nav${e.navOld ? " is-old" : ""}`}
          href={m.nav.url}
          aria-disabled={e.navOld ? "true" : undefined}
          tabIndex={e.navOld ? -1 : undefined}
          onClick={guardLink(app, e.navOld)}
        >
          {m.nav.label}
          <span class="chat-nav-arrow"><ArrowIcon /></span>
        </a>
      )}
    </div>
  );
}
