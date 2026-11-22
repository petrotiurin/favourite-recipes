// The recipe chat (docs/chatbot-design.md, .claude/rules/chat.md): a bubble bottom right that opens a panel talking to the backend's POST /chat.
// One island on every page of a build that has CHAT_API_URL (`client:idle`, written by src/components/Layout.astro); the page itself is complete
// without it, so if it fails to load or /chat is down the page is unaffected. The build writes nothing for it (where the bubble goes depends on
// what only the browser knows: who is signed in, a chat switched off earlier in this tab); it draws once it is awake.
//
// Two modes: a visitor's chat (history in this browser, sent with each turn) and a signed-in editor's (the sign-in store, src/lib/auth.ts; the
// server owns the history, the client only sends its message and the conversation id; chats list, thumbs up / down, the plan tray, photos).
// Safety: model text never becomes markup (RichText.tsx), and links and photos are only kept when they are on this site (src/lib/chat/clean.ts).
import { useLayoutEffect, useState } from "preact/hooks";
import { auth as siteAuth, type Auth } from "../../lib/auth.ts";
import { ChatApp } from "../../lib/chat/app.ts";
import { start } from "../../lib/chat/start.ts";
import { ChatView } from "./Panel.tsx";

export interface ChatProps {
  /** The backend's /chat address (CHAT_API_URL). */
  api: string;
  /** CHAT_PUBLIC=false: the bubble only for signed-in visitors. */
  publicOff?: boolean;
  /** SUPABASE_URL, when the build has sign-in: signed photo links are only accepted from it. */
  supabaseUrl?: string;
  /** Only tests pass another store or window. */
  store?: Auth;
  win?: Window;
}

export default function Chat({ api, publicOff = false, supabaseUrl = "", store = siteAuth, win }: ChatProps) {
  const [app, setApp] = useState<ChatApp | null>(null);
  // Made in the browser only, after the first render (which matches what the build wrote: nothing).
  useLayoutEffect(() => {
    setApp(new ChatApp({ api, publicOff, photoBase: supabaseUrl.replace(/\/$/, "") }, { auth: store, win }));
  }, []);
  return app ? <Started app={app} /> : null;
}

function Started({ app }: { app: ChatApp }) {
  // Once the panel is in the page: listen, and come back to the panel as it was on the last page of this tab.
  useLayoutEffect(() => start(app), [app]);
  return <ChatView app={app} />;
}
