// The plan tray strip (editors; docs/chatbot-design.md 7.1), drawn from what src/lib/chat/tray.ts worked out (`app.tray`): a head line that folds
// it, the week's balance, the cards in a sideways row (kicker, title, who added it, a problem or a note; × to drop; New photo / Save now), the open
// card's staged recipe or list, and the one button: Finalise list, or Save to site (n). Nothing is saved until a person taps it.
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { ChatApp } from "../../lib/chat/app.ts";
import { closeDetail, dropItem, newPhoto, pressCard, pressTray, saveTray, toggleTrayHead } from "../../lib/chat/tray.ts";
import { TRAY_KINDS, readingLine, type Reading, type TrayItem } from "../../lib/chat/tray-data.ts";
import { ChevronIcon, CloseIcon } from "./icons.tsx";
import { InlineText } from "./RichText.tsx";

function ReadingLines({ reading }: { reading: Reading[] }) {
  return (
    <div class="tray-reading" role="status">
      {reading.map((e, i) => <p key={i} class="tray-reading-line">{readingLine(e)}</p>)}
    </div>
  );
}

/** The card's photo: the staged one, else the recipe's own; gone or not deployed yet, the placeholder shows. */
function Thumb({ item }: { item: TrayItem }) {
  const [failed, setFailed] = useState(false);
  const src = item.photo && item.photo.url ? item.photo.url : item.recipe && item.recipe.image;
  const status = item.photo && item.photo.status;
  return (
    <div class="tray-thumb">
      {src && !failed && <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />}
      {(status === "pending" || (status === "failed" && !src)) && <span class="tray-thumb-note">{status === "pending" ? "Making the photo…" : "No photo yet"}</span>}
    </div>
  );
}

