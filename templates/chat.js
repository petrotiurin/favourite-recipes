// The recipe chat (docs/chatbot-design.md). A bubble bottom right opens a panel that talks to the backend's POST /chat (the
// script tag's data-api) and streams the answer in. Vanilla JS, no dependencies. It is only ever added to a page when the build
// was given CHAT_API_URL, and with JS off nothing appears.
// Two modes: a visitor's chat (history in this browser, sent with each turn) and a signed-in editor's (templates/auth.js signs
// in; the server owns the history, the client only sends its message and the conversation id; chats list, thumbs up / down).
//
// Safety: model text never goes through innerHTML. A tiny renderer turns it into DOM nodes (paragraphs, bold, lists,
// links), and a link is only made a link when it points at this site's own origin; anything else shows as plain text.
(function () {
  "use strict";

  // ---------------------------------------------------------------------------------------------------------------
  // Safe renderer: text -> blocks -> DOM. Pure functions first (they are unit-tested in node).
  // ---------------------------------------------------------------------------------------------------------------

  /** An absolute URL string if href points at `origin` over http(s), else null. */
  function safeHref(href, origin, base) {
    try {
      var url = new URL(String(href), base || origin + "/");
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin === origin ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  var INLINE_SRC = "\\*\\*([^*]+?)\\*\\*|\\[([^\\]]+)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\)";

  /** Inline nodes: { t: "text", v } | { t: "bold", c: [nodes] } | { t: "link", href, label } | { t: "br" }. */
  function parseInline(text) {
    var nodes = [];
    var last = 0;
    var m;
    var re = new RegExp(INLINE_SRC, "g"); // a fresh one per call: bold content is parsed recursively
    while ((m = re.exec(text))) {
      if (m.index > last) nodes.push({ t: "text", v: text.slice(last, m.index) });
      if (m[1] !== undefined) nodes.push({ t: "bold", c: parseInline(m[1]) });
      else nodes.push({ t: "link", href: m[3], label: m[2] });
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push({ t: "text", v: text.slice(last) });
    return nodes;
  }

  function parseLines(lines) {
    var out = [];
    lines.forEach(function (line, i) {
      if (i) out.push({ t: "br" });
      out = out.concat(parseInline(line));
    });
    return out;
  }

  /** Blocks: { type: "p", nodes } | { type: "ul" | "ol", items: [nodes] }. Headings become bold paragraphs. */
  function parseBlocks(text) {
    var blocks = [];
    var para = [];
    var list = null;
    function flushPara() {
      if (para.length) blocks.push({ type: "p", nodes: parseLines(para) });
      para = [];
    }
    function flushList() {
      list = null;
    }
    String(text)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .forEach(function (raw) {
        var line = raw.replace(/\s+$/, "");
        var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        var number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (!line.trim()) {
          flushPara();
          flushList();
        } else if (bullet || number) {
          flushPara();
          var type = bullet ? "ul" : "ol";
          if (!list || list.type !== type) {
            list = { type: type, items: [] };
            blocks.push(list);
          }
          list.items.push(parseInline((bullet || number)[1]));
        } else if (heading) {
          flushPara();
          flushList();
          blocks.push({ type: "p", nodes: [{ t: "bold", c: parseInline(heading[1]) }] });
        } else {
          flushList();
          para.push(line.trim());
        }
      });
    flushPara();
    return blocks;
  }

  function inlineToDom(doc, nodes, origin, parent) {
    nodes.forEach(function (n) {
      if (n.t === "text") parent.appendChild(doc.createTextNode(n.v));
      else if (n.t === "br") parent.appendChild(doc.createElement("br"));
      else if (n.t === "bold") {
        var b = doc.createElement("strong");
        inlineToDom(doc, n.c, origin, b);
        parent.appendChild(b);
      } else if (n.t === "link") {
        var href = safeHref(n.href, origin);
        if (href) {
          var a = doc.createElement("a");
          a.setAttribute("href", href);
          a.textContent = n.label;
          parent.appendChild(a);
        } else {
          parent.appendChild(doc.createTextNode(n.label)); // someone else's site: the label, never a link
        }
      }
    });
  }

  /** Replaces the children of `el` with the rendered text. Builds nodes with createElement/textContent only. */
  function renderInto(doc, el, text, origin) {
    while (el.firstChild) el.removeChild(el.firstChild);
    parseBlocks(text).forEach(function (block) {
      if (block.type === "p") {
        var p = doc.createElement("p");
        inlineToDom(doc, block.nodes, origin, p);
        el.appendChild(p);
      } else {
        var list = doc.createElement(block.type);
        block.items.forEach(function (item) {
          var li = doc.createElement("li");
          inlineToDom(doc, item, origin, li);
          list.appendChild(li);
        });
        el.appendChild(list);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // History in this browser (anonymous): last ~20 turns, dropped after 2 weeks.
  // ---------------------------------------------------------------------------------------------------------------

  var STORE_KEY = "recipes-chat";
  var MAX_STORED = 40; // messages kept (about 20 exchanges)
  var MAX_SENT = 20; // messages sent to the server each turn
  var MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

  /**
   * The history as the server wants it: text only, starting with a user turn, roles alternating. A user message whose reply failed
   * stays visible in the panel, so two user turns can follow each other; they are merged into one here.
   */
  function wellFormed(messages) {
    var out = [];
    messages.forEach(function (m) {
      if (!m.content) return;
      var prev = out[out.length - 1];
      if (prev && prev.role === m.role) prev.content += "\n\n" + m.content;
      else if (prev || m.role === "user") out.push({ role: m.role, content: m.content });
    });
    return out;
  }

  /** Suggested replies: a string (sent as the next message) or { label, url } (opens a page on this site). Anything else is dropped. */
  function cleanReplyItems(list, origin) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (r) {
      if (out.length >= 4) return;
      if (typeof r === "string") {
        if (r) out.push(r);
      } else if (r && typeof r === "object" && typeof r.label === "string" && r.label) {
        var href = origin ? safeHref(r.url, origin) : null;
        if (href) out.push({ label: r.label.slice(0, 60), url: href });
      }
    });
    return out;
  }

  var KICKER_KINDS = { this: "kicker-current", next: "kicker-next", draft: "kicker-draft", "": "" };

  /** Recipe cards from the server: strings only, links and photos only on this site's origin, at most 8. */
  function cleanCards(list, origin) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (out.length >= 8 || !c || typeof c !== "object" || typeof c.title !== "string" || !c.title) return;
      var url = safeHref(c.url, origin);
      if (!url) return;
      var kind = c.kicker && Object.prototype.hasOwnProperty.call(KICKER_KINDS, c.kicker.kind) ? c.kicker.kind : "";
      out.push({
        title: c.title.slice(0, 120),
        url: url,
        image: typeof c.image === "string" && c.image ? safeHref(c.image, origin) || "" : "",
        kicker: { kind: kind, label: c.kicker && typeof c.kicker.label === "string" ? c.kicker.label.slice(0, 40) : "" },
        meta: typeof c.meta === "string" ? c.meta.slice(0, 40) : "",
      });
    });
    return out;
  }

  /** A navigation button from the server: { label, url } on this site's origin, or null. */
  function cleanNav(nav, origin) {
    if (!nav || typeof nav !== "object" || typeof nav.label !== "string" || !nav.label) return null;
    var url = safeHref(nav.url, origin);
    return url ? { label: nav.label.slice(0, 60), url: url } : null;
  }

  /** Starter chips for an empty chat, by page (they are sent as the user's first message). */
  function startersFor(page, editor) {
    return (
      {
        // "Add to next week" invites a write, which only a signed-in editor's chat can do.
        recipe: editor ? ["Swap an ingredient", "Scale it for 6", "Add to next week"] : ["Swap an ingredient", "Scale it for 6", "What goes with it?"],
        index: ["Something quick tonight", "Light and healthy"],
        "next-week": ["What's planned?"],
        shopping: ["What's left to buy?"],
      }[page] || []
    );
  }

  function cleanHistory(raw, now, origin) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.messages)) return null;
    if (!(now - Number(raw.updated) < MAX_AGE_MS)) return null;
    var messages = [];
    raw.messages.forEach(function (m) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return;
      var out = { role: m.role, content: m.content };
      if (m.role === "assistant") {
        var replies = cleanReplyItems(m.replies, origin);
        if (replies.length) out.replies = replies;
        var cards = origin ? cleanCards(m.cards, origin) : [];
        if (cards.length) out.cards = cards;
        var nav = origin ? cleanNav(m.nav, origin) : null;
        if (nav) out.nav = nav;
      }
      if (out.content || out.cards) messages.push(out);
    });
    return { id: typeof raw.id === "string" ? raw.id : null, updated: raw.updated, messages: messages.slice(-MAX_STORED) };
  }

  var FEEDBACK_REASONS = ["Wrong recipe", "Didn't do what I asked", "Wrong amounts", "Too slow", "Something else"];

  /** A signed-in editor's chat as the server returns it (GET /chat/conversations/:id): same cleaning as the local history, plus the turn id and feedback. */
  function cleanServerMessages(list, origin) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (m) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return;
      var msg = { role: m.role, content: m.content };
      if (m.role === "assistant") {
        var replies = cleanReplyItems(m.replies, origin);
        if (replies.length) msg.replies = replies;
        var cards = cleanCards(m.cards, origin);
        if (cards.length) msg.cards = cards;
        var nav = cleanNav(m.nav, origin);
        if (nav) msg.nav = nav;
        if (typeof m.turn_id === "string" && m.turn_id) msg.turn_id = m.turn_id.slice(0, 64);
        if (m.feedback && (m.feedback.value === 1 || m.feedback.value === 0)) {
          msg.feedback = {
            value: m.feedback.value,
            reasons: (Array.isArray(m.feedback.reasons) ? m.feedback.reasons : []).filter(function (r) { return FEEDBACK_REASONS.indexOf(r) !== -1; }),
            note: typeof m.feedback.note === "string" ? m.feedback.note.slice(0, 300) : "",
          };
        }
      }
      if (msg.content || msg.cards) out.push(msg);
    });
    return out;
  }

  var DAY = 24 * 60 * 60 * 1000;
  function dayStart(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  /** "Today" / "Yesterday" / "Mon 2 Nov" for when a chat was last updated. */
  function updatedLabel(iso, now) {
    var d = new Date(iso);
    var diff = Math.round((dayStart(new Date(now)) - dayStart(d)) / DAY);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  /** "until Sat" for when a chat goes away (with the date once it is more than a week off, so the weekday isn't ambiguous). */
  function expiryLabel(iso, now) {
    var d = new Date(iso);
    var days = Math.round((dayStart(d) - dayStart(new Date(now))) / DAY);
    if (days <= 0) return "until today";
    if (days === 1) return "until tomorrow";
    return "until " + d.toLocaleDateString(undefined, days > 6 ? { weekday: "short", day: "numeric", month: "short" } : { weekday: "short" });
  }
  /** What the chats list shows under a title: "Today · until Sat". */
  function chatMeta(conv, now) {
    return updatedLabel(conv.updated_at, now) + " · " + expiryLabel(conv.expires_at, now);
  }
  /** The one line next to the thumbs once feedback is given: "Thanks" for up, "Sent: Wrong amounts" / "Sent" after the box, else "". */
  function feedbackNote(fb, sent) {
    if (!fb) return "";
    if (fb.value === 1) return "Thanks";
    if (!sent) return "";
    return fb.reasons && fb.reasons.length ? "Sent: " + fb.reasons.join(", ") : "Sent";
  }

  var api = {
    cleanServerMessages: cleanServerMessages,
    updatedLabel: updatedLabel,
    expiryLabel: expiryLabel,
    chatMeta: chatMeta,
    feedbackNote: feedbackNote,
    FEEDBACK_REASONS: FEEDBACK_REASONS,
    safeHref: safeHref,
    parseInline: parseInline,
    parseBlocks: parseBlocks,
    renderInto: renderInto,
    cleanHistory: cleanHistory,
    cleanReplyItems: cleanReplyItems,
    cleanCards: cleanCards,
    cleanNav: cleanNav,
    startersFor: startersFor,
    wellFormed: wellFormed,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // node (tests)
    return;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The widget
  // ---------------------------------------------------------------------------------------------------------------

  var script = document.currentScript;
  var apiUrl = script && script.getAttribute("data-api");
  if (!apiUrl) return;

  var doc = document;
  var origin = location.origin;
  var CTX = (function () {
    try {
      return JSON.parse(doc.getElementById("page-context").textContent) || {};
    } catch (e) {
      return {};
    }
  })();

  var ICON = {
    chat: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    arrow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
    send: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    list: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    up: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9z"/><path d="M7 11l4-7c1.7 0 2.5 1.2 2.2 2.8L12.6 10H19a1.8 1.8 0 0 1 1.8 2.1l-1.3 6.4A2 2 0 0 1 17.5 20H7"/></svg>',
    down: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 13V4H4v9z"/><path d="M7 13l4 7c1.7 0 2.5-1.2 2.2-2.8L12.6 14H19a1.8 1.8 0 0 0 1.8-2.1l-1.3-6.4A2 2 0 0 0 17.5 4H7"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
  };

  function el(tag, cls, attrs) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }
  function iconButton(cls, label, svg) {
    var b = el("button", cls, { type: "button", "aria-label": label });
    b.innerHTML = svg; // our own constant markup, never model text
    return b;
  }

  // --- state -------------------------------------------------------------------------------------------------------
  function readJson(storage, key) {
    try {
      return JSON.parse(storage.getItem(key));
    } catch (e) {
      return null;
    }
  }
  function writeJson(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // not remembered, the chat still works
    }
  }
  function rememberEditorChat() {
    writeJson(localStorage, EDITOR_KEY, chat.server && chat.id ? { email: me.email, id: chat.id } : null);
  }
  function newId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function loadChat() {
    try {
      var h = cleanHistory(JSON.parse(localStorage.getItem(STORE_KEY)), Date.now(), origin);
      if (h) return { id: h.id || newId(), messages: h.messages };
    } catch (e) {
      // no storage, or it holds something else: start fresh
    }
    return { id: newId(), messages: [] };
  }
  var RA = window.RecipeAuth || null; // present only when the build has Supabase sign-in (templates/auth.js)
  var apiBase = apiUrl.replace(/\/+$/, "");
  var anonChat = loadChat(); // the visitor's chat, kept in this browser
  var chat = anonChat; // what the panel shows: anonChat, or an editor's server chat { server: true, id (server id or null), messages }
  var mode = "public"; // "public" | "editor" (decided by the server from the token: GET /chat/me)
  var me = { signedIn: false, email: "" };
  var checkingMe = !!(RA && RA.getSession()); // until /chat/me has answered we don't know which chat to show
  var listing = false; // the chats list is open
  var EDITOR_KEY = "recipes-chat-editor"; // { email, id }: the editor's open conversation (an id only; the messages live on the server)
  var PENDING_KEY = "recipes-chat-signin"; // set when the sign-in sheet is opened from the chat: { t, open, draft }
  function saveChat() {
    if (chat.server) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ id: chat.id, updated: Date.now(), messages: chat.messages.slice(-MAX_STORED) }));
    } catch (e) {
      // private mode or full: the chat still works, it just isn't remembered
    }
  }

  // What belongs to this tab's visit, not to the conversation: whether the panel is open, which conversation, an unsent draft.
  // It lives in sessionStorage, so a full page load (tapping a card or a button) reopens the panel where it was.
  var UI_KEY = "recipes-chat-ui";
  function loadUi() {
    try {
      var v = JSON.parse(sessionStorage.getItem(UI_KEY));
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  }
  function saveUi() {
    try {
      sessionStorage.setItem(UI_KEY, JSON.stringify({ open: !panel.hidden, id: chat.id, draft: input.value.slice(0, 2000) }));
    } catch (e) {
      // not remembered, the chat still works
    }
  }

  var contextDismissed = false;
  var streaming = null; // { abort }

  // --- DOM ---------------------------------------------------------------------------------------------------------
  var bubble = el("button", "chat-bubble", { type: "button", "aria-label": "Chat about recipes", "aria-expanded": "false", "aria-controls": "chat-panel" });
  bubble.innerHTML = ICON.chat + '<span class="chat-dot" hidden></span>';
  var dot = bubble.querySelector(".chat-dot");

  var panel = el("section", "chat-panel", { id: "chat-panel", role: "dialog", "aria-label": "Recipe chat" });
  panel.hidden = true;
  var head = el("header", "chat-head");
  var title = el("h2", "chat-title");
  title.textContent = "Recipe chat";
  var chatsBtn = iconButton("chat-icon-btn chat-chats-btn", "Your chats", ICON.list);
  chatsBtn.setAttribute("aria-expanded", "false");
  chatsBtn.hidden = true; // editors only
  var newBtn = el("button", "text-button chat-new", { type: "button" });
  newBtn.textContent = "New chat";
  var accountWrap = el("div", "chat-account"); // the Sign in button, or the avatar and its menu (templates/auth.js)
  accountWrap.hidden = !RA;
  var closeBtn = iconButton("icon-button chat-close", "Close chat", ICON.close);
  head.appendChild(title);
  head.appendChild(chatsBtn);
  head.appendChild(newBtn);
  head.appendChild(accountWrap);
  head.appendChild(closeBtn);
  if (RA) RA.renderAccount(accountWrap, { compact: true });

  var banner = el("p", "chat-banner"); // "Signed in as x - this account can't edit, so the chat is read-only."
  banner.hidden = true;
  var chatsView = el("div", "chat-chats"); // the chats list, in place of the log while open
  chatsView.hidden = true;

  var log = el("div", "chat-log", { role: "log", "aria-live": "polite", "aria-label": "Conversation" });
  var foot = el("div", "chat-foot");
  var ctxChip = el("div", "chat-context");
  ctxChip.hidden = true;
  var ctxLabel = el("span", "chat-context-label");
  var ctxClose = iconButton("chat-context-close", "Don't use this page as context", ICON.close);
  ctxChip.appendChild(ctxLabel);
  ctxChip.appendChild(ctxClose);
  var form = el("form", "chat-form");
  var input = el("textarea", "chat-input", { rows: "1", placeholder: "Ask about our recipes", "aria-label": "Message", maxlength: "2000", enterkeyhint: "send", autocomplete: "off" });
  var sendBtn = iconButton("chat-send", "Send", ICON.send);
  sendBtn.type = "submit";
  form.appendChild(input);
  form.appendChild(sendBtn);
  foot.appendChild(ctxChip);
  foot.appendChild(form);
  panel.appendChild(head);
  panel.appendChild(banner);
  panel.appendChild(chatsView);
  panel.appendChild(log);
  panel.appendChild(foot);
  doc.body.appendChild(panel);
  doc.body.appendChild(bubble);

  // --- rendering ----------------------------------------------------------------------------------------------------
  var statusEl = null;
  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }
  function toBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function intro() {
    var p = el("div", "chat-intro");
    var a = el("p");
    a.textContent = "Ask me about our recipes: what to cook, what's in something, what to swap.";
    var b = el("p", "chat-note");
    b.textContent =
      mode === "editor"
        ? "Your chats are saved to your account for two weeks after the last message, on any of your devices. I can look things up, but I can't change anything on the site yet."
        : "Chats are stored in this browser for two weeks. I can look things up, but I can't change anything on the site.";
    p.appendChild(a);
    p.appendChild(b);
    var starters = startersFor(CTX.page === "recipe" && contextDismissed ? "" : CTX.page, mode === "editor");
    if (starters.length) {
      var row = chipsEl(starters);
      row.classList.add("chat-starters");
      p.appendChild(row);
    }
    return p;
  }

  /** Cards stay put while a reply is still streaming: a tap then would drop the answer on the floor. */
  function guardWhileStreaming(a) {
    a.addEventListener("click", function (e) {
      if (streaming || a.getAttribute("aria-disabled") === "true") e.preventDefault();
      else saveUi();
    });
  }

  function cardsEl(cards) {
    var row = el("div", "chat-cards", { role: "list", "aria-label": "Recipes" });
    cards.forEach(function (c) {
      var a = el("a", "tile chat-card", { href: c.url, role: "listitem" });
      if (c.image) {
        var img = el("img", "tile-image", { src: c.image, alt: "", loading: "lazy" });
        a.appendChild(img);
      } else a.appendChild(el("span", "tile-image"));
      var k = el("p", "kicker" + (KICKER_KINDS[c.kicker.kind] ? " " + KICKER_KINDS[c.kicker.kind] : ""));
      k.textContent = c.kicker.label;
      var t = el("h3", "tile-title");
      t.textContent = c.title;
      var meta = el("p", "tile-meta");
      meta.textContent = c.meta;
      a.appendChild(k);
      a.appendChild(t);
      a.appendChild(meta);
      guardWhileStreaming(a);
      row.appendChild(a);
    });
    return row;
  }

  function setCards(wrap, cards) {
    var old = wrap.querySelector(".chat-cards");
    if (old) wrap.removeChild(old);
    if (cards && cards.length) {
      var nav0 = wrap.querySelector(".chat-nav");
      var row = cardsEl(cards);
      if (nav0) wrap.insertBefore(row, nav0);
      else wrap.appendChild(row);
    }
  }

  /** The "Open Steamed Rice" button: a plain link the user has to tap. Only shown once the reply is complete. */
  function navEl(nav) {
    var a = el("a", "chat-nav", { href: nav.url });
    a.appendChild(doc.createTextNode(nav.label));
    var arrow = el("span", "chat-nav-arrow");
    arrow.innerHTML = ICON.arrow; // our own constant markup
    a.appendChild(arrow);
    guardWhileStreaming(a);
    return a;
  }

  function messageEl(m, live) {
    var wrap = el("div", "chat-msg " + (m.role === "user" ? "is-user" : "is-bot"));
    var body = el("div", "chat-body");
    if (m.role === "user") body.textContent = m.content;
    else renderInto(doc, body, m.content, origin);
    wrap.appendChild(body);
    if (m.role !== "user") {
      if (m.cards && m.cards.length) setCards(wrap, m.cards);
      if (live && m.nav) wrap.appendChild(navEl(m.nav));
    }
    return wrap;
  }

  /** Suggested replies: a plain string sends it as the next message, { label, url } is a link to a page on this site. */
  function chipsEl(replies) {
    var row = el("div", "chat-chips");
    replies.forEach(function (r) {
      var chip;
      if (typeof r === "string") {
        chip = el("button", "chat-chip", { type: "button" });
        chip.textContent = r;
        chip.addEventListener("click", function () {
          if (!row.classList.contains("is-old")) send(r);
        });
      } else {
        chip = el("a", "chat-chip is-nav", { href: r.url });
        chip.appendChild(doc.createTextNode(r.label));
        var arrow = el("span", "chat-nav-arrow");
        arrow.innerHTML = ICON.arrow;
        chip.appendChild(arrow);
        chip.addEventListener("click", function (e) {
          if (streaming || row.classList.contains("is-old")) e.preventDefault();
          else saveUi();
        });
      }
      row.appendChild(chip);
    });
    return row;
  }

  /** Only the last message's chips and button are live; older ones fade and stop responding. */
  function retireChips() {
    Array.prototype.forEach.call(log.querySelectorAll(".chat-chips, .chat-nav"), function (row) {
      row.classList.add("is-old");
      row.setAttribute("aria-disabled", "true");
      Array.prototype.forEach.call(row.querySelectorAll("button, a"), function (b) {
        if (b.tagName === "BUTTON") b.disabled = true;
        else {
          b.setAttribute("aria-disabled", "true");
          b.setAttribute("tabindex", "-1");
        }
      });
      if (row.tagName === "A") row.setAttribute("tabindex", "-1");
    });
  }

  function renderAll() {
    while (log.firstChild) log.removeChild(log.firstChild);
    statusEl = null;
    if (checkingMe) {
      var wait = el("p", "chat-status", { role: "status" });
      wait.textContent = "Checking your sign-in…";
      log.appendChild(wait);
      return;
    }
    if (!chat.messages.length) log.appendChild(intro());
    chat.messages.forEach(function (m, i) {
      var last = i === chat.messages.length - 1;
      log.appendChild(messageEl(m, last));
      if (mode === "editor" && chat.server && m.role === "assistant" && m.turn_id) log.appendChild(feedbackEl(m, !last));
      if (m.replies && m.replies.length && last) log.appendChild(chipsEl(m.replies));
    });
    toBottom();
  }

  function setStatus(text) {
    if (!statusEl) {
      statusEl = el("p", "chat-status", { role: "status" });
      log.appendChild(statusEl);
    }
    statusEl.textContent = text;
    statusEl.hidden = !text;
    toBottom();
  }
  function clearStatus() {
    if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);
    statusEl = null;
  }
  function showError(text) {
    clearStatus();
    var box = el("p", "chat-error", { role: "alert" });
    box.textContent = text;
    log.appendChild(box);
    toBottom();
  }

  // --- page context chip -----------------------------------------------------------------------------------------------
  function contextLabel() {
    if (CTX.page === "recipe" && CTX.title) return CTX.title;
    return { index: "The recipe list", "next-week": "Next week", shopping: "Shopping list" }[CTX.page] || "";
  }
  function paintContext() {
    var label = contextLabel();
    ctxChip.hidden = !label || contextDismissed;
    ctxLabel.textContent = "On: " + label;
  }

  /** The page context baked in at build time plus the live UI state that matters. Untrusted: the server re-resolves it. */
  function pageState() {
    if (contextDismissed) return { page: CTX.page, dismissed: true };
    var state = { page: CTX.page };
    if (CTX.page === "recipe") {
      state.slug = CTX.slug;
      var pressed = doc.querySelector('.servings-picker [aria-pressed="true"]');
      var n = pressed ? parseInt(pressed.getAttribute("data-serves"), 10) : NaN;
      if (n > 0) state.servings = n;
    } else if (CTX.page === "index") {
      var search = doc.getElementById("recipe-search");
      if (search && search.value.trim()) state.search = search.value.trim();
      var checked = doc.querySelector(".filter-input:checked");
      var label = checked && doc.querySelector('label[for="' + checked.id + '"]');
      if (label && label.textContent.trim() !== "All") state.filter = label.textContent.trim();
    }
    return state;
  }

  // --- talking to /chat ----------------------------------------------------------------------------------------------------
  function setBusy(busy) {
    sendBtn.disabled = busy;
    panel.classList.toggle("is-busy", busy);
    input.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function parseEvent(block) {
    var name = "message";
    var data = [];
    block.split("\n").forEach(function (line) {
      if (line.indexOf("event:") === 0) name = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data.push(line.slice(5).replace(/^ /, ""));
    });
    try {
      return { name: name, data: JSON.parse(data.join("\n")) };
    } catch (e) {
      return null;
    }
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text || streaming || checkingMe) return;
    retireChips();
    Array.prototype.forEach.call(log.querySelectorAll(".chat-feedback"), function (f) { f.classList.add("is-old"); }); // earlier turns keep their thumbs, dimmed
    var editorTurn = mode === "editor" && chat.server;
    clearStatus();
    var intro0 = log.querySelector(".chat-intro");
    if (intro0) log.removeChild(intro0);
    Array.prototype.forEach.call(log.querySelectorAll(".chat-error"), function (e) { e.parentNode.removeChild(e); });

    chat.messages.push({ role: "user", content: text });
    log.appendChild(messageEl({ role: "user", content: text }));
    saveChat();
    input.value = "";
    autosize();
    saveUi();

    var reply = { role: "assistant", content: "" };
    var botEl = messageEl(reply);
    var botBody = botEl.querySelector(".chat-body");
    var added = false;
    var controller = new AbortController();
    var mine = { abort: function () { controller.abort(); } };
    streaming = mine;
    setBusy(true);
    setStatus("Thinking…");

    function ensureAdded() {
      if (!added) {
        added = true;
        log.insertBefore(botEl, statusEl);
      }
    }
    function onText(delta) {
      ensureAdded();
      if (statusEl) statusEl.hidden = true;
      var stick = atBottom();
      reply.content += delta;
      renderInto(doc, botBody, reply.content, origin);
      if (stick) toBottom();
    }
    function finish(ok) {
      if (streaming !== mine) return; // "New chat" already replaced this conversation
      streaming = null;
      setBusy(false);
      clearStatus();
      if (ok && (reply.content.trim() || (reply.cards && reply.cards.length))) {
        chat.messages.push(reply);
        saveChat();
        if (reply.nav) {
          ensureAdded();
          botEl.appendChild(navEl(reply.nav));
        }
        if (editorTurn && reply.turn_id) log.appendChild(feedbackEl(reply, false));
        if (reply.replies && reply.replies.length) log.appendChild(chipsEl(reply.replies));
        if (panel.hidden) dot.hidden = false;
      } else if (added && botEl.parentNode) {
        // a partial answer that errored out is not kept in the history
        botEl.classList.add("is-partial");
      }
      toBottom();
    }

    // An editor sends only the new message and the conversation id (the server owns the history); a visitor sends their own.
    var payload = editorTurn
      ? { conversation_id: chat.id || undefined, message: text, page: pageState() }
      : { conversation_id: chat.id, messages: wellFormed(chat.messages.slice(-MAX_SENT)), page: pageState() };
    (editorTurn ? authedFetch : fetch)(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (editorTurn && res.status === 404) {
          chat.id = null; // that conversation is gone (expired or deleted): the next message starts a new one
          rememberEditorChat();
          throw new Error("That chat isn't available any more. Your next message starts a new one.");
        }
        if (!res.ok) {
          return res.json().then(
            function (j) { throw new Error((j && j.error) || "The chat isn't available right now."); },
            function () { throw new Error("The chat isn't available right now."); }
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var failed = null;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buffer += decoder.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
            var i;
            while ((i = buffer.indexOf("\n\n")) !== -1) {
              var ev = parseEvent(buffer.slice(0, i));
              buffer = buffer.slice(i + 2);
              if (!ev) continue;
              if (ev.name === "text") onText(String(ev.data.delta || ""));
              else if (ev.name === "status") setStatus(String(ev.data.text || ""));
              else if (ev.name === "meta") {
                if (typeof ev.data.turn_id === "string") reply.turn_id = ev.data.turn_id.slice(0, 64);
                if (chat.server && typeof ev.data.conversation_id === "string") {
                  chat.id = ev.data.conversation_id;
                  rememberEditorChat();
                  saveUi();
                }
              } else if (ev.name === "title") {
                if (chat.server && ev.data.conversation_id === chat.id && typeof ev.data.title === "string") {
                  chat.title = ev.data.title.slice(0, 80);
                  paintHeader();
                }
              }
              else if (ev.name === "suggestions") reply.replies = cleanReplyItems(ev.data.replies, origin);
              else if (ev.name === "cards") {
                var more = cleanCards(ev.data.cards, origin);
                if (more.length) {
                  ensureAdded();
                  reply.cards = (reply.cards || []).concat(more).slice(0, 8);
                  setCards(botEl, reply.cards);
                  if (statusEl) statusEl.hidden = true;
                  toBottom();
                }
              } else if (ev.name === "navigation") reply.nav = cleanNav(ev.data, origin) || reply.nav;
              else if (ev.name === "error") failed = String(ev.data.message || "Something went wrong with the chat.");
            }
            return pump();
          });
        }
        return pump().then(function () {
          if (failed) throw new Error(failed);
        });
      })
      .then(
        function () { finish(true); },
        function (err) {
          if (err && err.name === "AuthExpired") {
            // The sign-in sheet is open: put the message back so it isn't lost, and keep the panel open through a page-reloading sign-in.
            input.value = text;
            autosize();
            saveUi();
          }
          var stillMine = streaming === mine;
          finish(false);
          if (!stillMine || (err && err.name === "AbortError")) return;
          showError(err && err.message ? err.message : "Something went wrong with the chat.");
        }
      );
  }

  // --- signed-in editors: requests with a token, thumbs up / down, the chats list, switching modes ------------------------------

  function authError() {
    var e = new Error("Your sign-in has expired. Sign in again.");
    e.name = "AuthExpired";
    return e;
  }
  /** Remembers that the sign-in sheet was opened from the chat, so a sign-in that reloads the page (the magic link) reopens the panel with the draft. */
  function markSigninPending() {
    writeJson(localStorage, PENDING_KEY, { t: Date.now(), open: !panel.hidden, draft: input.value.slice(0, 2000) });
  }
  function handlePending() {
    var p = readJson(localStorage, PENDING_KEY);
    writeJson(localStorage, PENDING_KEY, null);
    if (!p || !(Date.now() - Number(p.t) < 30 * 60 * 1000)) return;
    if (p.open && panel.hidden) open({ restore: true });
    if (typeof p.draft === "string" && p.draft && !input.value) {
      input.value = p.draft.slice(0, 2000);
      autosize();
    }
  }
  /**
   * fetch with the signed-in user's token (refreshed when it is about to expire). A 401 refreshes once and retries; if that fails too the
   * session is over: the sign-in sheet opens and the promise rejects with an "AuthExpired" error. Without a session it is a plain fetch.
   */
  function authedFetch(url, opts) {
    opts = opts || {};
    if (!RA || !RA.getSession()) return fetch(url, opts);
    function withToken(token) {
      return fetch(url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { Authorization: "Bearer " + token }) }));
    }
    function expired() {
      markSigninPending();
      RA.sessionExpired("Your sign-in has expired. Sign in again to keep chatting.");
      throw authError();
    }
    return RA.getAccessToken().then(function (token) {
      if (!token) return expired();
      return withToken(token).then(function (res) {
        if (res.status !== 401) return res;
        return RA.refresh().then(function (fresh) {
          if (!fresh) return expired();
          return withToken(fresh).then(function (again) {
            return again.status === 401 ? expired() : again;
          });
        });
      });
    });
  }

  // --- feedback: thumbs up / down under a turn's last message (editors only) ---
  function feedbackEl(m, old) {
    var convId = chat.id;
    var fb = m.feedback || null;
    var sent = !!(fb && fb.value === 0 && ((fb.reasons && fb.reasons.length) || fb.note));
    var picked = fb && fb.reasons ? fb.reasons.slice() : [];
    var row = el("div", "chat-feedback" + (old ? " is-old" : ""));
    var line = el("div", "fb-row");
    var up = iconButton("fb-btn", "Good reply", ICON.up);
    var down = iconButton("fb-btn", "Bad reply", ICON.down);
    var note = el("span", "fb-note", { role: "status" });
    line.appendChild(up);
    line.appendChild(down);
    line.appendChild(note);
    var box = el("div", "fb-box");
    box.hidden = true;
    var q = el("p", "fb-q");
    q.textContent = "What went wrong? (optional)";
    var chips = el("div", "fb-chips");
    FEEDBACK_REASONS.forEach(function (r) {
      var c = el("button", "fb-chip", { type: "button", "aria-pressed": picked.indexOf(r) !== -1 ? "true" : "false" });
      c.textContent = r;
      c.addEventListener("click", function () {
        var at = picked.indexOf(r);
        if (at === -1) picked.push(r);
        else picked.splice(at, 1);
        c.setAttribute("aria-pressed", at === -1 ? "true" : "false");
      });
      chips.appendChild(c);
    });
    var field = el("input", "fb-input", { type: "text", maxlength: "300", placeholder: "Add a note", "aria-label": "Add a note", autocomplete: "off" });
    if (fb && fb.note) field.value = fb.note;
    var actions = el("div", "fb-actions");
    var skip = el("button", "text-button is-quiet", { type: "button" });
    skip.textContent = "Skip";
    var sendBtn2 = el("button", "fb-send", { type: "button" });
    sendBtn2.textContent = "Send";
    actions.appendChild(skip);
    actions.appendChild(sendBtn2);
    box.appendChild(q);
    box.appendChild(chips);
    box.appendChild(field);
    box.appendChild(actions);
    row.appendChild(line);
    row.appendChild(box);

    function paint() {
      up.setAttribute("aria-pressed", fb && fb.value === 1 ? "true" : "false");
      down.setAttribute("aria-pressed", fb && fb.value === 0 ? "true" : "false");
      note.textContent = feedbackNote(fb, sent);
    }
    function post(value) {
      var body = { conversation_id: convId, turn_id: m.turn_id, value: value };
      if (value === 0 && fb) {
        body.reasons = fb.reasons;
        body.note = fb.note;
      }
      authedFetch(apiBase + "/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(
        function (res) {
          if (!res.ok) note.textContent = "Couldn't save that";
        },
        function () {
          note.textContent = "Couldn't save that";
        }
      );
    }
    function choose(value) {
      sent = false;
      box.hidden = true;
      if (fb && fb.value === value) {
        fb = null; // tapping the chosen thumb again takes it back
        m.feedback = null;
        post(null);
      } else {
        fb = { value: value, reasons: [], note: "" };
        picked.length = 0;
        field.value = "";
        Array.prototype.forEach.call(chips.children, function (c) { c.setAttribute("aria-pressed", "false"); });
        m.feedback = fb;
        post(value);
        if (value === 0) box.hidden = false;
      }
      paint();
    }
    up.addEventListener("click", function () { choose(1); });
    down.addEventListener("click", function () { choose(0); });
    skip.addEventListener("click", function () {
      box.hidden = true;
    });
    sendBtn2.addEventListener("click", function () {
      if (!fb || fb.value !== 0) return;
      fb.reasons = picked.slice();
      fb.note = field.value.trim().slice(0, 300);
      m.feedback = fb;
      sent = true;
      box.hidden = true;
      post(0);
      paint();
    });
    paint();
    return row;
  }

  // --- header, modes ---
  function paintHeader() {
    var editor = mode === "editor";
    chatsBtn.hidden = !editor;
    title.textContent = editor && chat.title ? chat.title : "Recipe chat";
    var readOnly = me.signedIn && !editor ? "Signed in as " + me.email + " — this account can't edit, so the chat is read-only." : "";
    banner.textContent = readOnly;
    banner.hidden = !readOnly;
    if (!editor && listing) setListing(false);
  }

  /** Back to the visitor's chat (signed out, expired, or a signed-in account that can't edit). The editor's chat leaves the panel. */
  function goPublic(opts) {
    var keepId = chat.server && chat.id && opts && opts.keepEmail ? { email: opts.keepEmail, id: chat.id } : null;
    if (streaming && chat.server) streaming.abort();
    if (chat.server) {
      streaming = null;
      setBusy(false);
    }
    mode = "public";
    chat = anonChat;
    // An expired session keeps the open conversation's id, so signing in again comes back to it; only an explicit sign-out forgets it.
    writeJson(localStorage, EDITOR_KEY, keepId);
    setListing(false);
    paintHeader();
    renderAll();
  }

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var loadSeq = 0;
  function enterEditor() {
    if (mode === "editor" && chat.server) {
      paintHeader();
      return;
    }
    if (streaming) streaming.abort();
    streaming = null;
    setBusy(false);
    mode = "editor";
    var stored = readJson(localStorage, EDITOR_KEY);
    var wantId = (UUID.test(loadUi().id || "") && loadUi().id) || (stored && stored.email === me.email && UUID.test(stored.id || "") && stored.id) || null;
    chat = { server: true, id: null, title: "", messages: [] };
    paintHeader();
    renderAll();
    if (wantId) loadConversation(wantId);
  }

  function loadConversation(id) {
    var seq = ++loadSeq;
    var wait = el("p", "chat-status", { role: "status" });
    wait.textContent = "Opening your chat…";
    log.appendChild(wait);
    return authedFetch(apiBase + "/conversations/" + encodeURIComponent(id))
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("load");
        return res.json();
      })
      .then(
        function (j) {
          if (seq !== loadSeq || mode !== "editor") return;
          if (!j) {
            chat = { server: true, id: null, title: "", messages: [] }; // expired or deleted: start fresh
            rememberEditorChat();
          } else {
            chat = { server: true, id: j.id, title: String(j.title || "").slice(0, 80), messages: cleanServerMessages(j.messages, origin) };
            rememberEditorChat();
          }
          setListing(false);
          paintHeader();
          renderAll();
          saveUi();
        },
        function (err) {
          if (seq !== loadSeq || (err && err.name === "AuthExpired")) return;
          renderAll();
          showError("Couldn't open that chat. Try again in a moment.");
        }
      );
  }

  /** Asks the server who we are (it decides the role from the token) and shows the matching chat. */
  function refreshMe() {
    if (!RA || !RA.getSession()) {
      me = { signedIn: false, email: "" };
      checkingMe = false;
      goPublic();
      return Promise.resolve();
    }
    checkingMe = true;
    renderAll();
    return authedFetch(apiBase + "/me")
      .then(function (res) {
        if (!res.ok) throw new Error("me");
        return res.json();
      })
      .then(
        function (j) {
          me = { signedIn: !!j.signedIn, email: String(j.email || "") };
          checkingMe = false;
          if (j.role === "editor") enterEditor();
          else goPublic();
        },
        function (err) {
          checkingMe = false;
          if (err && err.name === "AuthExpired") return; // the sign-out event has taken the panel back to the visitor chat
          me = { signedIn: false, email: "" };
          goPublic(); // couldn't reach the server: stay a visitor
        }
      );
  }

  // --- chats list ---
  function setListing(on) {
    listing = !!on;
    panel.classList.toggle("is-listing", listing);
    chatsView.hidden = !listing;
    chatsBtn.setAttribute("aria-expanded", listing ? "true" : "false");
    if (listing) loadList();
  }
  function loadList() {
    while (chatsView.firstChild) chatsView.removeChild(chatsView.firstChild);
    var wait = el("p", "chat-chats-note");
    wait.textContent = "Loading your chats…";
    chatsView.appendChild(wait);
    authedFetch(apiBase + "/conversations")
      .then(function (res) {
        if (!res.ok) throw new Error("list");
        return res.json();
      })
      .then(
        function (j) {
          if (listing) renderList(Array.isArray(j.conversations) ? j.conversations : []);
        },
        function (err) {
          if (!listing || (err && err.name === "AuthExpired")) return;
          wait.textContent = "Couldn't load your chats. Try again in a moment.";
        }
      );
  }
  function renderList(convs) {
    while (chatsView.firstChild) chatsView.removeChild(chatsView.firstChild);
    var h = el("h3", "chat-chats-title");
    h.textContent = "Your chats";
    var note = el("p", "chat-chats-note");
    note.textContent = convs.length ? "A chat is deleted two weeks after its last message." : "No saved chats yet. Ask something and it will show up here.";
    chatsView.appendChild(h);
    chatsView.appendChild(note);
    var ul = el("ul", "chat-rows");
    var now = Date.now();
    convs.forEach(function (c) {
      if (!c || typeof c.id !== "string") return;
      var li = el("li", "chat-row" + (chat.server && c.id === chat.id ? " is-current" : ""));
      function main() {
        while (li.firstChild) li.removeChild(li.firstChild);
        var open1 = el("button", "chat-row-main", { type: "button" });
        var t = el("span", "chat-row-title");
        t.textContent = String(c.title || "New chat").slice(0, 80);
        var meta = el("span", "chat-row-meta");
        meta.textContent = chatMeta(c, now);
        open1.appendChild(t);
        open1.appendChild(meta);
        open1.addEventListener("click", function () {
          if (streaming) streaming.abort();
          streaming = null;
          setBusy(false);
          chat = { server: true, id: c.id, title: String(c.title || ""), messages: [] };
          setListing(false);
          paintHeader();
          renderAll();
          loadConversation(c.id);
        });
        var del = iconButton("chat-row-delete", "Delete chat: " + String(c.title || "New chat").slice(0, 60), ICON.trash);
        del.addEventListener("click", confirmDelete);
        li.appendChild(open1);
        li.appendChild(del);
      }
      function confirmDelete() {
        while (li.firstChild) li.removeChild(li.firstChild);
        var ask = el("span", "chat-row-ask");
        ask.textContent = "Delete this chat?";
        var no = el("button", "text-button is-quiet", { type: "button" });
        no.textContent = "Cancel";
        no.addEventListener("click", main);
        var yes = el("button", "text-button chat-row-yes", { type: "button" });
        yes.textContent = "Delete";
        yes.addEventListener("click", function () {
          yes.disabled = true;
          authedFetch(apiBase + "/conversations/" + encodeURIComponent(c.id), { method: "DELETE" }).then(
            function (res) {
              if (!res.ok && res.status !== 404) {
                ask.textContent = "Couldn't delete it.";
                yes.disabled = false;
                return;
              }
              if (li.parentNode) li.parentNode.removeChild(li);
              if (chat.server && chat.id === c.id) {
                chat = { server: true, id: null, title: "", messages: [] };
                rememberEditorChat();
                paintHeader();
                renderAll();
              }
              if (!ul.children.length) note.textContent = "No saved chats yet. Ask something and it will show up here.";
            },
            function (err) {
              if (!err || err.name !== "AuthExpired") {
                ask.textContent = "Couldn't delete it.";
                yes.disabled = false;
              }
            }
          );
        });
        li.appendChild(ask);
        li.appendChild(no);
        li.appendChild(yes);
        yes.focus();
      }
      main();
      ul.appendChild(li);
    });
    chatsView.appendChild(ul);
  }

  if (RA) {
    // The Sign in button in the header opens the sheet with the chat's own wording, and remembers the open panel and draft.
    accountWrap.addEventListener(
      "click",
      function (e) {
        if (!e.target.closest || !e.target.closest('[data-auth="signin"]')) return;
        e.stopPropagation(); // not auth.js's own handler: this one passes the chat's wording
        markSigninPending();
        RA.openSignIn({ title: "Sign in to the chat", lede: "Family editors can sign in to keep their chats, on any of their devices." });
      },
      true
    );
    RA.onChange(function (session, info) {
      if (info.type === "sign-in") {
        handlePending();
        refreshMe();
      } else if (info.type === "sign-out") {
        var keepEmail = info.reason === "expired" ? me.email : "";
        me = { signedIn: false, email: "" };
        checkingMe = false;
        goPublic({ keepEmail: keepEmail });
      }
    });
  }
  chatsBtn.addEventListener("click", function () { setListing(!listing); });

  // --- panel open / close / new chat ------------------------------------------------------------------------------------------
  function open(opts) {
    if (!panel.hidden) return;
    panel.hidden = false;
    bubble.setAttribute("aria-expanded", "true");
    doc.body.classList.add("chat-open");
    dot.hidden = true;
    paintContext();
    layoutPanel();
    toBottom();
    if (!(opts && opts.restore)) input.focus({ preventScroll: true }); // a restored panel must not pop the keyboard up
    saveUi();
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    bubble.setAttribute("aria-expanded", "false");
    doc.body.classList.remove("chat-open");
    bubble.focus({ preventScroll: true });
    saveUi();
  }
  function newChat() {
    if (streaming) streaming.abort();
    streaming = null;
    setBusy(false);
    if (mode === "editor") {
      chat = { server: true, id: null, title: "", messages: [] };
      rememberEditorChat();
    } else {
      chat = anonChat = { id: newId(), messages: [] };
      saveChat();
    }
    setListing(false);
    paintHeader();
    saveUi();
    renderAll();
    input.focus({ preventScroll: true });
  }

  bubble.addEventListener("click", function () { if (panel.hidden) open(); else close(); });
  closeBtn.addEventListener("click", close);
  newBtn.addEventListener("click", newChat);
  ctxClose.addEventListener("click", function () { contextDismissed = true; paintContext(); });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden && !doc.body.classList.contains("sheet-open")) close();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) {
      e.preventDefault();
      send(input.value);
    }
  });
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }
  input.addEventListener("input", function () {
    autosize();
    saveUi();
  });
  window.addEventListener("pagehide", saveUi);

  // --- layout: keyboard and sticky bars ----------------------------------------------------------------------------------------------
  // On phones the panel is as tall as the visual viewport, so the input stays above the on-screen keyboard.
  function layoutPanel() {
    var vv = window.visualViewport;
    if (!vv) return;
    panel.style.setProperty("--chat-h", vv.height + "px");
    panel.style.setProperty("--chat-top", vv.offsetTop + "px");
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { layoutPanel(); if (!panel.hidden) toBottom(); });
    window.visualViewport.addEventListener("scroll", layoutPanel);
  }

  // The bubble sits above any sticky bar that reaches the bottom of the screen (the shopping page's Save bar, the recipe page's cook bar).
  var liftQueued = false;
  function lift() {
    liftQueued = false;
    var px = 0;
    Array.prototype.forEach.call(doc.querySelectorAll(".save-bar, .cook-bar"), function (bar) {
      if (bar.hidden) return;
      var pos = getComputedStyle(bar).position;
      if (pos !== "sticky" && pos !== "fixed") return;
      var r = bar.getBoundingClientRect();
      var b = bubble.getBoundingClientRect();
      var overlapsBubble = r.left < b.right && r.right > b.left; // a bar that stops short of the bubble (desktop) needs no lift
      if (overlapsBubble && r.height > 0 && r.top < window.innerHeight && r.bottom > window.innerHeight - 8) px = Math.max(px, window.innerHeight - r.top);
    });
    bubble.style.setProperty("--chat-lift", px ? px + "px" : "0px");
    panel.style.setProperty("--chat-lift", px ? px + "px" : "0px");
  }
  function queueLift() {
    if (!liftQueued) {
      liftQueued = true;
      requestAnimationFrame(lift);
    }
  }
  window.addEventListener("scroll", queueLift, { passive: true });
  window.addEventListener("resize", queueLift);
  if (window.MutationObserver) new MutationObserver(queueLift).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
  queueLift();

  // A full page load (a tapped card, button or chip) comes back to the panel as it was: open, same conversation (its history is
  // in localStorage), the unsent draft, scrolled to the end. The new page's context chip already shows this page; the next message
  // carries it to the server.
  var restored = loadUi();
  renderAll();
  paintHeader();
  if (checkingMe) refreshMe();
  if ((restored.id === chat.id || checkingMe) && typeof restored.draft === "string" && restored.draft) {
    input.value = restored.draft.slice(0, 2000);
    autosize();
  }
  if (restored.open === true) {
    open({ restore: true });
    requestAnimationFrame(toBottom);
  }
})();
