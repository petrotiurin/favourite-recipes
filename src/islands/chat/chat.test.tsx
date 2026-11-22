// The chat island in a fake DOM (happy-dom), against a mocked /chat: the panel and its bubble, a visitor's conversation streamed in (text, status,
// cards, chips, navigation, errors, a cut stream), what is kept in the browser (the same keys) and the new-visit rule, an editor's chat (who am I,
// the stored conversation, thumbs, the chats list, a dropped stream picked up from the server, a busy turn sent again), the plan tray (fold,
// Finalise, the review cards, Save, clashes, Save now), photos (attach, upload, send by path, numbers), the sign-in sheet from the chat, and the
// locked states (switched off, editors only, an account that can't edit, CHAT_PUBLIC=false).
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_KEY, createAuth, type Auth } from "../../lib/auth.ts";
import Chat from "./Chat.tsx";

const API = "https://api.test/chat";
const SB = "https://sb.test";
const CONV = "11111111-2222-4333-8444-555555555555";
const CONV2 = "11111111-2222-4333-8444-666666666666";
const origin = () => location.origin;
const page = (p: string) => `${origin()}/favourite-recipes/${p}`;

// --- the mocked network -------------------------------------------------------------------------------------------------------------
type Handler = (req: { method: string; url: URL; body: any; headers: Record<string, string> }) => Response | Promise<Response> | undefined;
let routes: { method: string; path: string | RegExp; handler: Handler }[];
let requests: { method: string; path: string; body: any; auth?: string }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (events: [string, unknown][], opts: { cut?: boolean } = {}) => {
  const text = events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join("") + (opts.cut ? "event: text\ndata: {\"del" : "");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
};
function route(method: string, path: string | RegExp, handler: Handler | Response | (() => Response)): void {
  const h: Handler = typeof handler === "function" ? (handler as Handler) : () => (handler as Response).clone();
  routes.unshift({ method, path, handler: h });
}
async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const headers = (init.headers || {}) as Record<string, string>;
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const path = url.origin + url.pathname;
  requests.push({ method, path: path.replace(API, "/chat").replace(SB, "sb"), body, auth: headers.Authorization });
  if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
  for (const r of routes) {
    if (r.method !== method) continue;
    if (typeof r.path === "string" ? r.path === path : r.path.test(path)) {
      const res = await r.handler({ method, url, body, headers });
      if (res) return res;
    }
  }
  return json({ error: "Not found" }, 404);
}