function Card({ app, item, isNew }: { app: ChatApp; item: TrayItem; isNew: boolean }) {
  const kind = TRAY_KINDS[item.kind];
  const cls = item.kind === "new" ? (item.draft ? "kicker-draft" : "") : item.kind === "next" ? (item.add ? "kicker-next" : "") : kind.cls;
  let problem = null;
  if (item.clash) problem = <p class="tray-problem">{item.clash.reason}</p>;
  else if (item.error) problem = <p class="tray-problem">{item.error}</p>;
  else if (item.notes && item.notes.length) problem = <p class="tray-note">{item.notes[0]}</p>;
  else if (item.photo && item.photo.status === "failed") problem = <p class="tray-problem">{`The photo didn't work: ${item.photo.error || "try again"}`}</p>;
  const hasActions = !!item.photo || item.save_now;
  return (
    <div class={`tray-card${isNew ? " is-new" : ""}${item.error ? " has-error" : ""}${item.clash ? " has-clash" : ""}`} role="listitem" data-id={item.id}>
      <button type="button" class="tray-card-main" onClick={() => pressCard(app, item.id)}>
        {["switch", "list", "servings", "catalogue"].indexOf(item.kind) === -1 && <Thumb item={item} />}
        <p class={`kicker${cls ? ` ${cls}` : ""}`}>{item.kind === "next" && !item.add ? "Off next week" : kind.label}</p>
        <h3 class="tray-title">{item.title}</h3>
        {item.sub && <p class="tray-sub">{item.sub}</p>}
        <p class="tray-who">{`Added by ${item.added_by}`}</p>
        {/* its own line, so a longer reason wraps instead of cutting the name off */}
        {item.reason && <p class="tray-who tray-why">{item.reason}</p>}
        {problem}
      </button>
      {/* the list card follows next week (the server rebuilds it), so it has no ×: drop the recipes instead */}
      {item.kind !== "list" && (
        <button type="button" class="tray-drop" aria-label={`Drop from the tray: ${item.title}`} disabled={app.trayPressed.has(`drop:${item.id}`)} onClick={() => dropItem(app, item.id)}>
          <CloseIcon />
        </button>
      )}
      {hasActions && (
        <div class="tray-card-actions">
          {item.photo && (
            <button type="button" class="text-button tray-link" disabled={item.photo.status === "pending" || app.trayPressed.has(`photo:${item.id}`)} onClick={() => newPhoto(app, item.id)}>
              New photo
            </button>
          )}
          {item.save_now && (
            <button type="button" class="text-button tray-link" onClick={() => saveTray(app, item.id)}>
              Save now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ app, item }: { app: ChatApp; item: TrayItem }) {
  let body;
  if (item.detail) {
    const d = item.detail;
    // a list in sections ("Sauce") gets a small heading over each section's lines, as on the recipe page
    const groups: { sec: string | null; lines: string[] }[] = [];
    d.ingredients.forEach((x, n) => {
      const sec = d.sections[n] || null;
      const last = groups[groups.length - 1];
      if (!last || sec !== last.sec) groups.push({ sec, lines: [x] });
      else last.lines.push(x);
    });
    body = (
      <>
        {d.ingredients.length > 0 && <h4 class="tray-detail-h">Ingredients</h4>}
        {groups.map((g, i) => (
          <Fragment key={i}>
            {g.sec && <p class="tray-detail-section">{g.sec}</p>}
            <ul>{g.lines.map((x, j) => <li key={j}><InlineText text={x} origin={app.origin} /></li>)}</ul>
          </Fragment>
        ))}
        {d.steps.length > 0 && (
          <>
            <h4 class="tray-detail-h">Instructions</h4>
            {/* **bold** ingredient names */}
            <ol>{d.steps.map((x, j) => <li key={j}><InlineText text={x} origin={app.origin} /></li>)}</ol>
          </>
        )}
        {d.notes && <p class="tray-detail-notes">{d.notes}</p>}
      </>
    );
  } else if (item.preview) {
    body = (
      <>
        {item.edits && item.edits.length > 0 && <p class="tray-detail-notes">{`Changes: ${item.edits.join("; ")}.`}</p>}
        {(item.notes || []).map((x, i) => <p key={`n${i}`} class="tray-note">{x}</p>)}
        {item.preview.map((sec, i) => (
          <Fragment key={i}>
            <h4 class="tray-detail-h">{sec.name}</h4>
            <ul>{sec.items.map((x, j) => <li key={j}>{x}</li>)}</ul>
          </Fragment>
        ))}
      </>
    );
  } else {
    body = <p class="tray-detail-notes">{item.sub || ""}</p>;
  }
  return (
    <div class="tray-detail">
      <h3 class="tray-detail-title">{item.title}</h3>
      {body}
      <button type="button" class="text-button is-quiet" onClick={() => closeDetail(app)}>
        Close
      </button>
    </div>
  );
}

export function Tray({ app }: { app: ChatApp }) {
  const t = app.tray;
  const hidden = !t || t.hidden;
  return (
    <section class={`chat-tray${t && t.folded ? " is-folded" : ""}`} aria-label="Plan tray" hidden={hidden} ref={(el) => { app.els.tray = el; }}>
      {t && !t.hidden && t.readingOnly && <ReadingLines reading={t.reading} />}
      {t && !t.hidden && !t.readingOnly && (
        <>
          <button type="button" class="tray-head" aria-expanded={t.folded ? "false" : "true"} onClick={() => toggleTrayHead(app)}>
            <span class="tray-head-label">
              {t.label}
              {t.changedDot && (
                <>
                  <span class="tray-dot" title="Changed since you folded it" />
                  <span class="sr-only"> · changed</span>
                </>
              )}
            </span>
            <span class="tray-chev"><ChevronIcon /></span>
          </button>
          {!t.folded && (
            <>
              {t.balance && <p class="tray-balance">{t.balance}</p>}
              {/* the cards and details scroll here; the button below never overlaps them */}
              <div class="tray-scroll">
                {t.reading.length > 0 && <ReadingLines reading={t.reading} />}
                {t.notice && (
                  <div class="tray-notice">
                    <span>{t.notice}</span>
                    {(t.button.kind === "finalise" || t.button.kind === "save") && (
                      <button type="button" class="chat-chip" onClick={() => pressTray(app, t.button.kind === "save" ? "apply_plan" : "finalise_plan")}>
                        {t.button.kind === "save" ? "Save to site" : "Finalise list"}
                      </button>
                    )}
                  </div>
                )}
                <div class="tray-cards" role="list" aria-label="Changes in the tray">
                  {t.items.map(({ item, isNew }) => <Card key={`${t.gen}:${item.id}`} app={app} item={item} isNew={isNew} />)}
                </div>
                {t.detail && <Detail key={`${t.gen}:d`} app={app} item={t.detail} />}
                {t.msg ? <p class="tray-msg" role="status">{t.msg}</p> : t.blocked ? <p class="tray-msg">{t.blocked}</p> : null}
                {t.waitNote && <p class="tray-msg tray-wait">{t.waitNote}</p>}
              </div>
              <button type="button" class="save-button tray-go" disabled={t.goDisabled} onClick={() => pressTray(app, t.button.kind === "save" ? "apply_plan" : "finalise_plan")}>
                {t.button.label}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
