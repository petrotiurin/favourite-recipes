// The recipe chat (docs/chatbot-design.md, phase 1: read-only, anonymous). A bubble bottom right opens a panel that talks to
// the backend's POST /chat (the script tag's data-api) and streams the answer in. Vanilla JS, no dependencies. It is only
// ever added to a page when the build was given CHAT_API_URL, and with JS off nothing appears.
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
  function startersFor(page) {
    return (
      {
        recipe: ["Swap an ingredient", "Scale it for 6", "Add to next week"],
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

  var api = {
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
  var chat = loadChat();
  function saveChat() {
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
  title.textContent = "Ask about our recipes";
  var newBtn = el("button", "text-button chat-new", { type: "button" });
  newBtn.textContent = "New chat";
  var closeBtn = iconButton("icon-button chat-close", "Close chat", ICON.close);
  head.appendChild(title);
  head.appendChild(newBtn);
  head.appendChild(closeBtn);

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
    b.textContent = "Chats are stored in this browser for two weeks. I can look things up, but I can't change anything on the site.";
    p.appendChild(a);
    p.appendChild(b);
    var starters = startersFor(CTX.page === "recipe" && contextDismissed ? "" : CTX.page);
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
    if (!chat.messages.length) log.appendChild(intro());
    chat.messages.forEach(function (m, i) {
      var last = i === chat.messages.length - 1;
      log.appendChild(messageEl(m, last));
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
    if (!text || streaming) return;
    retireChips();
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
        if (reply.replies && reply.replies.length) log.appendChild(chipsEl(reply.replies));
        if (panel.hidden) dot.hidden = false;
      } else if (added && botEl.parentNode) {
        // a partial answer that errored out is not kept in the history
        botEl.classList.add("is-partial");
      }
      toBottom();
    }

    fetch(apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: chat.id, messages: wellFormed(chat.messages.slice(-MAX_SENT)), page: pageState() }),
    })
      .then(function (res) {
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
          var stillMine = streaming === mine;
          finish(false);
          if (!stillMine || (err && err.name === "AbortError")) return;
          showError(err && err.message ? err.message : "Something went wrong with the chat.");
        }
      );
  }

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
    chat = { id: newId(), messages: [] };
    saveChat();
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
  if (restored.id === chat.id && typeof restored.draft === "string" && restored.draft) {
    input.value = restored.draft.slice(0, 2000);
    autosize();
  }
  if (restored.open === true) {
    open({ restore: true });
    requestAnimationFrame(toBottom);
  }
})();