// --- the page -----------------------------------------------------------------------------------------------------------------------
let root: HTMLElement;
let store: Auth;
const jwt = (email: string) => `h.${btoa(JSON.stringify({ email }))}.s`;
function setPage(ctx: object, extra = "") {
  document.body.innerHTML = `${extra}<script type="application/json" id="page-context">${JSON.stringify(ctx)}</script><div id="root"></div>`;
  root = document.getElementById("root")!;
}
function signedIn(email = "owner@example.com") {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ access_token: jwt(email), refresh_token: "r", expires_at: 4_000_000_000, email }));
}
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};
async function mount(props: { publicOff?: boolean; supabase?: boolean } = {}) {
  store = createAuth();
  if (props.supabase !== false) store.init({ supabaseUrl: SB, supabaseKey: "k" });
  act(() => render(<Chat api={API} publicOff={props.publicOff} supabaseUrl={props.supabase === false ? "" : SB} store={store} />, root));
  await settle();
}
function unmount() {
  act(() => render(null, root));
  store.dispose();
}
/** A new page load in the same tab: the island goes, the page comes back, the island starts again. */
async function reload(ctx: object = { page: "index" }, props: { publicOff?: boolean } = {}) {
  unmount();
  setPage(ctx);
  await mount(props);
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => $(sel)?.textContent ?? null;
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  act(() => (el as HTMLElement).click());
  await settle();
};
const type = async (value: string) => {
  const input = $<HTMLTextAreaElement>(".chat-input")!;
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(1);
};
const submit = async (value: string) => {
  await type(value);
  act(() => void $(".chat-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle();
};
/** The last message sent to POST /chat. */
const lastSent = () => requests.filter((r) => r.method === "POST" && r.path === "/chat").at(-1)!;
const log = () => $$(".chat-log > *").map((e) => e.className + (e.hasAttribute("hidden") ? "[hidden]" : ""));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  routes = [];
  requests = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  setPage({ page: "index" });
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.className = "";
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("the bubble and the panel", () => {
  it("draws a closed panel and the bubble, in that order, with the same classes and labels as always", async () => {
    await mount();
    const panel = $("section.chat-panel")!;
    const bubble = $("button.chat-bubble")!;
    expect(panel.nextElementSibling).toBe(bubble);
    expect(panel.hidden).toBe(true);
    expect(panel.id).toBe("chat-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(bubble.getAttribute("aria-controls")).toBe("chat-panel");
    expect(bubble.getAttribute("aria-expanded")).toBe("false");
    expect(bubble.getAttribute("aria-label")).toBe("Chat about recipes");
    expect($(".chat-dot")!.hidden).toBe(true);
    expect($$(".chat-head > *").map((e) => e.className)).toEqual(["chat-title", "chat-icon-btn chat-chats-btn", "text-button chat-new", "chat-account", "icon-button chat-close"]);
    expect($(".chat-chats-btn")!.hidden).toBe(true);
    expect($(".chat-account")!.hidden).toBe(false);
    expect($('.chat-account [data-auth="signin"]')).not.toBeNull();
    expect($$(".chat-panel > *").map((e) => e.className)).toEqual(["chat-head", "chat-banner", "chat-chats", "chat-log", "chat-tray", "chat-foot"]);
    expect($$(".chat-form > *").map((e) => e.className)).toEqual(["chat-attach", "chat-file", "chat-input", "chat-send"]);
    expect($(".chat-attach")!.hidden).toBe(true);
    expect(log()).toEqual(["chat-intro"]);
    expect($$(".chat-starters .chat-chip").map((c) => c.textContent)).toEqual(["Something quick tonight", "Light and healthy"]);
  });

  it("opens and closes from the bubble, the close button and Escape; the page underneath stops scrolling while it's open", async () => {
    await mount();
    await click($(".chat-bubble"));
    expect($(".chat-panel")!.hidden).toBe(false);
    expect(document.body.classList.contains("chat-open")).toBe(true);
    expect($(".chat-bubble")!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe($(".chat-input"));
    expect(text(".chat-context-label")).toBe("On: The recipe list");
    expect($(".chat-context")!.hidden).toBe(false);
    await click($(".chat-close"));
    expect($(".chat-panel")!.hidden).toBe(true);
    expect(document.body.classList.contains("chat-open")).toBe(false);
    expect(document.activeElement).toBe($(".chat-bubble"));
    await click($(".chat-bubble"));
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect($(".chat-panel")!.hidden).toBe(true);
  });

  it("Escape closes the sign-in sheet first, not the panel", async () => {
    await mount();
    await click($(".chat-bubble"));
    act(() => store.openSignIn());
    document.body.classList.add("sheet-open"); // the sheet's own island sets it
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect($(".chat-panel")!.hidden).toBe(false);
    expect(store.sheet.value).toBeNull();
  });

  it("the context chip names the recipe on a recipe page and can be dismissed (then the page isn't sent)", async () => {
    setPage({ page: "recipe", slug: "steamed-rice", title: "Steamed Rice" }, '<div class="servings-picker"><button aria-pressed="true" data-serves="2">2</button></div>');
    await mount();
    expect($$(".chat-starters .chat-chip").map((c) => c.textContent)).toEqual(["Swap an ingredient", "Scale it for 6", "What goes with it?"]);
    await click($(".chat-bubble"));
    expect(text(".chat-context-label")).toBe("On: Steamed Rice");
    route("POST", API, sse([["text", { delta: "ok" }], ["done", { suggestions: false }]]));
    await submit("hi");
    expect(requests.at(-1)!.body.page).toEqual({ page: "recipe", slug: "steamed-rice", servings: 2 });
    await click($(".chat-context-close"));
    expect($(".chat-context")!.hidden).toBe(true);
    await submit("again");
    expect(requests.at(-1)!.body.page).toEqual({ page: "recipe", dismissed: true });
  });

  it("sends the home page's search and course filter with the page", async () => {
    setPage({ page: "index" }, '<input id="recipe-search" value=" tuna "><input class="filter-input" type="radio" id="f-d" checked><label for="f-d">Dinner</label>');
    await mount();
    route("POST", API, sse([["done", { suggestions: false }]]));
    await click($(".chat-bubble"));
    await submit("x");
    expect(requests.at(-1)!.body.page).toEqual({ page: "index", search: "tuna", filter: "Dinner" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("a visitor's conversation", () => {
  const card = (slug: string, extra: object = {}) => ({ slug, title: slug.replace(/-/g, " "), image: page(`images/recipes/${slug}.jpg`), kicker: { kind: "this", label: "This week" }, meta: "20 min · 412 kcal", url: page(`recipes/${slug}.html`), ...extra });

  it("streams the answer in: status line, text through the safe renderer, cards from server data, chips, navigation; history goes back to the server", async () => {
    await mount();
    await click($(".chat-bubble"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    route("POST", API, async () => {
      await gate;
      return sse([
        ["status", { text: "Looking through the recipes…" }],
        ["text", { delta: "Try **these**:\n\n- [Steamed Rice](" + page("recipes/steamed-rice.html") + ")\n- [evil](https://evil.test/x)" }],
        ["cards", { cards: [card("steamed-rice"), card("evil", { url: "https://evil.test/x" }), card("soup", { image: "https://evil.test/p.jpg" })] }],
        ["suggestions", { replies: ["Under 20 minutes", { label: "Open next week", url: page("next-week.html") }, { label: "Evil", url: "https://evil.test" }, { label: "Commit!", action: "apply_plan" }] }],
        ["navigation", { label: "Open Steamed Rice", url: page("recipes/steamed-rice.html") }],
        ["done", { suggestions: true }],
      ]);
    });
    await submit("something with rice");
    // while it is on its way: the user's message, "Thinking…", busy
    expect(log()).toEqual(["chat-msg is-user", "chat-status"]);
    expect(text(".chat-status")).toBe("Thinking…");
    expect($(".chat-panel")!.classList.contains("is-busy")).toBe(true);
    expect($<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
    expect($(".chat-input")!.getAttribute("aria-busy")).toBe("true");
    expect($<HTMLTextAreaElement>(".chat-input")!.value).toBe("");
    release();
    await settle();
    expect(log()).toEqual(["chat-msg is-bot", "chat-chips"].reduce((a, c) => a.concat(c), ["chat-msg is-user"]));
    const bot = $(".chat-msg.is-bot")!;
    expect(bot.querySelector(".chat-body")!.innerHTML).toBe(`<p>Try <strong>these</strong>:</p><ul><li><a href="${page("recipes/steamed-rice.html")}">Steamed Rice</a></li><li>evil</li></ul>`);
    const cards = [...bot.querySelectorAll(".chat-card")];
    expect(cards.map((c) => c.querySelector(".tile-title")!.textContent)).toEqual(["steamed rice", "soup"]);
    expect(cards[0].tagName).toBe("A");
    expect(cards[0].getAttribute("role")).toBe("listitem");
    expect(cards[0].querySelector("img.tile-image")!.getAttribute("src")).toBe(page("images/recipes/steamed-rice.jpg"));
    expect(cards[1].querySelector("img"), "a photo from elsewhere is not shown").toBeNull();
    expect(cards[0].querySelector(".kicker")!.className).toBe("kicker kicker-current");
    expect(bot.lastElementChild!.className).toBe("chat-nav");
    expect(bot.querySelector(".chat-nav")!.textContent).toBe("Open Steamed Rice");
    expect($$(".chat-chips > *").map((c) => [c.tagName, c.className, c.textContent])).toEqual([
      ["BUTTON", "chat-chip", "Under 20 minutes"],
      ["A", "chat-chip is-nav", "Open next week"],
      ["BUTTON", "chat-chip is-action", "Save to site"],
    ]);
    expect($(".chat-panel")!.classList.contains("is-busy")).toBe(false);
    // a visitor sends the history: text only, well formed
    expect(requests.at(-1)!.body).toMatchObject({ messages: [{ role: "user", content: "something with rice" }], page: { page: "index" } });
    expect(typeof requests.at(-1)!.body.conversation_id).toBe("string");
    // kept in this browser, cards and chips cleaned, under the old key
    const stored = JSON.parse(localStorage.getItem("recipes-chat")!);
    expect(stored.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages[1].cards.length).toBe(2);
    // a chip is the next message; the old chips fade and stop
    route("POST", API, sse([["text", { delta: "Here." }], ["done", { suggestions: false }]]));
    await click($(".chat-chips .chat-chip"));
    expect(requests.at(-1)!.body.messages.map((m: any) => m.content)).toEqual(["something with rice", stored.messages[1].content, "Under 20 minutes"]);
    expect($(".chat-chips")!.className).toBe("chat-chips is-old");
    expect($(".chat-chips")!.getAttribute("aria-disabled")).toBe("true");
    expect($<HTMLButtonElement>(".chat-chips button")!.disabled).toBe(true);
    expect($(".chat-chips a")!.getAttribute("tabindex")).toBe("-1");
    expect($(".chat-nav")!.className).toBe("chat-nav is-old");
    expect($(".chat-nav")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("a cut stream, a server error and a refused request each say so; a partial answer isn't kept", async () => {
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, sse([["text", { delta: "Half an ans" }]], { cut: true }));
    await submit("one");
    expect(text(".chat-error")).toBe("The connection to the chat dropped before the answer finished. Try again in a moment.");
    expect($(".chat-msg.is-bot")!.className).toBe("chat-msg is-bot is-partial");
    expect(JSON.parse(localStorage.getItem("recipes-chat")!).messages.length).toBe(1);
    route("POST", API, sse([["text", { delta: "x" }], ["error", { message: "The chat is resting. Try again later." }], ["done", { suggestions: false }]]));
    await submit("two");
    expect($$(".chat-error").map((e) => e.textContent)).toEqual(["The chat is resting. Try again later."]);
    route("POST", API, json({ error: "Too many messages. Try again in an hour." }, 429));
    await submit("three");
    expect(text(".chat-error")).toBe("Too many messages. Try again in an hour.");
    route("POST", API, new Response("<html>", { status: 502 }));
    await submit("four");
    expect(text(".chat-error")).toBe("The chat isn't available right now.");
    route("POST", API, () => Promise.reject(new TypeError("Failed to fetch")));
    await submit("five");
    expect(text(".chat-error")).toBe("The connection to the chat dropped before the answer finished. Try again in a moment.");
    // a reply that failed leaves two user turns in a row: they go as one
    route("POST", API, sse([["text", { delta: "ok" }], ["done", { suggestions: false }]]));
    await submit("six");
    expect(requests.at(-1)!.body.messages).toEqual([{ role: "user", content: "one\n\ntwo\n\nthree\n\nfour\n\nfive\n\nsix" }]);
  });

  it("an answer that arrives while the panel is closed puts the dot on the bubble; a ring while it's on its way", async () => {
    await mount();
    await click($(".chat-bubble"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    route("POST", API, async () => {
      await gate;
      return sse([["text", { delta: "Done." }], ["done", { suggestions: false }]]);
    });
    await submit("hi");
    await click($(".chat-close"));
    expect($(".chat-bubble")!.className).toBe("chat-bubble is-working");
    expect($(".chat-bubble")!.getAttribute("aria-label")).toBe("Chat about recipes: still answering");
    release();
    await settle();
    expect($(".chat-dot")!.hidden).toBe(false);
    expect($(".chat-bubble")!.className).toBe("chat-bubble");
    expect($(".chat-bubble")!.getAttribute("aria-label")).toBe("Chat about recipes: new reply");
    expect(JSON.parse(sessionStorage.getItem("recipes-chat-ui")!).unread).toBe(true);
    await reload();
    expect($(".chat-dot")!.hidden, "kept for the tab across pages").toBe(false);
    await click($(".chat-bubble"));
    expect($(".chat-dot")!.hidden).toBe(true);
  });

  it("comes back as it was on the next page of the tab: open, same conversation, the unsent draft; New chat starts again", async () => {
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, sse([["text", { delta: "Answer" }], ["done", { suggestions: false }]]));
    await submit("question");
    await type("half typed");
    await reload({ page: "next-week" });
    expect($(".chat-panel")!.hidden).toBe(false);
    expect(document.activeElement, "a restored panel doesn't pop the keyboard up").not.toBe($(".chat-input"));
    expect($$(".chat-msg").map((m) => m.textContent)).toEqual(["question", "Answer"]);
    expect($<HTMLTextAreaElement>(".chat-input")!.value).toBe("half typed");
    expect(text(".chat-context-label")).toBe("On: Next week");
    await click($(".chat-new"));
    expect(log()).toEqual(["chat-intro"]);
    expect(JSON.parse(localStorage.getItem("recipes-chat")!).messages).toEqual([]);
  });

  it("a new visit (a tab without the visit marker) starts a new chat; the same tab keeps it", async () => {
    localStorage.setItem("recipes-chat", JSON.stringify({ id: "old", updated: Date.now(), messages: [{ role: "user", content: "from yesterday" }] }));
    await mount();
    expect(sessionStorage.getItem("recipes-chat-visit")).toBe("1");
    expect(localStorage.getItem("recipes-chat"), "the visitor's stored history is cleared").toBeNull();
    expect(log()).toEqual(["chat-intro"]);
    localStorage.setItem("recipes-chat", JSON.stringify({ id: "same", updated: Date.now(), messages: [{ role: "user", content: "earlier today" }] }));
    await reload();
    expect($$(".chat-msg").map((m) => m.textContent)).toEqual(["earlier today"]);
  });

  it("a visitor's chat older than two weeks isn't shown", async () => {
    sessionStorage.setItem("recipes-chat-visit", "1");
    localStorage.setItem("recipes-chat", JSON.stringify({ id: "old", updated: Date.now() - 15 * 86400_000, messages: [{ role: "user", content: "old" }] }));
    await mount();
    expect(log()).toEqual(["chat-intro"]);
  });

  it("links stay put while an answer is streaming", async () => {
    sessionStorage.setItem("recipes-chat-visit", "1");
    localStorage.setItem("recipes-chat", JSON.stringify({ id: "c", updated: Date.now(), messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a", cards: [card("soup")] }] }));
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, () => new Promise<Response>(() => {}));
    await submit("next");
    const a = $(".chat-card")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("locked states and sign-in", () => {
  it("switched off on the server: a calm message with no input, remembered for the tab (no bubble on later pages)", async () => {
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, json({ disabled: true }, 503));
    await submit("hi");
    expect($(".chat-panel")!.classList.contains("is-locked")).toBe(true);
    expect(text(".chat-locked-title")).toBe("The chat is switched off for now.");
    expect(sessionStorage.getItem("recipes-chat-off")).toBe("1");
    expect($(".chat-bubble")!.hidden, "this page keeps the bubble, with the message").toBe(false);
    await reload();
    expect($(".chat-bubble")!.hidden).toBe(true);
  });

  it("editors only (403 signin): the panel offers Sign in, which opens the sheet with the chat's words", async () => {
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, json({ signin: true }, 403));
    await submit("hi");
    expect(text(".chat-locked-title")).toBe("Chat is for signed-in editors");
    await click($(".chat-locked-signin"));
    expect(store.sheet.value).toBe("email");
    expect(store.override.value).toEqual({ title: "Sign in to the chat", lede: "Family editors can sign in to ask about the recipes." });
    expect(JSON.parse(localStorage.getItem("recipes-chat-signin")!).open).toBe(true);
  });

  it("the header's Sign in opens the sheet with the chat's own words (caught before the button's own handler)", async () => {
    await mount();
    await click($(".chat-bubble"));
    await type("my draft");
    await click($('.chat-account [data-auth="signin"]'));
    expect(store.override.value).toEqual({ title: "Sign in to the chat", lede: "Family editors can sign in to keep their chats, on any of their devices." });
    const pending = JSON.parse(localStorage.getItem("recipes-chat-signin")!);
    expect(pending).toMatchObject({ open: true, draft: "my draft" });
  });

  it("without sign-in on the build there is no account button; with CHAT_PUBLIC=false no bubble for a visitor", async () => {
    await mount({ supabase: false });
    expect($(".chat-account")!.hidden).toBe(true);
    expect($(".chat-account")!.children.length).toBe(0);
    await reload({ page: "index" }, { publicOff: true });
    expect($(".chat-bubble")!.hidden).toBe(true);
  });

  it("CHAT_PUBLIC=false: the bubble shows once signed in", async () => {
    route("GET", `${API}/me`, json({ signedIn: true, email: "owner@example.com", role: "editor" }));
    route("GET", `${API}/plan`, json({ tray: null }));
    await mount({ publicOff: true });
    expect($(".chat-bubble")!.hidden).toBe(true);
    signedIn(); // on another tab: the store hears it
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY })));
    await settle();
    expect($(".chat-bubble")!.hidden).toBe(false);
  });

  it("a signed-in account that can't edit: read-only with a banner; editors-only then locks it", async () => {
    signedIn("stranger@example.com");
    route("GET", `${API}/me`, json({ signedIn: true, email: "stranger@example.com", role: "public", public_enabled: true }));
    await mount();
    expect(text(".chat-banner")).toBe("Signed in as stranger@example.com — this account can't edit, so the chat is read-only.");
    expect($(".chat-banner")!.hidden).toBe(false);
    expect($(".chat-chats-btn")!.hidden).toBe(true);
    route("GET", `${API}/me`, json({ signedIn: true, email: "stranger@example.com", role: "public", public_enabled: false }));
    await reload();
    expect(text(".chat-locked-title")).toBe("This account can't use the chat");
    expect(text(".chat-locked-text")).toBe("Signed in as stranger@example.com. Only family editors can use the chat right now.");
  });

  it("while /chat/me hasn't answered: Checking your sign-in…, and sending waits", async () => {
    signedIn();
    route("GET", `${API}/me`, () => new Promise<Response>(() => {}));
    await mount();
    expect(text(".chat-log .chat-status")).toBe("Checking your sign-in…");
    await click($(".chat-bubble"));
    await submit("hi");
    expect(requests.filter((r) => r.method === "POST").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("an editor's chat", () => {
  const me = (extra: object = {}) => json({ signedIn: true, email: "owner@example.com", role: "editor", public_enabled: true, ...extra });
  const conv = (messages: object[], extra: object = {}) => json({ id: CONV, title: "Quick dinners", messages, ended_turns: {}, ...extra });
  beforeEach(() => {
    signedIn();
    sessionStorage.setItem("recipes-chat-visit", "1");
    route("GET", `${API}/me`, me());
    route("GET", `${API}/plan`, json({ tray: null, reading: [] }));
  });

  it("opens the stored conversation with the token; sends only the message and the id; thumbs up / down", async () => {
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    route("GET", `${API}/conversations/${CONV}`, conv([{ role: "user", content: "hi" }, { role: "assistant", content: "hello", turn_id: "t1", feedback: { value: 1 } }]));
    await mount();
    expect(requests.find((r) => r.path === "/chat/me")!.auth).toBe(`Bearer ${jwt("owner@example.com")}`);
    expect(text(".chat-title")).toBe("Quick dinners");
    expect($(".chat-chats-btn")!.hidden).toBe(false);
    expect($(".chat-attach")!.hidden).toBe(false);
    expect(log()).toEqual(["chat-msg is-user", "chat-msg is-bot", "chat-feedback"]);
    expect($$(".fb-btn").map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(text(".fb-note")).toBe("Thanks");
    // thumbs down: sent at once, the box opens; Send adds the reasons
    route("POST", `${API}/feedback`, json({ ok: true }));
    await click($$(".fb-btn")[1]);
    expect(requests.at(-1)).toMatchObject({ path: "/chat/feedback", body: { conversation_id: CONV, turn_id: "t1", value: 0 } });
    expect($(".fb-box")!.hidden).toBe(false);
    await click($$(".fb-chip").find((c) => c.textContent === "Wrong amounts")!);
    await click($(".fb-send"));
    expect(requests.at(-1)!.body).toEqual({ conversation_id: CONV, turn_id: "t1", value: 0, reasons: ["Wrong amounts"], note: "" });
    expect(text(".fb-note")).toBe("Sent: Wrong amounts");
    expect($(".fb-box")!.hidden).toBe(true);
    // tapping the chosen thumb clears it
    await click($$(".fb-btn")[1]);
    expect(requests.at(-1)!.body).toEqual({ conversation_id: CONV, turn_id: "t1", value: null });
    expect(text(".fb-note")).toBe("");
    // a turn: only the message, the id and the page; meta, title and the feedback row for the new turn
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t2" }], ["title", { conversation_id: CONV, title: "Rice ideas" }], ["text", { delta: "Sure." }], ["done", { suggestions: false }]]));
    await submit("more");
    const sent = requests.find((r) => r.method === "POST" && r.path === "/chat")!;
    expect(sent.body).toEqual({ conversation_id: CONV, message: "more", page: { page: "index" } });
    expect(sent.auth).toBe(`Bearer ${jwt("owner@example.com")}`);
    expect(text(".chat-title")).toBe("Rice ideas");
    expect($$(".chat-feedback").map((f) => f.className)).toEqual(["chat-feedback is-old", "chat-feedback"]);
    expect(localStorage.getItem("recipes-chat"), "an editor's chat isn't kept in this browser").toBeNull();
  });

  it("a new visit starts a new chat (the last one stays in the list) unless its newest reply hasn't been seen", async () => {
    sessionStorage.clear();
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    await mount();
    expect(requests.some((r) => r.path.includes("/conversations/"))).toBe(false);
    expect(localStorage.getItem("recipes-chat-editor")).toBeNull();
    expect(log()).toEqual(["chat-intro"]);
    unmount();
    sessionStorage.clear();
    localStorage.setItem("recipes-chat-seen", JSON.stringify({ email: "owner@example.com", at: "2026-11-20T10:00:00Z" }));
    route("GET", `${API}/me`, me({ last_reply: { at: "2026-11-21T10:00:00Z", conversation_id: CONV2 } }));
    route("GET", `${API}/conversations/${CONV2}`, json({ id: CONV2, title: "Photos", messages: [{ role: "assistant", content: "Read your photos." }] }));
    setPage({ page: "index" });
    await mount();
    expect($$(".chat-msg").map((m) => m.textContent)).toEqual(["Read your photos."]);
    expect($(".chat-dot")!.hidden).toBe(false);
  });

  it("the chats list: open one, delete one (after asking)", async () => {
    route("GET", `${API}/conversations`, json({ conversations: [{ id: CONV, title: "Quick dinners", updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString() }, { id: CONV2, title: "", updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3 * 86400_000).toISOString() }] }));
    route("GET", `${API}/conversations/${CONV2}`, json({ id: CONV2, title: "", messages: [{ role: "user", content: "x" }] }));
    route("DELETE", `${API}/conversations/${CONV}`, json({ ok: true }));
    await mount();
    await click($(".chat-bubble"));
    await click($(".chat-chats-btn"));
    expect($(".chat-panel")!.classList.contains("is-listing")).toBe(true);
    expect($(".chat-chats-btn")!.getAttribute("aria-expanded")).toBe("true");
    expect($$(".chat-row-title").map((t) => t.textContent)).toEqual(["Quick dinners", "New chat"]);
    expect($$(".chat-row-meta")[0].textContent).toBe("Today · until tomorrow");
    await click($(".chat-row-delete"));
    expect(text(".chat-row-ask")).toBe("Delete this chat?");
    expect(document.activeElement).toBe($(".chat-row-yes"));
    await click($(".chat-row-yes"));
    expect($$(".chat-row").length).toBe(1);
    await click($(".chat-row-main"));
    expect($(".chat-panel")!.classList.contains("is-listing")).toBe(false);
    expect($$(".chat-msg").map((m) => m.textContent)).toEqual(["x"]);
    expect(JSON.parse(localStorage.getItem("recipes-chat-editor")!)).toEqual({ email: "owner@example.com", id: CONV2 });
  });

  it("a dropped stream: waits for the turn on the server and shows it as stored", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    route("GET", `${API}/conversations/${CONV}`, conv([]));
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t9" }], ["text", { delta: "Part" }]], { cut: true }));
    await submit("long one");
    expect(text(".chat-status")).toBe("Still working on it… The answer will show here when it's ready.");
    expect(JSON.parse(sessionStorage.getItem("recipes-chat-ui")!).pending).toMatchObject({ conv: CONV, turn: "t9" });
    route("GET", `${API}/conversations/${CONV}`, conv([{ role: "user", content: "long one" }, { role: "assistant", content: "The whole answer.", turn_id: "t9" }], { ended_turns: { t9: null } }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(4100)));
    await settle();
    expect($$(".chat-msg").map((m) => m.textContent)).toEqual(["long one", "The whole answer."]);
    expect($(".chat-error")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("recipes-chat-ui")!).pending).toBeNull();
  });

  it("a turn left mid-answer on the last page is picked up on this one", async () => {
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    sessionStorage.setItem("recipes-chat-ui", JSON.stringify({ open: true, id: CONV, draft: "", unread: false, pending: { conv: CONV, turn: "t5", t: Date.now() } }));
    route("GET", `${API}/conversations/${CONV}`, conv([{ role: "user", content: "q" }], { ended_turns: {} }));
    await mount();
    expect(text(".chat-status")).toBe("Still working on it… The answer will show here when it's ready.");
    expect($<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
  });

  it("another turn of the chat is running (409): it waits and sends again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    route("GET", `${API}/conversations/${CONV}`, conv([]));
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, json({ busy: true }, 409));
    await submit("later");
    expect(text(".chat-status")).toBe("Sending when I'm done…");
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t3" }], ["text", { delta: "Now." }], ["done", { suggestions: false }]]));
    await act(async () => void (await vi.advanceTimersByTimeAsync(4100)));
    await settle();
    expect($$(".chat-msg").map((m) => m.textContent)).toEqual(["later", "Now."]);
  });

  it("an expired sign-in (401 twice): the sheet opens, the message goes back in the box", async () => {
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    route("GET", `${API}/conversations/${CONV}`, conv([]));
    route("POST", `${SB}/auth/v1/token`, json({}, 400));
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, json({ error: "expired" }, 401));
    await submit("keep me");
    expect(store.sheet.value).toBe("email");
    expect(store.message.value?.text).toBe("Your sign-in has expired. Sign in again to keep chatting.");
    expect($<HTMLTextAreaElement>(".chat-input")!.value).toBe("keep me");
    expect(JSON.parse(localStorage.getItem("recipes-chat-editor")!), "signing in again comes back to it").toEqual({ email: "owner@example.com", id: CONV });
  });

  it("an ask_user question: solid chips; multi toggles and Done sends them together; the input invites a typed answer", async () => {
    await mount();
    await click($(".chat-bubble"));
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t1" }], ["text", { delta: "Which?" }], ["question", { question: "Which ones?", options: ["Soup", "Rice", "Stew"], multi: true }], ["done", { suggestions: false }]]));
    await submit("add some");
    expect($(".chat-input")!.getAttribute("placeholder")).toBe("Or type an answer");
    expect(log().slice(-1)).toEqual(["chat-question"]);
    const done = () => $<HTMLButtonElement>(".chat-chip.is-done")!;
    expect(done().disabled).toBe(true);
    await click($$(".chat-chip.is-solid")[0]);
    await click($$(".chat-chip.is-solid")[2]);
    expect($$(".chat-chip.is-solid").map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false", "true"]);
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t2" }], ["text", { delta: "Ok." }], ["done", { suggestions: false }]]));
    await click(done());
    expect(lastSent().body.message).toBe("Soup, Stew");
    expect($(".chat-question")!.className).toBe("chat-question is-old");
    expect($(".chat-input")!.getAttribute("placeholder")).toBe("Ask about our recipes");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("the plan tray", () => {
  const trayOf = (items: object[], extra: object = {}) => ({
    tray: { id: "tr1", state: "collecting", needs_list: true, list_current: false, can_save: false, expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(), expires_day: "Fri", balance: { recipes: 2, dinners: 1, avg_kcal: 410, total_mins: 75 }, items, ...extra },
    reading: [],
  });
  const newItem = { id: "abcdef12", kind: "new", title: "Test Pasta", sub: "Draft", added_by: "Petro", reason: "from the chat about pasta", draft: true, photo: { status: "pending", url: "" }, detail: { ingredients: ["**200 g** pasta", "1 tbsp oil"], sections: [null, "Sauce"], steps: ["Boil the **pasta**"], notes: "Quick." } };
  const listItem = { id: "abcd1234", kind: "list", title: "12 items for 2 recipes", sub: "Built for 2 servings", added_by: "the site", preview: [{ name: "Fresh produce", items: ["Limes (3)"] }], edits: [], notes: [] };
  beforeEach(() => {
    signedIn();
    sessionStorage.setItem("recipes-chat-visit", "1");
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    route("GET", `${API}/me`, json({ signedIn: true, email: "owner@example.com", role: "editor" }));
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, title: "Plan", messages: [{ role: "assistant", content: "Staged.", turn_id: "t1" }] }));
  });

  it("shows the household's cards, the balance and Finalise list; a card opens its staged recipe; × drops it", async () => {
    route("GET", `${API}/plan`, json(trayOf([newItem, listItem])));
    await mount();
    await click($(".chat-bubble"));
    expect($(".chat-tray")!.hidden).toBe(false);
    expect($(".chat-panel")!.classList.contains("has-tray")).toBe(true);
    expect(text(".tray-head-label")).toBe("Tray · 2 changes · until Fri");
    expect(text(".tray-balance")).toBe("Next week after Save: 2 recipes · 1 dinner · ~410 kcal each · 1 h 15 min in all");
    expect($$(".tray-card").map((c) => [c.getAttribute("data-id"), c.querySelector(".kicker")!.className, c.querySelector(".kicker")!.textContent])).toEqual([
      ["abcdef12", "kicker kicker-draft", "New"],
      ["abcd1234", "kicker", "List"],
    ]);
    expect($$(".tray-card")[0].querySelector(".tray-thumb-note")!.textContent).toBe("Making the photo…");
    expect($$(".tray-card")[0].querySelector(".tray-why")!.textContent).toBe("from the chat about pasta");
    expect($$(".tray-card")[1].querySelector(".tray-drop"), "the list card has no ×").toBeNull();
    expect(text(".tray-go")).toBe("Finalise list");
    await click($(".tray-card-main"));
    expect(text(".tray-detail-title")).toBe("Test Pasta");
    expect($(".tray-detail ul")!.innerHTML).toBe("<li><strong>200 g</strong> pasta</li>");
    expect(text(".tray-detail-section")).toBe("Sauce");
    expect($(".tray-detail ol")!.innerHTML).toBe("<li>Boil the <strong>pasta</strong></li>");
    await click($$(".tray-card-main")[1]);
    expect(text(".tray-detail-title")).toBe("12 items for 2 recipes");
    expect(text(".tray-detail .tray-detail-h")).toBe("Fresh produce");
    await click($(".tray-detail .text-button"));
    expect($(".tray-detail")).toBeNull();
    route("DELETE", `${API}/plan/items/abcdef12`, json({ ok: true }));
    route("GET", `${API}/plan`, json(trayOf([listItem])));
    await click($(".tray-drop"));
    expect(requests.some((r) => r.method === "DELETE" && r.path === "/chat/plan/items/abcdef12")).toBe(true);
    expect($$(".tray-card").length).toBe(1);
  });

  it("folds on a tap on its head (and stays folded for the tab, with a dot when it changes)", async () => {
    route("GET", `${API}/plan`, json(trayOf([newItem])));
    await mount();
    await click($(".chat-bubble"));
    await click($(".tray-head"));
    expect($(".chat-tray")!.className).toBe("chat-tray is-folded");
    expect(text(".tray-head-label")).toBe("Tray · 1 change");
    expect(JSON.parse(sessionStorage.getItem("recipes-chat-tray-fold")!)).toEqual({ folded: true, changed: false });
    route("GET", `${API}/plan`, json(trayOf([newItem, { ...newItem, id: "abcdef99", title: "Soup" }])));
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t2" }], ["tray", { added: ["abcdef99"] }], ["text", { delta: "Added soup." }], ["done", { suggestions: false }]]));
    await submit("add soup");
    expect($(".tray-dot")).not.toBeNull();
    expect(JSON.parse(sessionStorage.getItem("recipes-chat-tray-fold")!)).toEqual({ folded: true, changed: true });
    await click($(".tray-head"));
    expect($(".chat-tray")!.className).toBe("chat-tray");
    expect(sessionStorage.getItem("recipes-chat-tray-fold")).toBeNull();
  });

  it("Finalise list: the drafts review card, then the optional items card, then Save to site; the summary comes back with Publishing… cards", async () => {
    route("GET", `${API}/plan`, json(trayOf([newItem])));
    await mount();
    await click($(".chat-bubble"));
    const review = { drafts: [{ slug: "pea-soup", title: "Pea Soup", image: page("images/recipes/pea-soup.jpg"), url: page("recipes/pea-soup.html"), meta: "20 min", also_next: false }, { slug: "rice", title: "Rice", image: "", url: page("recipes/rice.html"), meta: "", also_next: true }] };
    route("POST", API, ({ body }) => (body.action === "finalise" ? sse([["meta", { conversation_id: CONV, turn_id: "t2" }], ["text", { delta: "Here are this week's drafts." }], ["review", review], ["done", { suggestions: false }]]) : undefined));
    await click($(".tray-go"));
    expect(requests.find((r) => r.body?.action === "finalise")!.body).toMatchObject({ message: "Finalise list", action: "finalise", conversation_id: CONV });
    expect($(".chat-review")).not.toBeNull();
    expect($$(".chat-review-sub").map((s) => s.textContent)).toEqual(["20 min", "Also planned for next week"]);
    expect($(".chat-review-row img")!.getAttribute("src")).toBe(page("images/recipes/pea-soup.jpg"));
    expect($(".chat-input")!.getAttribute("placeholder")).toBe("Or type an answer");
    await click($('[aria-label="Liked Pea Soup"]'));
    await click($('[aria-label="Not for us: Rice"]'));
    await click($('[aria-label="Not for us: Rice"]')); // again: taken back, kept for the coming week
    expect($$(".chat-review-thumb").map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    const optional = { items: [{ item: "sesame-seeds", name: "Sesame seeds", quantity: "", recipes: [{ slug: "satay-salmon", title: "Satay Salmon", image: page("images/recipes/satay-salmon.jpg") }] }, { item: "chilli-oil", name: "Chilli oil", quantity: "5ml", recipes: [{ slug: "air-fried-salmon", title: "Air-Fried Salmon", image: "" }] }] };
    route("POST", API, ({ body }) => (body.action === "review_drafts" ? sse([["meta", { conversation_id: CONV, turn_id: "t3" }], ["text", { delta: "One more thing." }], ["optional", optional], ["done", { suggestions: false }]]) : undefined));
    await click($(".chat-review-done"));
    expect(lastSent().body).toMatchObject({ message: "Liked: Pea Soup. Kept for the coming week: Rice.", action: "review_drafts", answers: { "pea-soup": "liked" } });
    expect($(".chat-review:not(.chat-optional)")!.className).toBe("chat-review is-old");
    expect(($(".chat-review.is-old .chat-review-thumb") as HTMLButtonElement).disabled).toBe(true);
    expect($$(".chat-optional-tick").map((t) => t.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect($$(".chat-optional-row .chat-review-sub").map((s) => s.textContent)).toEqual(["for Satay Salmon", "5ml · for Air-Fried Salmon"]);
    await click($('[aria-label="Keep Chilli oil"]'));
    expect($$(".chat-optional-row")[1].className).toBe("chat-review-row chat-optional-row is-off");
    route("GET", `${API}/plan`, json(trayOf([newItem], { can_save: true, state: "ready", list_current: true })));
    route("POST", API, ({ body }) => (body.action === "review_optional" ? sse([["meta", { conversation_id: CONV, turn_id: "t4" }], ["text", { delta: "Ready to save." }], ["suggestions", { replies: [{ label: "Save to site", action: "apply_plan" }] }], ["done", { suggestions: true }]]) : undefined));
    await click($(".chat-optional .chat-review-done"));
    expect(lastSent().body).toMatchObject({ message: "Leaving off: chilli oil.", action: "review_optional", answers: { "sesame-seeds": "keep", "chilli-oil": "drop" } });
    expect(text(".tray-go")).toBe("Save to site (1)");
    expect(text('.chat-chip.is-action[data-action="apply_plan"]')).toBe("Save to site (1)");
    route("POST", `${API}/plan/apply`, json({ summary: "Saved: New: Test Pasta (draft), planned for next week.", cards: [{ slug: "test-pasta", publishing: true, title: "Test Pasta", image: "", url: page("recipes/test-pasta.html"), kicker: { kind: "draft", label: "Draft" }, meta: "" }] }));
    route("GET", `${API}/plan`, json({ tray: null, reading: [] }));
    await click($(".chat-chip.is-action"));
    expect(requests.find((r) => r.path === "/chat/plan/apply")!.body).toEqual({ conversation_id: CONV });
    const saved = $$(".chat-msg").at(-1)!;
    expect(saved.querySelector(".chat-body")!.textContent).toBe("Saved: New: Test Pasta (draft), planned for next week.");
    expect(saved.querySelector(".chat-card")!.className).toBe("tile chat-card is-publishing");
    expect(saved.querySelector(".chat-card .kicker")!.textContent).toBe("Publishing…");
    expect($(".chat-tray")!.hidden).toBe(true);
  });

  it("a clash at Save asks the bot about it; Save now on a quick fix; a failed Save says nothing was changed", async () => {
    const edit = { id: "abcdef13", kind: "edit", title: "Soup", sub: "time 35 min", added_by: "Petro", save_now: true, recipe: { url: page("recipes/soup.html"), image: page("images/recipes/soup.jpg") } };
    route("GET", `${API}/plan`, json(trayOf([edit], { can_save: true, needs_list: false })));
    await mount();
    await click($(".chat-bubble"));
    expect($(".tray-thumb img")!.getAttribute("src")).toBe(page("images/recipes/soup.jpg"));
    route("POST", `${API}/plan/apply`, ({ body }) => (body.item_id ? json({ summary: "Saved: Updated Soup (time)", cards: [] }) : json({ clash: [{ reason: "Soup changed on the site" }] }, 409)));
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t5" }], ["text", { delta: "Let's sort it." }], ["done", { suggestions: false }]]));
    await click($(".tray-go"));
    await settle();
    expect(requests.filter((r) => r.method === "POST" && r.path === "/chat").at(-1)!.body.message).toBe("Saving hit a clash: Soup changed on the site. Help me resolve it.");
    await click($$(".tray-link").find((b) => b.textContent === "Save now")!);
    expect(requests.filter((r) => r.path === "/chat/plan/apply").at(-1)!.body).toEqual({ item_id: "abcdef13", conversation_id: CONV });
    expect($$(".chat-msg").at(-1)!.textContent).toBe("Saved: Updated Soup (time)");
    route("POST", `${API}/plan/apply`, () => Promise.reject(new TypeError("Failed to fetch")));
    await click($(".tray-go"));
    expect(text(".tray-msg")).toBe("Couldn't save just now. Nothing was changed.");
  });

  it("someone else's photos being read show on the strip, with nothing staged", async () => {
    route("GET", `${API}/plan`, json({ tray: null, reading: [{ name: "Sam", count: 3 }] }));
    await mount();
    await click($(".chat-bubble"));
    expect($(".chat-tray")!.hidden).toBe(false);
    expect($$(".chat-tray > *").map((e) => e.className)).toEqual(["tray-reading"]);
    expect(text(".tray-reading-line")).toBe("Reading 3 photos · Sam");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("photos (editors)", () => {
  beforeEach(() => {
    signedIn();
    sessionStorage.setItem("recipes-chat-visit", "1");
    route("GET", `${API}/me`, json({ signedIn: true, email: "owner@example.com", role: "editor" }));
    route("GET", `${API}/plan`, json({ tray: null, reading: [] }));
    // happy-dom decodes no images: a picked photo "loads" as 2000x1000 and the canvas makes a small JPEG
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${origin()}/${Math.random().toString(36).slice(2)}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    class FakeImage {
      naturalWidth = 2000;
      naturalHeight = 1000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ fillRect() {}, drawImage() {}, fillStyle: "" }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => "data:image/jpeg;base64,AAAA");
  });
  const pick = async (n: number, kind = "image/jpeg") => {
    const files = Array.from({ length: n }, (_, i) => new File(["x"], `p${i}.jpg`, { type: kind }));
    const input = $<HTMLInputElement>(".chat-file")!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle(10);
  };

  it("each picked photo is uploaded at once (the first makes the chat); the message goes with their paths; the numbers come back as badges", async () => {
    let uploads = 0;
    route("POST", `${API}/uploads`, ({ body }) => json({ conversation_id: CONV, path: `${CONV}/${++uploads}.jpg`, got: body.conversation_id ?? null }));
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, messages: [], photos: null }));
    await mount();
    await click($(".chat-bubble"));
    await pick(2);
    const ups = requests.filter((r) => r.path === "/chat/uploads");
    expect(ups.map((u) => u.body.conversation_id)).toEqual([undefined, CONV]); // the second waited for the chat the first made
    expect(ups[0].body.image).toBe("data:image/jpeg;base64,AAAA");
    expect($(".chat-attachments")!.hidden).toBe(false);
    expect($$(".chat-attachment").map((a) => [a.className, a.querySelector(".chat-photo-num")!.textContent])).toEqual([["chat-attachment", "1"], ["chat-attachment", "2"]]);
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t1" }], ["photos", { numbers: [1, 2] }], ["text", { delta: "Reading them." }], ["done", { suggestions: false }]]));
    await submit("");
    const sent = requests.find((r) => r.method === "POST" && r.path === "/chat")!;
    expect(sent.body).toMatchObject({ conversation_id: CONV, message: "", image_paths: [`${CONV}/1.jpg`, `${CONV}/2.jpg`] });
    expect(sent.body.images).toBeUndefined();
    expect($(".chat-attachments")!.hidden).toBe(true);
    expect($$(".chat-shot .chat-photo-num").map((b) => b.textContent)).toEqual(["1", "2"]);
    expect($$(".chat-shot").map((s) => s.getAttribute("aria-label"))).toEqual(["Enlarge photo 1", "Enlarge photo 2"]);
    // tapped, a photo fills the panel; a tap or Escape goes back to it
    await click($$(".chat-shot")[1]);
    expect($(".chat-viewer")).not.toBeNull();
    expect(text(".chat-viewer .chat-photo-num")).toBe("2");
    expect($$(".chat-shot")[1].getAttribute("aria-expanded")).toBe("true");
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect($(".chat-viewer")).toBeNull();
    expect($(".chat-panel")!.hidden, "Escape closed the photo, not the panel").toBe(false);
    expect(document.activeElement).toBe($$(".chat-shot")[1]);
  });

  it("at most 8 per message; a failed upload can be retried or removed, and holds the message back", async () => {
    let fail = true;
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, messages: [] }));
    route("POST", `${API}/uploads`, () => (fail ? json({ error: "That photo is too big." }, 413) : json({ conversation_id: CONV, path: `${CONV}/a.jpg` })));
    await mount();
    await click($(".chat-bubble"));
    await pick(9);
    expect($$(".chat-attachment").length).toBe(8);
    expect(text(".chat-attachment-note")).toBe("That photo is too big.");
    expect($<HTMLButtonElement>(".chat-attach")!.disabled).toBe(true);
    expect($$(".chat-attachment.is-failed").length).toBe(8);
    await submit("go");
    expect(text(".chat-attachment-note")).toBe("A photo didn't upload: tap it to try again, or remove it.");
    expect(requests.some((r) => r.method === "POST" && r.path === "/chat")).toBe(false);
    for (let i = 0; i < 7; i++) await click($(".chat-attachment-remove"));
    expect($<HTMLButtonElement>(".chat-attach")!.disabled).toBe(false);
    fail = false;
    await click($("button.chat-attachment-state"));
    expect($$(".chat-attachment").map((a) => a.className)).toEqual(["chat-attachment"]);
  });

  it("only photos can be attached", async () => {
    route("POST", `${API}/uploads`, json({ conversation_id: CONV, path: "x" }));
    await mount();
    await click($(".chat-bubble"));
    await pick(1, "application/pdf");
    expect($$(".chat-attachment").length).toBe(0);
    expect(text(".chat-attachment-note")).toBe("Only photos can be attached.");
  });

  it("a conversation opened on page load while its photos are still being read shows the line and polls until they are", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const shot = `${SB}/storage/v1/object/sign/chat-uploads/a.jpg?token=t`;
    localStorage.setItem("recipes-chat-editor", JSON.stringify({ email: "owner@example.com", id: CONV }));
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, messages: [{ role: "user", content: "", images: [shot], photo_numbers: [1] }], photos: { total: 2, read: 1, reading: 1, active: true } }));
    await mount();
    await click($(".chat-bubble"));
    expect(log()).toEqual(["chat-msg is-user", "chat-status chat-reading"]);
    expect(text(".chat-reading")).toBe("Reading photos… 1 of 2");
    const polls = () => requests.filter((r) => r.path === `/chat/conversations/${CONV}`).length;
    const before = polls();
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, messages: [{ role: "user", content: "", images: [shot], photo_numbers: [1] }, { role: "event", content: "Photos read: 1 recipe" }], photos: null }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(15100))); // scheduled while the panel was still closed: the slower 15 s
    await settle();
    expect(polls()).toBeGreaterThan(before);
    expect(log()).toEqual(["chat-msg is-user", "chat-event"]);
  });

  it("photos being read: after the message, the panel polls and shows the line under the conversation, then the note from the site", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const shot = `${SB}/storage/v1/object/sign/chat-uploads/a.jpg?token=t`;
    route("POST", `${API}/uploads`, json({ conversation_id: CONV, path: `${CONV}/1.jpg` }));
    await mount();
    await click($(".chat-bubble"));
    await pick(1);
    route("POST", API, sse([["meta", { conversation_id: CONV, turn_id: "t1" }], ["photos", { numbers: [1] }], ["text", { delta: "Reading it." }], ["done", { suggestions: false }]]));
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, messages: [{ role: "user", content: "", images: [shot], photo_numbers: [1] }, { role: "assistant", content: "Reading it.", turn_id: "t1" }], photos: { total: 2, read: 1, reading: 1, active: true } }));
    await submit("");
    await act(async () => void (await vi.advanceTimersByTimeAsync(1600))); // soon after the turn
    await settle();
    expect(log()).toEqual(["chat-msg is-user", "chat-msg is-bot", "chat-feedback", "chat-status chat-reading"]);
    expect(text(".chat-reading")).toBe("Reading photos… 1 of 2");
    expect($(".chat-shot img")!.getAttribute("alt")).toBe("Photo 1 you sent");
    route("GET", `${API}/conversations/${CONV}`, json({ id: CONV, messages: [{ role: "user", content: "", images: [shot], photo_numbers: [1] }, { role: "assistant", content: "Reading it.", turn_id: "t1" }, { role: "event", content: "Photos read: 1 recipe" }], photos: null }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5100)));
    await settle();
    expect(log()).toEqual(["chat-msg is-user", "chat-msg is-bot", "chat-feedback is-old", "chat-event"]); // the note is the last message now
    expect(text(".chat-event")).toBe("Photos read: 1 recipe");
  });
});
