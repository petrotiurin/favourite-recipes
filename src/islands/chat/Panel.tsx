// The panel and the bubble (docs/chatbot-design.md 9): on a phone a full-height sheet, from 720px a floating panel by the bubble. Header (title,
// Chats, New chat, the account button, close), the read-only banner, the chats list, the conversation log, the tray and the foot. Everything is
// drawn from the app (src/lib/chat/app.ts); `rev` is read here, so any change the app makes draws the panel again.
import { useLayoutEffect } from "preact/hooks";
import type { ChatApp, Entry } from "../../lib/chat/app.ts";
import { closeViewer } from "../../lib/chat/photos.ts";
import { LOCKED_SIGNIN_COPY, signInFromChat, toggleListing } from "../../lib/chat/session.ts";
import { onLogScroll } from "../../lib/chat/start.ts";
import AccountButton from "../SignIn.tsx";
import { ChatsList } from "./ChatsList.tsx";
import { Chips, QuestionView } from "./Chips.tsx";
import { Composer } from "./Composer.tsx";
import { FeedbackView } from "./Feedback.tsx";
import { ChatIcon, CloseIcon, ListIcon } from "./icons.tsx";
import { MessageView } from "./Message.tsx";
import { OptionalView, ReviewView } from "./Review.tsx";
import { Tray } from "./Tray.tsx";

/** The panel when the chat can't be used: switched off, editors only, or an account that isn't an editor. No input (CSS hides the footer). */
function Locked({ app, e }: { app: ChatApp; e: Extract<Entry, { kind: "locked" }> }) {
  let title: string;
  let text: string;
  if (e.locked === "off") {
    title = "The chat is switched off for now.";
    text = "The recipes and the shopping list work as usual. Check back later.";
  } else if (e.locked === "signin") {
    title = "Chat is for signed-in editors";
    text = "Sign in with your family account to ask about the recipes.";
  } else {
    title = "This account can't use the chat";
    text = e.email ? `Signed in as ${e.email}. Only family editors can use the chat right now.` : "Only family editors can use the chat right now.";
  }
  return (
    <div class="chat-locked" role="status">
      <h3 class="chat-locked-title">{title}</h3>
      <p class="chat-locked-text">{text}</p>
      {e.locked === "signin" && e.canSignIn && (
        <button type="button" class="save-button chat-locked-signin" onClick={() => signInFromChat(app, LOCKED_SIGNIN_COPY)}>
          Sign in
        </button>
      )}
    </div>
  );
}

function EntryView({ app, e }: { app: ChatApp; e: Entry }) {
  switch (e.kind) {
    case "locked":
      return <Locked app={app} e={e} />;
    case "wait":
      return <p class="chat-status" role="status">{e.text}</p>;
    case "status":
      return <p class={`chat-status${e.reading ? " chat-reading" : ""}`} role="status" hidden={e.hidden}>{e.text}</p>;
    case "error":
      return <p class="chat-error" role="alert">{e.text}</p>;
    case "intro":
      return (
        <div class="chat-intro">
          <p>Ask me about recipes on this site.</p>
          {e.starters.length > 0 && <Chips app={app} replies={e.starters} old={e.old} starters />}
        </div>
      );
    case "message":
      return <MessageView app={app} e={e} />;
    case "feedback":
      return <FeedbackView app={app} m={e.m} old={e.old} convId={e.convId} />;
    case "question":
      return <QuestionView app={app} q={e.q} old={e.old} />;
    case "review":
      return <ReviewView app={app} review={e.review} old={e.old} />;
    case "optional":
      return <OptionalView app={app} card={e.card} old={e.old} />;
    case "chips":
      return <Chips app={app} replies={e.replies} old={e.old} />;
  }
}

export function ChatView({ app }: { app: ChatApp }) {
  void app.rev.value; // draw again on every change the app makes
  useLayoutEffect(() => app.flushAfter());
  const { head, bubble, viewer } = app;
  const hasTray = !!app.tray && !app.tray.hidden;
  const cls = ["chat-panel", app.panelLocked && "is-locked", app.busy && "is-busy", app.listing && "is-listing", hasTray && "has-tray", app.keyboardOpen && "kb-open"].filter(Boolean).join(" ");
  return (
    <>
      <section class={cls} id="chat-panel" role="dialog" aria-label="Recipe chat" hidden={app.panelHidden} ref={(el) => { app.els.panel = el; }}>
        <header class="chat-head">
          <h2 class="chat-title">{head.title}</h2>
          <button type="button" class="chat-icon-btn chat-chats-btn" aria-label="Your chats" aria-expanded={app.listing ? "true" : "false"} hidden={head.chatsHidden} onClick={() => toggleListing(app)}>
            <ListIcon />
          </button>
          <button type="button" class="text-button chat-new" onClick={() => app.newChat()}>
            New chat
          </button>
          {/* the Sign in button, or the avatar and its menu (src/islands/SignIn.tsx); a tap on Sign in here gives the sheet the chat's own words */}
          <div
            class="chat-account"
            hidden={!app.canSignIn}
            onClickCapture={(ev) => {
              const target = ev.target as Element | null;
              if (!target || !target.closest || !target.closest('[data-auth="signin"]')) return;
              ev.stopPropagation(); // not the button's own handler: this one passes the chat's wording
              signInFromChat(app);
            }}
          >
            {app.canSignIn && <AccountButton compact store={app.auth} />}
          </div>
          <button type="button" class="icon-button chat-close" aria-label="Close chat" onClick={() => app.close()}>
            <CloseIcon />
          </button>
        </header>
        <p class="chat-banner" hidden={!head.banner}>{head.banner}</p>
        <ChatsList app={app} />
        <div class="chat-log" role="log" aria-live="polite" aria-label="Conversation" ref={(el) => { app.els.log = el; }} onScroll={() => onLogScroll(app)}>
          {app.entries.map((e) => <EntryView key={e.key} app={app} e={e} />)}
        </div>
        <Tray app={app} />
        <Composer app={app} />
        {viewer && (
          <button type="button" class="chat-viewer" aria-label="Back to the chat" onClick={() => closeViewer(app, true)}>
            <img class="chat-viewer-img" src={viewer.src} alt={viewer.alt} decoding="async" />
            {viewer.num && <span class="chat-photo-num" aria-hidden="true">{viewer.num}</span>}
          </button>
        )}
      </section>
      <button
        type="button"
        class={`chat-bubble${bubble.working ? " is-working" : ""}`}
        aria-label={bubble.label}
        aria-expanded={app.panelHidden ? "false" : "true"}
        aria-controls="chat-panel"
        hidden={bubble.hidden}
        ref={(el) => { app.els.bubble = el; }}
        onClick={() => app.toggle()}
      >
        <ChatIcon />
        <span class="chat-dot" hidden={!bubble.dot} />
      </button>
    </>
  );
}
