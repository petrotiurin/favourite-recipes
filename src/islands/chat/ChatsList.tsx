// An editor's chats (docs/chatbot-design.md 5): in place of the conversation while open; each row opens its chat, or deletes it after a "Delete
// this chat?" on the row itself. Chats go two weeks after their last message, and the list says so.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatApp } from "../../lib/chat/app.ts";
import { chatMeta } from "../../lib/chat/labels.ts";
import { deleteChat, openChat } from "../../lib/chat/session.ts";
import { TrashIcon } from "./icons.tsx";

type Conv = ChatApp["list"]["convs"][number];

function Row({ app, c, current, now }: { app: ChatApp; c: Conv; current: boolean; now: number }) {
  const [ask, setAsk] = useState<null | { text: string; busy: boolean }>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const asking = !!ask;
  useLayoutEffect(() => {
    if (asking) yes.current?.focus();
  }, [asking]);
  const title = String(c.title || "New chat");
  return (
    <li class={`chat-row${current ? " is-current" : ""}`}>
      {ask ? (
        <>
          <span class="chat-row-ask">{ask.text}</span>
          <button type="button" class="text-button is-quiet" onClick={() => setAsk(null)}>
            Cancel
          </button>
          <button
            type="button"
            class="text-button chat-row-yes"
            ref={yes}
            disabled={ask.busy}
            onClick={() => {
              setAsk({ ...ask, busy: true });
              deleteChat(app, c.id).then(
                (ok) => !ok && setAsk({ text: "Couldn't delete it.", busy: false }),
                () => {}, // signed out: the sheet is open
              );
            }}
          >
            Delete
          </button>
        </>
      ) : (
        <>
          <button type="button" class="chat-row-main" onClick={() => openChat(app, c)}>
            <span class="chat-row-title">{title.slice(0, 80)}</span>
            <span class="chat-row-meta">{chatMeta(c, now)}</span>
          </button>
          <button type="button" class="chat-row-delete" aria-label={`Delete chat: ${title.slice(0, 60)}`} onClick={() => setAsk({ text: "Delete this chat?", busy: false })}>
            <TrashIcon />
          </button>
        </>
      )}
    </li>
  );
}

export function ChatsList({ app }: { app: ChatApp }) {
  const { list } = app;
  return (
    <div class="chat-chats" hidden={!app.listing}>
      {list.state === "loading" && <p class="chat-chats-note">Loading your chats…</p>}
      {list.state === "failed" && <p class="chat-chats-note">Couldn't load your chats. Try again in a moment.</p>}
      {list.state === "ready" && (
        <>
          <h3 class="chat-chats-title">Your chats</h3>
          <p class="chat-chats-note">{list.convs.length ? "A chat is deleted two weeks after its last message." : "No saved chats yet. Ask something and it will show up here."}</p>
          <ul class="chat-rows">
            {list.convs.map((c) => <Row key={`${list.gen}:${c.id}`} app={app} c={c} current={c.id === list.current} now={list.now} />)}
          </ul>
        </>
      )}
    </div>
  );
}
