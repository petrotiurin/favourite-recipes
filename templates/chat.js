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

  var PLAN_LABELS = { apply_plan: "Save to site", finalise_plan: "Finalise list" };
  var PLAN_ACTIONS = { apply_plan: true, finalise_plan: true }; // chips that press the tray's own button (a human tap)

  /** Suggested replies: a string (sent as the next message), { label, url } (opens a page on this site) or { label, action } (presses a tray button). Anything else is dropped. */
  function cleanReplyItems(list, origin) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (r) {
      if (out.length >= 4) return;
      if (typeof r === "string") {
        if (r) out.push(r);
      } else if (r && typeof r === "object" && typeof r.action === "string" && PLAN_ACTIONS[r.action] === true) {
        out.push({ label: PLAN_LABELS[r.action], action: r.action }); // fixed text: the model's words never label a button that commits
      } else if (r && typeof r === "object" && typeof r.label === "string" && r.label) {
        var href = origin && typeof r.url === "string" ? safeHref(r.url, origin) : null;
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
        slug: typeof c.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.slug) ? c.slug : "",
        publishing: c.publishing === true,
        title: c.title.slice(0, 120),
        url: url,
        image: typeof c.image === "string" && c.image ? safeHref(c.image, origin) || "" : "",
        kicker: { kind: kind, label: c.kicker && typeof c.kicker.label === "string" ? c.kicker.label.slice(0, 40) : "" },
        meta: typeof c.meta === "string" ? c.meta.slice(0, 40) : "",
      });
    });
    return out;
  }

  /** A question from ask_user: { question, options (2-6 short strings), multi }, or null. */
  function cleanQuestion(q) {
    if (!q || typeof q !== "object" || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options)) return null;
    var options = [];
    q.options.forEach(function (o) {
      if (typeof o === "string" && o.trim() && options.length < 6 && options.indexOf(o.trim().slice(0, 40)) === -1) options.push(o.trim().slice(0, 40));
    });
    return options.length >= 2 ? { question: q.question.trim().slice(0, 240), options: options, multi: q.multi === true } : null;
  }

  var REVIEW_THUMBS = ["liked", "remove"];
  var REVIEW_LABELS = { liked: "Liked", remove: "Not for us", keep: "Kept for the coming week" };
  var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  /**
   * The drafts review card (review_drafts / "Promote it"): { drafts: [{ slug, title, url, image, meta, alsoNext, answer }] }, or null. Built
   * by the server from the book; links and photos only on this site's origin, at most 20 rows. answer: "liked" | "remove" | "" (no thumb).
   */
  function cleanReview(r, origin) {
    if (!r || typeof r !== "object" || !Array.isArray(r.drafts)) return null;
    var drafts = [];
    r.drafts.forEach(function (d) {
      if (drafts.length >= 20 || !d || typeof d !== "object" || typeof d.slug !== "string" || !SLUG_RE.test(d.slug) || typeof d.title !== "string" || !d.title.trim()) return;
      if (drafts.some(function (x) { return x.slug === d.slug; })) return;
      drafts.push({
        slug: d.slug,
        title: d.title.trim().slice(0, 120),
        url: (typeof d.url === "string" && safeHref(d.url, origin)) || "",
        image: (typeof d.image === "string" && d.image && safeHref(d.image, origin)) || "",
        meta: typeof d.meta === "string" ? d.meta.slice(0, 40) : "",
        alsoNext: d.also_next === true || d.alsoNext === true,
        answer: REVIEW_THUMBS.indexOf(d.answer) !== -1 ? d.answer : "",
      });
    });
    return drafts.length ? { drafts: drafts } : null;
  }

  /**
   * The editor's thumbs as their message in the chat: "Liked: A. Not for us: B. Kept for the coming week: C." (a draft with no thumb is kept;
   * the server stores its own copy of the same words).
   */
  function reviewText(review, answers) {
    var groups = [];
    ["liked", "remove", "keep"].forEach(function (a) {
      var titles = review.drafts.filter(function (d) { return (REVIEW_THUMBS.indexOf(answers[d.slug]) !== -1 ? answers[d.slug] : "keep") === a; }).map(function (d) { return d.title; });
      if (titles.length) groups.push(REVIEW_LABELS[a] + ": " + titles.join(", ") + ".");
    });
    return groups.join(" ");
  }

  var TRAY_KINDS = {
    switch: { label: "Switch", cls: "kicker-current" },
    promote: { label: "Promote", cls: "" },
    remove: { label: "Remove", cls: "" },
    new: { label: "New", cls: "kicker-draft" },
    next: { label: "Next week", cls: "kicker-next" },
    edit: { label: "Edit", cls: "" },
    list: { label: "List", cls: "" },
    servings: { label: "Servings", cls: "" },
    stocktake: { label: "At home", cls: "" },
  };
  function str(v, max) {
    return typeof v === "string" ? v.slice(0, max) : "";
  }
  function num(v) {
    return typeof v === "number" && isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v) : 0;
  }

  /**
   * The plan tray as GET /chat/plan returns it, reduced to plain values: strings cut, links only on this site's origin, staged photos only from
   * the Supabase signed-URL path (photoBase). null when there is no tray.
   */
  function cleanTray(raw, origin, photoBase) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return null;
    var items = [];
    raw.items.forEach(function (i) {
      if (!i || typeof i !== "object" || !/^[a-f0-9]{8}$/.test(String(i.id)) || !TRAY_KINDS[i.kind]) return;
      var photo = null;
      if (i.photo && typeof i.photo === "object") {
        var url = typeof i.photo.url === "string" && photoBase && i.photo.url.indexOf(photoBase + "/storage/v1/object/sign/") === 0 ? i.photo.url : "";
        photo = { status: ["pending", "ready", "failed"].indexOf(i.photo.status) !== -1 ? i.photo.status : "failed", url: url, error: str(i.photo.error, 160) };
      }
      var recipe = i.recipe && typeof i.recipe === "object" ? { url: safeHref(i.recipe.url, origin) || "", image: i.recipe.image ? safeHref(i.recipe.image, origin) || "" : "" } : null;
      var item = {
        id: i.id,
        kind: i.kind,
        title: str(i.title, 120),
        sub: str(i.sub, 160),
        added_by: str(i.added_by, 40),
        reason: str(i.reason, 100),
        error: i.error ? str(i.error, 300) : "",
        clash: i.clash && typeof i.clash === "object" ? { reason: str(i.clash.reason, 200) } : null,
        save_now: i.save_now === true,
        draft: i.draft === true,
        add: i.add !== false,
        current: i.current === true,
        photo: photo,
        recipe: recipe,
      };
      if (i.detail && typeof i.detail === "object") {
        item.detail = {
          ingredients: (Array.isArray(i.detail.ingredients) ? i.detail.ingredients : []).slice(0, 60).map(function (x) { return str(x, 160); }),
          steps: (Array.isArray(i.detail.steps) ? i.detail.steps : []).slice(0, 60).map(function (x) { return str(x, 400); }),
          notes: str(i.detail.notes, 800),
        };
      }
      if (Array.isArray(i.preview)) {
        item.preview = i.preview.slice(0, 20).map(function (sec) {
          return { name: str(sec && sec.name, 60), items: (Array.isArray(sec && sec.items) ? sec.items : []).slice(0, 80).map(function (x) { return str(x, 100); }) };
        });
      }
      items.push(item);
    });
    return {
      id: str(raw.id, 64),
      balance: raw.balance && typeof raw.balance === "object" ? { recipes: num(raw.balance.recipes), dinners: num(raw.balance.dinners), avg_kcal: num(raw.balance.avg_kcal), total_mins: num(raw.balance.total_mins) } : null,
      state: ["collecting", "finalising", "ready"].indexOf(raw.state) !== -1 ? raw.state : "collecting",
      count: items.length,
      needs_list: raw.needs_list === true,
      list_current: raw.list_current === true,
      can_save: raw.can_save === true,
      blocked: str(raw.blocked, 120),
      expires_at: str(raw.expires_at, 40),
      expires_day: str(raw.expires_day, 12),
      items: items,
    };
  }

  /** "Tray · 8 changes" (the folded line), with "until Fri" when it's open. */
  /** "Next week after Save: 5 recipes · 3 dinners · ~420 kcal each · 2 h 15 min", from the numbers the server computed, or "". */
  function balanceLine(b) {
    if (!b || !b.recipes) return "";
    var mins = b.total_mins;
    var time = mins >= 60 ? Math.floor(mins / 60) + " h" + (mins % 60 ? " " + (mins % 60) + " min" : "") : mins + " min";
    return "Next week after Save: " + b.recipes + (b.recipes === 1 ? " recipe" : " recipes") + " · " + b.dinners + (b.dinners === 1 ? " dinner" : " dinners") + (b.avg_kcal ? " · ~" + b.avg_kcal + " kcal each" : "") + (mins ? " · " + time + " in all" : "");
  }
  function trayLine(tray, folded) {
    return "Tray · " + tray.count + " change" + (tray.count === 1 ? "" : "s") + (!folded && tray.expires_day ? " · until " + tray.expires_day : "");
  }
  /** "The tray expires tomorrow" within the last day before it goes (and "today" in the last hours), else "". */
  function trayExpiryNotice(tray, now) {
    var left = Date.parse(tray.expires_at) - now;
    if (!(left > 0) || left > DAY) return "";
    return dayStart(new Date(tray.expires_at)) === dayStart(new Date(now)) ? "The tray expires today" : "The tray expires tomorrow";
  }
  /** What the tray's one button is: "finalise" | "finalising" | "save" | "blocked", with its label. */
  function trayButton(tray) {
    if (tray.can_save) return { kind: "save", label: "Save to site (" + tray.count + ")" };
    if (tray.state === "finalising") return { kind: "finalising", label: "Building the list…" };
    if (tray.needs_list && !tray.list_current && !tray.items.some(function (i) { return i.error || i.clash; })) return { kind: "finalise", label: "Finalise list" };
    return { kind: "blocked", label: "Save to site (" + tray.count + ")" };
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
        shopping: ["What's left to buy?", "What can I make from what's at home?"],
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

  /** Photo URLs the server signed for an editor's own messages: only the Supabase signed-URL path of the chat-uploads bucket on the site's own project, at most 8. */
  function cleanUploadUrls(list, base) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (u) {
      if (out.length < 8 && typeof u === "string" && base && u.indexOf(base + "/storage/v1/object/sign/chat-uploads/") === 0 && u.length < 1200) out.push(u);
    });
    return out;
  }

  /** The photo numbers (photo-7) that go with a message's photos, as positive whole numbers; [] when the server sent none or they don't line up. */
  function cleanNumbers(list, count) {
    if (!Array.isArray(list) || list.length !== count) return [];
    for (var i = 0; i < list.length; i++) if (typeof list[i] !== "number" || !(list[i] >= 1 && list[i] <= 100000) || Math.floor(list[i]) !== list[i]) return [];
    return list.slice();
  }

  /** The photo reading in a conversation (GET /chat/conversations/:id `photos`): { total, read, reading, active, followUp }, or null when nothing is going on. */
  function cleanPhotos(p) {
    if (!p || typeof p !== "object") return null;
    var n = function (v) { return typeof v === "number" && v >= 0 && v < 100000 ? Math.floor(v) : 0; };
    var out = { total: n(p.total), read: n(p.read), reading: n(p.reading), active: p.active === true, followUp: p.follow_up === true };
    return out.active || out.followUp ? out : null;
  }

  /** The line under the conversation while photos are read: "Reading photos… 4 of 6", then "Adding them to the tray…". */
  function photoProgress(p) {
    if (!p) return "";
    if (p.reading > 0) return "Reading photos… " + p.read + " of " + (p.read + p.reading);
    if (p.followUp || p.active) return "Adding them to the tray…";
    return "";
  }

  /** The tray strip's "Reading 3 photos · Sam" entries (GET /chat/plan `reading`): [{ name, count, mine }], names cut, at most 4. */
  function cleanReading(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (out.length >= 4 || !e || typeof e !== "object" || typeof e.count !== "number" || !(e.count >= 1)) return;
      out.push({ name: typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 40) : "Someone", count: Math.min(999, Math.floor(e.count)), mine: e.mine === true });
    });
    return out;
  }
  function readingLine(e) {
    return "Reading " + e.count + " photo" + (e.count === 1 ? "" : "s") + " · " + (e.mine ? "you" : e.name);
  }
  /** The note by the Save button while someone else's photos are still being read (Save still works). */
  function readingSaveNote(entries) {
    var others = entries.filter(function (e) { return !e.mine; });
    if (!others.length) return "";
    return others.map(function (e) { return e.name + " has " + e.count + " photo" + (e.count === 1 ? "" : "s") + " still being read"; }).join("; ") + ".";
  }

  /** A signed-in editor's chat as the server returns it (GET /chat/conversations/:id): same cleaning as the local history, plus the turn id and feedback. */
  function cleanServerMessages(list, origin, photoBase) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (m) {
      if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "event") || typeof m.content !== "string") return;
      if (m.role === "event") {
        // a note from the site ("Photos read: 5 recipes, 1 to check"): a status line in the conversation, plain text
        if (m.content.trim()) out.push({ role: "event", content: m.content.trim().slice(0, 300) });
        return;
      }
      var msg = { role: m.role, content: m.content };
      if (m.role === "user") {
        var photos = cleanUploadUrls(m.images, photoBase);
        if (photos.length) {
          msg.images = photos;
          var nums = cleanNumbers(m.photo_numbers, photos.length);
          if (nums.length) msg.numbers = nums;
        }
      }
      if (m.role === "assistant") {
        var replies = cleanReplyItems(m.replies, origin);
        if (replies.length) msg.replies = replies;
        var question = cleanQuestion(m.question);
        if (question) msg.question = question;
        var review = cleanReview(m.review, origin);
        if (review) msg.review = review;
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
      if (msg.content || msg.cards || msg.question || msg.review || msg.images) out.push(msg);
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
    cleanUploadUrls: cleanUploadUrls,
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
    cleanQuestion: cleanQuestion,
    cleanReview: cleanReview,
    reviewText: reviewText,
    cleanTray: cleanTray,
    cleanNumbers: cleanNumbers,
    cleanPhotos: cleanPhotos,
    photoProgress: photoProgress,
    cleanReading: cleanReading,
    readingLine: readingLine,
    readingSaveNote: readingSaveNote,
    trayLine: trayLine,
    balanceLine: balanceLine,
    trayExpiryNotice: trayExpiryNotice,
    trayButton: trayButton,
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

  var publicOff = script.getAttribute("data-public") === "false"; // build var CHAT_PUBLIC=false: the bubble is for signed-in visitors only
  var OFF_KEY = "recipes-chat-off"; // sessionStorage: the server said the chat is switched off; later pages in this tab don't show the bubble
  var switchedOffEarlier = false;
  try {
    switchedOffEarlier = sessionStorage.getItem(OFF_KEY) === "1";
  } catch (e) {
    // not remembered
  }

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
    chevron: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    attach: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.6"/><path d="m21 16-5-5-8 8"/></svg>',
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
  // Photos being read in the open conversation (cleanPhotos): the panel polls the conversation while there is something on its way.
  var photoState = null;
  var lastReplyAt = "";
  var photoTimer = null;
  var photoLineEl = null;
  // The newest reply this browser has seen (GET /chat/me reports the newest one on the server: newer means the bubble's dot on page load).
  var SEEN_KEY = "recipes-chat-seen";
  function markSeen(at) {
    if (typeof at !== "string" || !at) return;
    var seen = readJson(localStorage, SEEN_KEY);
    if (!seen || seen.email !== me.email || !(seen.at >= at)) writeJson(localStorage, SEEN_KEY, { email: me.email, at: at.slice(0, 40) });
  }
  function seenAt() {
    var seen = readJson(localStorage, SEEN_KEY);
    return seen && seen.email === me.email && typeof seen.at === "string" ? seen.at : "";
  }
  var checkingMe = !!(RA && RA.getSession()); // until /chat/me has answered we don't know which chat to show
  var locked = switchedOffEarlier ? "off" : null; // null | "off" (switched off on the server) | "signin" (editors only) | "account" (signed in, but can't use it)
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
      sessionStorage.setItem(UI_KEY, JSON.stringify({ open: !panel.hidden, id: chat.id, draft: input.value.slice(0, 2000), unread: unread, pending: pendingTurn }));
    } catch (e) {
      // not remembered, the chat still works
    }
  }

  var contextDismissed = false;
  var streaming = null; // { abort }
  // The bubble's notice while the panel is closed: a ring while an answer (or a Save) is on its way, a dot once it has arrived.
  // Both are remembered for the tab (sessionStorage), so closing the panel and moving to another page keeps them.
  var unread = loadUi().unread === true;
  // An editor's turn still running on the server: { conv, turn, t }. A page left mid-answer picks it up on the next page (resumePending).
  var pendingTurn = (function (p) {
    return p && typeof p.conv === "string" && typeof p.turn === "string" && Number(p.t) > 0 ? { conv: p.conv.slice(0, 64), turn: p.turn.slice(0, 64), t: Number(p.t) } : null;
  })(loadUi().pending);
  var leaving = false; // the page is unloading: a stream it cuts must not clear pendingTurn

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
  // Photos (editors only): the attach button opens the camera / photo library, the picked photos are downscaled here and listed above the input.
  var attachBtn = iconButton("chat-attach", "Attach photos", ICON.attach);
  attachBtn.hidden = true;
  var picker = el("input", "chat-file", { type: "file", accept: "image/*", multiple: "", hidden: "", tabindex: "-1", "aria-hidden": "true" });
  var shelf = el("div", "chat-attachments", { "aria-label": "Photos to send" });
  shelf.hidden = true;
  form.appendChild(attachBtn);
  form.appendChild(picker);
  form.appendChild(input);
  form.appendChild(sendBtn);
  foot.appendChild(ctxChip);
  foot.appendChild(shelf);
  foot.appendChild(form);
  panel.appendChild(head);
  panel.appendChild(banner);
  panel.appendChild(chatsView);
  var tray = el("section", "chat-tray", { "aria-label": "Plan tray" }); // editors only: what's been staged, not yet saved to the site
  tray.hidden = true;
  panel.appendChild(log);
  panel.appendChild(tray);
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
    a.textContent = "Ask me about recipes on this site.";
    p.appendChild(a);
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
      var a = c.publishing ? el("span", "tile chat-card is-publishing", { role: "listitem", "aria-disabled": "true" }) : el("a", "tile chat-card", { href: c.url, role: "listitem" });
      if (c.image && !c.publishing) {
        var img = el("img", "tile-image", { src: c.image, alt: "", loading: "lazy" });
        a.appendChild(img);
      } else a.appendChild(el("span", "tile-image"));
      var k = el("p", "kicker" + (KICKER_KINDS[c.kicker.kind] ? " " + KICKER_KINDS[c.kicker.kind] : ""));
      k.textContent = c.publishing ? "Publishing…" : c.kicker.label;
      var t = el("h3", "tile-title");
      t.textContent = c.title;
      var meta = el("p", "tile-meta");
      meta.textContent = c.meta;
      a.appendChild(k);
      a.appendChild(t);
      a.appendChild(meta);
      if (!c.publishing) guardWhileStreaming(a);
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

  /** The number badge on each photo of a message (photo-7 is "7"): the same numbers the chat uses for them. */
  function paintBadges(wrap, numbers) {
    var shots = wrap.querySelectorAll(".chat-shot");
    Array.prototype.forEach.call(shots, function (shot, i) {
      var old = shot.querySelector(".chat-photo-num");
      if (old) shot.removeChild(old);
      var n = numbers && numbers[i];
      if (!n) return;
      var badge = el("span", "chat-photo-num", { "aria-hidden": "true" });
      badge.textContent = String(n);
      shot.appendChild(badge);
      var img = shot.querySelector("img");
      if (img) img.setAttribute("alt", "Photo " + n + " you sent");
    });
  }

  function messageEl(m, live) {
    if (m.role === "event") {
      var line = el("p", "chat-event", { role: "status" });
      line.textContent = m.content;
      return line;
    }
    var wrap = el("div", "chat-msg " + (m.role === "user" ? "is-user" : "is-bot"));
    var body = el("div", "chat-body");
    if (m.role === "user") {
      if (m.images && m.images.length) {
        var strip = el("div", "chat-photos");
        m.images.forEach(function (u) {
          var shot = el("span", "chat-shot");
          shot.appendChild(el("img", "chat-photo", { src: u, alt: "A photo you sent", loading: "lazy", decoding: "async" }));
          strip.appendChild(shot);
        });
        body.appendChild(strip);
      }
      if (m.content) {
        var txt = el("span", "chat-text");
        txt.textContent = m.content;
        body.appendChild(txt);
      }
    } else renderInto(doc, body, m.content, origin);
    wrap.appendChild(body);
    if (m.role === "user" && m.numbers) paintBadges(wrap, m.numbers);
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
      } else if (r.action) {
        chip = el("button", "chat-chip is-action", { type: "button", "data-action": r.action }); // presses the tray's own button: still a tap by a person
        chip.textContent = PLAN_LABELS[r.action] + (r.action === "apply_plan" && trayData && trayData.count ? " (" + trayData.count + ")" : ""); // fixed text, never the model's
        chip.addEventListener("click", function () {
          if (!row.classList.contains("is-old")) pressTray(r.action);
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

  /** An ask_user question: the question and solid answer chips; with multi, chips toggle and Done sends them together. */
  function questionEl(q) {
    var box = el("div", "chat-question", { role: "group", "aria-label": q.question });
    var text = el("p", "chat-q");
    text.textContent = q.question;
    box.appendChild(text);
    var row = el("div", "chat-chips");
    var picked = [];
    var done = null;
    q.options.forEach(function (o) {
      var chip = el("button", "chat-chip is-solid", { type: "button" });
      chip.textContent = o;
      if (q.multi) chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", function () {
        if (box.classList.contains("is-old")) return;
        if (!q.multi) return send(o);
        var at = picked.indexOf(o);
        if (at === -1) picked.push(o);
        else picked.splice(at, 1);
        chip.setAttribute("aria-pressed", at === -1 ? "true" : "false");
        done.disabled = !picked.length;
      });
      row.appendChild(chip);
    });
    box.appendChild(row);
    if (q.multi) {
      done = el("button", "chat-chip is-done", { type: "button" });
      done.textContent = "Done";
      done.disabled = true;
      done.addEventListener("click", function () {
        if (!box.classList.contains("is-old") && picked.length) send(picked.join(", "));
      });
      row.appendChild(done);
    }
    return box;
  }

  /**
   * The drafts review card: one row per draft of this week (photo, title, thumbs up / down), a line saying a draft with no thumb is kept for
   * the coming week, then one Done that sends them all at once. The server stages them; no model call per answer.
   */
  function reviewEl(review) {
    var box = el("div", "chat-review", { role: "group", "aria-label": "This week's drafts" });
    var answers = {};
    review.drafts.forEach(function (d) {
      var row = el("div", "chat-review-row");
      var head = el(d.url ? "a" : "div", "chat-review-head", d.url ? { href: d.url } : null);
      var img = el(d.image ? "img" : "span", "chat-review-img", d.image ? { src: d.image, alt: "", loading: "lazy" } : { "aria-hidden": "true" });
      head.appendChild(img);
      var words = el("span", "chat-review-words");
      var name = el("span", "chat-review-title");
      name.textContent = d.title;
      words.appendChild(name);
      var subText = d.alsoNext ? "Also planned for next week" : d.meta;
      if (subText) {
        var sub = el("span", "chat-review-sub");
        sub.textContent = subText;
        words.appendChild(sub);
      }
      head.appendChild(words);
      row.appendChild(head);
      var thumbs = el("div", "chat-review-thumbs", { role: "group", "aria-label": d.title });
      var up = iconButton("chat-review-thumb", "Liked " + d.title, ICON.up);
      var down = iconButton("chat-review-thumb", "Not for us: " + d.title, ICON.down);
      function paint() {
        up.setAttribute("aria-pressed", answers[d.slug] === "liked" ? "true" : "false");
        down.setAttribute("aria-pressed", answers[d.slug] === "remove" ? "true" : "false");
      }
      function pick(a) {
        if (box.classList.contains("is-old")) return;
        if (answers[d.slug] === a) delete answers[d.slug]; // tapping the chosen thumb again takes it back: kept for the coming week
        else answers[d.slug] = a;
        d.answer = answers[d.slug] || ""; // kept on the message, so a redraw of the panel keeps the thumbs
        paint();
      }
      up.addEventListener("click", function () { pick("liked"); });
      down.addEventListener("click", function () { pick("remove"); });
      if (d.answer) answers[d.slug] = d.answer;
      paint();
      thumbs.appendChild(up);
      thumbs.appendChild(down);
      row.appendChild(thumbs);
      box.appendChild(row);
    });
    var foot = el("div", "chat-review-foot");
    var hint = el("p", "chat-review-hint");
    hint.textContent = "No thumb: kept for the coming week.";
    foot.appendChild(hint);
    var done = el("button", "chat-chip is-done chat-review-done", { type: "button" });
    done.textContent = "Done";
    done.addEventListener("click", function () {
      if (box.classList.contains("is-old")) return;
      send(reviewText(review, answers), { action: "review_drafts", answers: answers });
    });
    foot.appendChild(done);
    box.appendChild(foot);
    return box;
  }

  /** The input invites a typed answer while a question is live. */
  function paintPlaceholder() {
    var live = log.querySelector(".chat-question:not(.is-old), .chat-review:not(.is-old)");
    input.setAttribute("placeholder", live ? "Or type an answer" : "Ask about our recipes");
  }

  /** Only the last message's chips and button are live; older ones fade and stop responding. */
  function retireChips() {
    // an answered review card fades and its buttons stop; its recipe links still open the recipes
    Array.prototype.forEach.call(log.querySelectorAll(".chat-review"), function (box) {
      box.classList.add("is-old");
      Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) { b.disabled = true; });
    });
    Array.prototype.forEach.call(log.querySelectorAll(".chat-chips, .chat-nav, .chat-question"), function (row) {
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
    paintPlaceholder();
  }

  /** The panel when the chat can't be used: switched off, editors only, or an account that isn't an editor. No input (CSS hides the footer). */
  function lockedEl() {
    var box = el("div", "chat-locked", { role: "status" });
    var h = el("h3", "chat-locked-title");
    var p = el("p", "chat-locked-text");
    if (locked === "off") {
      h.textContent = "The chat is switched off for now.";
      p.textContent = "The recipes and the shopping list work as usual. Check back later.";
    } else if (locked === "signin") {
      h.textContent = "Chat is for signed-in editors";
      p.textContent = "Sign in with your family account to ask about the recipes.";
    } else {
      h.textContent = "This account can't use the chat";
      p.textContent = me.email ? "Signed in as " + me.email + ". Only family editors can use the chat right now." : "Only family editors can use the chat right now.";
    }
    box.appendChild(h);
    box.appendChild(p);
    if (locked === "signin" && RA) {
      var btn = el("button", "save-button chat-locked-signin", { type: "button" });
      btn.textContent = "Sign in";
      btn.addEventListener("click", function () {
        markSigninPending();
        RA.openSignIn({ title: "Sign in to the chat", lede: "Family editors can sign in to ask about the recipes." });
      });
      box.appendChild(btn);
    }
    return box;
  }

  /** Whether the bubble shows: not on pages loaded after the server said the chat is off (this page keeps it, with the message), and with CHAT_PUBLIC=false only for a signed-in visitor. */
  function paintBubble() {
    var hidden = (locked === "off" && switchedOffEarlier) || (publicOff && !(RA && RA.getSession()));
    bubble.hidden = hidden;
    if (hidden && !panel.hidden) close();
  }

  function paintNotice() {
    var working = panel.hidden && !unread && !!(streaming || trayBusy || photoState);
    var dotOn = panel.hidden && unread;
    dot.hidden = !dotOn;
    bubble.classList.toggle("is-working", working);
    bubble.setAttribute("aria-label", dotOn ? "Chat about recipes: new reply" : working ? "Chat about recipes: still answering" : "Chat about recipes");
  }
  /** Something arrived (an answer, an error, a save) while the panel was closed: the dot on the bubble until it is opened. */
  function paintPhotoLine() {
    if (photoLineEl && photoLineEl.parentNode) photoLineEl.parentNode.removeChild(photoLineEl);
    photoLineEl = null;
    var text = mode === "editor" && chat.server ? photoProgress(photoState) : "";
    if (!text || locked || checkingMe) return;
    photoLineEl = el("p", "chat-status chat-reading", { role: "status" });
    photoLineEl.textContent = text;
    log.appendChild(photoLineEl);
  }

  /** Photos are being read (or the follow-up is on its way): ask the conversation again in a while, and show the line under it. */
  var photoChangedAt = 0; // the last time the reading moved on: after 10 quiet minutes the panel stops waiting (the server can't finish it)
  function schedulePhotoPoll(photos, soon) {
    clearTimeout(photoTimer);
    var was = photoState;
    if (soon || !was || !photos || was.read !== photos.read || was.reading !== photos.reading) photoChangedAt = Date.now();
    if (photos && Date.now() - photoChangedAt > 10 * 60 * 1000) photos = null;
    photoState = photos || null;
    paintPhotoLine();
    paintNotice();
    if (mode !== "editor" || !chat.server || !chat.id || (!photoState && !soon)) return;
    photoTimer = setTimeout(pollPhotos, soon ? 1500 : panel.hidden ? 15000 : 5000); // closed panel: slower, but the ring and the dot still work
  }
  function sameMessages(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].role !== b[i].role || a[i].content !== b[i].content) return false;
    return true;
  }
  function pollPhotos() {
    var convId = chat.id;
    if (mode !== "editor" || !chat.server || !convId) return;
    if (streaming || listing) return schedulePhotoPoll(photoState); // a turn of our own is running: it reloads when it ends
    authedFetch(apiBase + "/conversations/" + encodeURIComponent(convId))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(
        function (j) {
          if (!j || chat.id !== convId || mode !== "editor") return;
          if (streaming) return schedulePhotoPoll(photoState);
          var next = cleanServerMessages(j.messages, origin, photoBase);
          var photos = cleanPhotos(j.photos);
          if (!sameMessages(next, chat.messages)) {
            photoChangedAt = Date.now();
            var grew = next.length > chat.messages.length;
            chat.messages = next;
            photoState = photos;
            renderAll();
            loadTray({ highlight: true });
            if (grew) markUnread();
          }
          if (!panel.hidden) markSeen(j.last_reply_at);
          schedulePhotoPoll(photos);
        },
        function () { schedulePhotoPoll(photoState); }
      );
  }

  function markUnread() {
    if (!panel.hidden) return;
    unread = true;
    paintNotice();
    saveUi();
  }

  /** Switch the panel into a locked state (from a server answer) and remember "off" for the rest of this tab session. */
  function lock(kind) {
    locked = kind;
    if (kind === "off") {
      try {
        sessionStorage.setItem(OFF_KEY, "1");
      } catch (e) {
        // not remembered
      }
    }
    streaming = null;
    setBusy(false);
    renderAll();
    paintBubble();
  }

  function renderAll() {
    while (log.firstChild) log.removeChild(log.firstChild);
    statusEl = null;
    panel.classList.toggle("is-locked", !!locked);
    if (locked) {
      log.appendChild(lockedEl());
      return;
    }
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
      if (m.question && last) log.appendChild(questionEl(m.question));
      if (m.review && last && mode === "editor" && chat.server) log.appendChild(reviewEl(m.review));
      if (m.replies && m.replies.length && last) log.appendChild(chipsEl(m.replies));
    });
    paintPhotoLine();
    paintPlaceholder();
    toBottom();
    watchPublishing();
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
    paintNotice();
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

  function send(text, opts) {
    text = String(text || "").trim();
    var action = opts && opts.action;
    keyboardUnfold();
    var photos = mode === "editor" && chat.server && !action ? pending.slice() : [];
    if ((!text && !photos.length) || streaming || checkingMe) return;
    // photos still uploading: the message goes as soon as they are up (the input keeps it until then)
    var uploading = photos.filter(function (p) { return p.state === "uploading"; });
    if (uploading.length) {
      if (sendQueued) return;
      sendQueued = true;
      photoNote = "Sending as soon as the photos are uploaded…";
      sendBtn.disabled = true; // it's on its way: no second tap
      sendBtn.setAttribute("aria-label", "Sending when the photos are uploaded");
      paintShelf();
      Promise.all(uploading.map(function (p) { return p.promise; })).then(function () {
        sendQueued = false;
        sendBtn.disabled = false;
        sendBtn.setAttribute("aria-label", "Send");
        photoNote = "";
        if (pending.some(function (p) { return p.state === "failed"; })) {
          photoNote = "A photo didn't upload: tap it to try again, or remove it.";
          paintShelf();
          return;
        }
        send(text, opts);
      });
      return;
    }
    if (photos.some(function (p) { return p.state === "failed"; })) {
      photoNote = "A photo didn't upload: tap it to try again, or remove it.";
      paintShelf();
      return;
    }
    retireChips();
    Array.prototype.forEach.call(log.querySelectorAll(".chat-feedback"), function (f) { f.classList.add("is-old"); }); // earlier turns keep their thumbs, dimmed
    var editorTurn = mode === "editor" && chat.server;
    clearStatus();
    var intro0 = log.querySelector(".chat-intro");
    if (intro0) log.removeChild(intro0);
    Array.prototype.forEach.call(log.querySelectorAll(".chat-error"), function (e) { e.parentNode.removeChild(e); });

    var sent = { role: "user", content: text };
    if (photos.length) sent.images = photos.map(function (p) { return p.url; });
    chat.messages.push(sent);
    var sentEl = messageEl(sent);
    log.appendChild(sentEl);
    if (photoLineEl) log.appendChild(photoLineEl); // the reading line stays last
    saveChat();
    if (photos.length) pending = [];
    paintShelf();
    autoFoldSuppressed = false;
    setAutoFold(true); // the reply is coming: give the conversation the room
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
      if (!leaving) {
        pendingTurn = null;
        saveUi();
      }
      streaming = null;
      setBusy(false);
      clearStatus();
      autoFold = false; // the turn is over: the tray opens again (loadTray below redraws it)
      if (editorTurn) loadTray({ highlight: true });
      else if (trayData) renderTray();
      if (ok && (reply.content.trim() || (reply.cards && reply.cards.length) || reply.question || reply.review)) {
        chat.messages.push(reply);
        saveChat();
        if (reply.nav) {
          ensureAdded();
          botEl.appendChild(navEl(reply.nav));
        }
        if (editorTurn && reply.turn_id) log.appendChild(feedbackEl(reply, false));
        if (reply.question) log.appendChild(questionEl(reply.question));
        else if (reply.review && editorTurn) log.appendChild(reviewEl(reply.review));
        else if (reply.replies && reply.replies.length) log.appendChild(chipsEl(reply.replies));
        paintPlaceholder();
        watchPublishing();
        markUnread();
      } else if (added && botEl.parentNode) {
        // a partial answer that errored out is not kept in the history
        botEl.classList.add("is-partial");
      }
      toBottom();
    }

    // An editor sends only the new message and the conversation id (the server owns the history); a visitor sends their own.
    // Photos uploaded on pick go as their paths (in picked order); photos that couldn't use the upload route go as data, as before.
    var byPath = photos.length && photos.every(function (p) { return !!p.path; });
    var payload = editorTurn
      ? {
          conversation_id: chat.id || undefined,
          message: text,
          page: pageState(),
          action: action || undefined,
          answers: action === "review_drafts" && opts.answers ? opts.answers : undefined,
          image_paths: byPath ? photos.map(function (p) { return p.path; }) : undefined,
          images: photos.length && !byPath ? photos.map(function (p) { return p.data; }) : undefined,
        }
      : { conversation_id: chat.id, messages: wellFormed(chat.messages.slice(-MAX_SENT)), page: pageState() };
    var busyTries = 0;
    function attempt() {
      return (editorTurn ? authedFetch : fetch)(apiUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(onResponse);
    }
    attempt().then(onDone, onFail);
    function onResponse(res) {
        if (editorTurn && res.status === 409) {
          // another turn of this chat is running (the photos' follow-up): wait, then send again
          var busy = new Error("busy");
          busy.name = "Busy";
          throw busy;
        }
        if (editorTurn && res.status === 404) {
          chat.id = null; // that conversation is gone (expired or deleted): the next message starts a new one
          rememberEditorChat();
          throw new Error("That chat isn't available any more. Your next message starts a new one.");
        }
        if (!res.ok) {
          return res.json().then(
            function (j) {
              var kind = j && j.disabled === true ? "off" : j && j.signin === true ? (me.signedIn ? "account" : "signin") : null;
              if (kind) {
                var stop = new Error("locked");
                stop.name = "Locked";
                stop.kind = kind;
                throw stop;
              }
              throw new Error((j && j.error) || "The chat isn't available right now.");
            },
            function () { throw new Error("The chat isn't available right now."); }
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var failed = null;
        var ended = false; // the server's "done": without it (and without an error) the stream was cut, not finished
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              if (!ended && !failed) throw dropped();
              return;
            }
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
                  if (reply.turn_id) pendingTurn = { conv: chat.id, turn: reply.turn_id, t: Date.now() };
                  saveUi();
                }
              } else if (ev.name === "photos") {
                var nums = cleanNumbers(ev.data.numbers, (sent.images || []).length);
                if (nums.length) {
                  sent.numbers = nums;
                  paintBadges(sentEl, nums);
                  saveChat();
                }
              } else if (ev.name === "title") {
                if (chat.server && ev.data.conversation_id === chat.id && typeof ev.data.title === "string") {
                  chat.title = ev.data.title.slice(0, 80);
                  paintHeader();
                }
              }
              else if (ev.name === "suggestions") reply.replies = cleanReplyItems(ev.data.replies, origin);
              else if (ev.name === "question") reply.question = cleanQuestion(ev.data) || reply.question;
              else if (ev.name === "review") reply.review = cleanReview(ev.data, origin) || reply.review;
              else if (ev.name === "tray") { /* the tray is loaded once, when the turn ends (finish) */ }
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
              else if (ev.name === "done") ended = true;
            }
            return pump();
          });
        }
        return pump().then(function () {
          if (failed) throw new Error(failed);
        });
    }
    function onDone() {
      finish(true);
      if (editorTurn) schedulePhotoPoll(photoState, true); // photos may be on their way now (and the reply's time marks it seen)
    }
    function onFail(err) {
          if (err && err.name === "Busy" && streaming === mine && busyTries++ < 75) {
            setStatus("Sending when I'm done…");
            setTimeout(function () {
              if (streaming === mine) attempt().then(onDone, onFail);
            }, 4000);
            return;
          }
          if (err && err.name === "AuthExpired") {
            // The sign-in sheet is open: put the message back so it isn't lost, and keep the panel open through a page-reloading sign-in.
            input.value = text;
            pending = photos;
            paintShelf();
            autosize();
            saveUi();
          }
          if (err && err.name === "Locked") {
            if (streaming === mine) streaming = null;
            setBusy(false);
            lock(err.kind);
            return;
          }
          var stillMine = streaming === mine;
          // A dropped connection is a bare TypeError from the browser ("network error", "Load failed", "Failed to fetch"), e.g. a phone that
          // switched to another app or tab. An editor's turn carries on on the server and is stored: wait for it instead of failing.
          var cut = err && (err.name === "TypeError" || err.name === "Dropped");
          if (stillMine && cut && editorTurn && chat.server && chat.id && reply.turn_id) {
            resumeTurn(mine, chat.id, reply.turn_id, botEl);
            return;
          }
          finish(false);
          if (!stillMine || (err && err.name === "AbortError")) return;
          if (cut) showError("The connection to the chat dropped before the answer finished. Try again in a moment.");
          else showError(err && err.name === "Busy" ? "I'm still busy with the last answer. Try again in a moment." : err && err.message ? err.message : "Something went wrong with the chat.");
          markUnread();
    }
  }

  function dropped() {
    var e = new Error("dropped");
    e.name = "Dropped";
    return e;
  }

  var RESUME_EVERY_MS = 4000;
  var RESUME_MAX_MS = 6 * 60 * 1000; // past any turn's lifetime on the server (Vercel stops a function at 5 minutes)
  /**
   * The stream of an editor's turn dropped (the phone switched apps, the tab was put away): the turn carries on on the server and its
   * answer is stored, so the panel stays busy and checks the conversation until that turn has ended, then shows it as stored.
   */
  function resumeTurn(mine, convId, turnId, partialEl, startedAt, now) {
    var started = startedAt || Date.now();
    var timer = null;
    var stopped = false;
    mine.abort = function () {
      stopped = true;
      clearTimeout(timer);
      doc.removeEventListener("visibilitychange", onVisible);
    };
    setStatus("Still working on it… The answer will show here when it's ready.");
    function end(errorText) {
      mine.abort();
      if (streaming !== mine) return;
      pendingTurn = null;
      saveUi();
      streaming = null;
      setBusy(false);
      clearStatus();
      if (partialEl.parentNode) partialEl.parentNode.removeChild(partialEl); // the stored answer replaces what had streamed so far
      loadTray({ highlight: true });
      loadConversation(convId).then(function () {
        if (errorText) showError(errorText);
        markUnread();
        watchPublishing();
      });
    }
    function later() {
      clearTimeout(timer);
      timer = setTimeout(check, RESUME_EVERY_MS);
    }
    function check() {
      if (stopped || streaming !== mine) return;
      if (Date.now() - started > RESUME_MAX_MS) return end("That answer didn't come through. Anything already in the tray is still there: try again in a moment.");
      if (doc.visibilityState === "hidden") return later(); // checked again as soon as the page is back
      authedFetch(apiBase + "/conversations/" + encodeURIComponent(convId))
        .then(function (res) {
          if (res.status === 404) return { gone: true };
          return res.ok ? res.json() : null;
        })
        .then(
          function (j) {
            if (stopped || streaming !== mine) return;
            if (j && j.gone) return end("That chat isn't available any more.");
            var ended = j && j.ended_turns && typeof j.ended_turns === "object" ? j.ended_turns : {};
            if (Object.prototype.hasOwnProperty.call(ended, turnId)) return end(ended[turnId] ? String(ended[turnId]).slice(0, 300) : "");
            later();
          },
          function (err) {
            if (stopped || streaming !== mine) return;
            if (err && err.name === "AuthExpired") return end(""); // the sign-in sheet is open; the answer is in the chat after it
            later(); // still offline: try again
          }
        );
    }
    function onVisible() {
      if (doc.visibilityState === "visible") check();
    }
    doc.addEventListener("visibilitychange", onVisible);
    if (now) check();
    else later();
  }

  /** A page left while an editor's turn was still answering (the panel closed, a tapped link): wait for that turn here. */
  function resumePending() {
    var p = pendingTurn;
    if (!p || streaming || mode !== "editor" || chat.id !== p.conv) return;
    if (!(Date.now() - p.t < RESUME_MAX_MS)) {
      pendingTurn = null;
      saveUi();
      return;
    }
    var mine = { abort: function () {} };
    streaming = mine;
    setBusy(true);
    resumeTurn(mine, p.conv, p.turn, el("div"), p.t, true);
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
    attachBtn.hidden = !editor || !(chat && chat.server);
    if (attachBtn.hidden && pending.length) {
      pending = [];
      paintShelf();
    }
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
    pending = [];
    creating = null;
    paintShelf();
    schedulePhotoPoll(null);
    clearTray();
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
    loadTray();
    if (wantId) loadConversation(wantId).then(resumePending);
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
            chat = { server: true, id: j.id, title: String(j.title || "").slice(0, 80), messages: cleanServerMessages(j.messages, origin, photoBase) };
            rememberEditorChat();
          }
          setListing(false);
          paintHeader();
          photoState = j ? cleanPhotos(j.photos) : null;
          renderAll();
          saveUi();
          if (j && !panel.hidden) markSeen(j.last_reply_at);
          schedulePhotoPoll(photoState);
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
        if (!res.ok) {
          return res.json().then(
            function (j) {
              if (j && j.disabled === true) {
                var stop = new Error("locked");
                stop.name = "Locked";
                throw stop;
              }
              throw new Error("me");
            },
            function () { throw new Error("me"); }
          );
        }
        return res.json();
      })
      .then(
        function (j) {
          me = { signedIn: !!j.signedIn, email: String(j.email || "") };
          checkingMe = false;
          // a reply that came while this browser wasn't looking (a follow-up after the photos were read): the bubble's dot
          var last = j.last_reply && typeof j.last_reply.at === "string" ? j.last_reply.at : "";
          if (last && j.role === "editor") {
            if (!seenAt()) markSeen(last); // first time on this browser: nothing is "new"
            else if (last > seenAt() && panel.hidden) {
              unread = true;
              paintNotice();
              saveUi();
            }
            lastReplyAt = last;
          }
          if (j.role === "editor") {
            locked = locked === "off" ? null : locked;
            enterEditor();
          } else if (j.public_enabled === false) {
            lock(j.signedIn ? "account" : "signin"); // editors only: this account (or no account) can't use it
          } else goPublic();
        },
        function (err) {
          checkingMe = false;
          if (err && err.name === "Locked") return lock("off");
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
      paintBubble();
      if (info.type === "sign-in") {
        if (locked === "signin" || locked === "account") locked = null; // the server decides again for the new account
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

  // --- the plan tray (editors): what the chat has staged for the site, shared by the household ----------------------------------
  // Nothing here is saved until a person taps Save to site. The server draws the tray (GET /plan); the buttons call it. See design.md.
  var photoBase = (function () {
    var tag = doc.querySelector("script[data-supabase-url]");
    return tag ? (tag.getAttribute("data-supabase-url") || "").replace(/\/$/, "") : "";
  })();
  var trayData = null;
  var trayMsg = ""; // one muted line under the cards ("Saved", why Save is blocked, ...)
  var revealDetail = false; // scroll the detail into view once, right after it was opened
  var trayDetail = null; // id of the card whose staged recipe / list is open
  var traySeen = null; // ids already shown, to highlight what's new
  // Folded by the reader (a tap on the head): it stays folded for the rest of the tab's visit, across turns and pages, until they open it
  // again. While it is, a change to the tray shows as a dot on the head line instead of opening it.
  var TRAY_FOLD_KEY = "recipes-chat-tray-fold";
  var trayFoldState = (function () {
    try {
      var v = JSON.parse(sessionStorage.getItem(TRAY_FOLD_KEY));
      return v && v.folded === true ? { folded: true, changed: v.changed === true } : { folded: false, changed: false };
    } catch (e) {
      return { folded: false, changed: false };
    }
  })();
  var trayManualFold = trayFoldState.folded;
  var trayChanged = trayFoldState.changed; // the tray changed while folded by hand: the dot on the head
  function saveTrayFold() {
    try {
      if (trayManualFold) sessionStorage.setItem(TRAY_FOLD_KEY, JSON.stringify({ folded: true, changed: trayChanged }));
      else sessionStorage.removeItem(TRAY_FOLD_KEY);
    } catch (e) {
      // not remembered: it opens again on the next page
    }
  }
  function setManualFold(on) {
    trayManualFold = on;
    if (!on) trayChanged = false;
    saveTrayFold();
  }
  var keyboardOpen = false;
  var keyboardForcedOpen = false; // unfolded by a tap or a sent message while the keyboard is up, until it closes
  var trayTimer = null;
  var trayReading = []; // "Reading 3 photos · Sam": photos being read across the household (cleanReading)
  var traySeq = 0;
  var trayBusy = false;

  // On a phone the tray is a big strip. It folds itself to its header line while a reply streams and when the reader scrolls up in the
  // conversation, and opens again on a tap, when something new lands in it, or when the turn ends. (Wide screens have the room.)
  var autoFold = false;
  var autoFoldSuppressed = false; // the reader tapped it open: leave it until the next message
  function narrowScreen() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 719px)").matches);
  }
  function setAutoFold(on) {
    if (autoFold === on) return;
    autoFold = on;
    if (trayData) renderTray();
  }
  /** An unanswered drafts review card: on a phone the tray folds while it is open, so its rows have the room. */
  function reviewLive() {
    return !!log.querySelector(".chat-review:not(.is-old)");
  }
  function trayFolded() {
    return trayManualFold || (keyboardOpen && !keyboardForcedOpen) || ((autoFold || reviewLive()) && !autoFoldSuppressed && narrowScreen());
  }
  function keyboardUnfold() {
    if (keyboardOpen) keyboardForcedOpen = true; // a fold the reader chose themselves stays
    if (trayData) renderTray();
  }

  function trayThumb(item) {
    var wrap = el("div", "tray-thumb");
    var src = item.photo && item.photo.url ? item.photo.url : item.recipe && item.recipe.image;
    if (src) {
      var thumb = el("img", "", { src: src, alt: "", loading: "lazy" });
      thumb.addEventListener("error", function () { if (thumb.parentNode) thumb.parentNode.removeChild(thumb); }); // gone or not deployed yet: the placeholder shows
      wrap.appendChild(thumb);
    }
    var status = item.photo && item.photo.status;
    if (status === "pending" || (status === "failed" && !src)) {
      var label = el("span", "tray-thumb-note");
      label.textContent = status === "pending" ? "Making the photo…" : "No photo yet";
      wrap.appendChild(label);
    }
    return wrap;
  }

  function trayCard(item, isNew) {
    var kind = TRAY_KINDS[item.kind];
    var card = el("div", "tray-card" + (isNew ? " is-new" : "") + (item.error ? " has-error" : "") + (item.clash ? " has-clash" : ""), { role: "listitem", "data-id": item.id });
    var main = el("button", "tray-card-main", { type: "button" });
    if (item.kind !== "switch" && item.kind !== "list" && item.kind !== "servings") main.appendChild(trayThumb(item));
    var cls = item.kind === "new" ? (item.draft ? "kicker-draft" : "") : item.kind === "next" ? (item.add ? "kicker-next" : "") : kind.cls;
    var k = el("p", "kicker" + (cls ? " " + cls : ""));
    k.textContent = item.kind === "next" && !item.add ? "Off next week" : kind.label;
    var t = el("h3", "tray-title");
    t.textContent = item.title;
    var sub = el("p", "tray-sub");
    sub.textContent = item.sub;
    main.appendChild(k);
    main.appendChild(t);
    if (item.sub) main.appendChild(sub);
    var who = el("p", "tray-who");
    who.textContent = "Added by " + item.added_by;
    main.appendChild(who);
    if (item.reason) {
      var why = el("p", "tray-who tray-why"); // its own line, so a longer reason wraps instead of cutting the name off
      why.textContent = item.reason;
      main.appendChild(why);
    }
    if (item.clash) {
      var c = el("p", "tray-problem");
      c.textContent = item.clash.reason;
      main.appendChild(c);
    } else if (item.error) {
      var e = el("p", "tray-problem");
      e.textContent = item.error;
      main.appendChild(e);
    } else if (item.photo && item.photo.status === "failed") {
      var pf = el("p", "tray-problem");
      pf.textContent = "The photo didn't work: " + (item.photo.error || "try again");
      main.appendChild(pf);
    }
    main.addEventListener("click", function () {
      if (item.clash) {
        // the bot resolves clashes: tapping the flagged card asks it
        send("Saving hit a clash on " + item.title + ": " + item.clash.reason + ". Help me resolve it.");
      } else {
        trayDetail = trayDetail === item.id ? null : item.id;
        revealDetail = !!trayDetail;
        renderTray();
      }
    });
    card.appendChild(main);
    var drop = iconButton("tray-drop", "Drop from the tray: " + item.title, ICON.close);
    drop.addEventListener("click", function () {
      drop.disabled = true;
      trayCall("DELETE", "/plan/items/" + item.id).then(function () { if (trayDetail === item.id) trayDetail = null; loadTray(); });
    });
    card.appendChild(drop);
    var acts = el("div", "tray-card-actions");
    if (item.photo) {
      var np = el("button", "text-button tray-link", { type: "button" });
      np.textContent = "New photo";
      np.disabled = item.photo.status === "pending";
      np.addEventListener("click", function () {
        np.disabled = true;
        trayCall("POST", "/plan/items/" + item.id + "/photo").then(function () { loadTray(); });
      });
      acts.appendChild(np);
    }
    if (item.save_now) {
      var sn = el("button", "text-button tray-link", { type: "button" });
      sn.textContent = "Save now";
      sn.addEventListener("click", function () { saveTray(item.id); });
      acts.appendChild(sn);
    }
    if (acts.children.length) card.appendChild(acts);
    return card;
  }

  function trayDetailEl(item) {
    var box = el("div", "tray-detail");
    var h = el("h3", "tray-detail-title");
    h.textContent = item.title;
    box.appendChild(h);
    if (item.detail) {
      var hi = el("h4", "tray-detail-h");
      hi.textContent = "Ingredients";
      var ul = el("ul");
      item.detail.ingredients.forEach(function (x) { var li = el("li"); inlineToDom(doc, parseInline(x), origin, li); ul.appendChild(li); });
      var hs = el("h4", "tray-detail-h");
      hs.textContent = "Instructions";
      var ol = el("ol");
      item.detail.steps.forEach(function (x) { var li = el("li"); inlineToDom(doc, parseInline(x), origin, li); ol.appendChild(li); }); // **bold** ingredient names
      box.appendChild(hi);
      box.appendChild(ul);
      box.appendChild(hs);
      box.appendChild(ol);
      if (item.detail.notes) {
        var n = el("p", "tray-detail-notes");
        n.textContent = item.detail.notes;
        box.appendChild(n);
      }
    } else if (item.preview) {
      item.preview.forEach(function (sec) {
        var hh = el("h4", "tray-detail-h");
        hh.textContent = sec.name;
        var l = el("ul");
        sec.items.forEach(function (x) { var li = el("li"); li.textContent = x; l.appendChild(li); });
        box.appendChild(hh);
        box.appendChild(l);
      });
    } else {
      var p = el("p", "tray-detail-notes");
      p.textContent = item.sub || "";
      box.appendChild(p);
    }
    var close = el("button", "text-button is-quiet", { type: "button" });
    close.textContent = "Close";
    close.addEventListener("click", function () { trayDetail = null; renderTray(); });
    box.appendChild(close);
    return box;
  }

  /** The Save chip's count follows the tray as it is now, whatever it was when the chip was drawn. */
  function refreshActionChips() {
    Array.prototype.forEach.call(log.querySelectorAll('.chat-chip.is-action[data-action="apply_plan"]'), function (chip) {
      chip.textContent = PLAN_LABELS.apply_plan + (trayData && trayData.count ? " (" + trayData.count + ")" : "");
    });
  }

  function readingEl() {
    var box = el("div", "tray-reading", { role: "status" });
    trayReading.forEach(function (e) {
      var line = el("p", "tray-reading-line");
      line.textContent = readingLine(e);
      box.appendChild(line);
    });
    return box;
  }

  function renderTray(opts) {
    refreshActionChips();
    while (tray.firstChild) tray.removeChild(tray.firstChild);
    if (mode === "editor" && trayReading.length && (!trayData || !trayData.count)) {
      // nothing staged yet, but photos are being read (someone's): the strip says so, nothing to save
      tray.hidden = false;
      panel.classList.add("has-tray");
      tray.classList.remove("is-folded");
      tray.appendChild(readingEl());
      return;
    }
    if (!trayData || mode !== "editor" || !trayData.count) {
      tray.hidden = true;
      panel.classList.remove("has-tray");
      return;
    }
    tray.hidden = false;
    panel.classList.add("has-tray");
    var folded = trayFolded();
    tray.classList.toggle("is-folded", folded);
    var head = el("button", "tray-head", { type: "button", "aria-expanded": folded ? "false" : "true" });
    var label = el("span", "tray-head-label");
    label.textContent = trayLine(trayData, folded);
    if (folded && trayManualFold && trayChanged) {
      var dot = el("span", "tray-dot", { title: "Changed since you folded it" });
      var sr = el("span", "sr-only");
      sr.textContent = " · changed";
      label.appendChild(dot);
      label.appendChild(sr);
    }
    var chev = el("span", "tray-chev");
    chev.innerHTML = ICON.chevron; // our own constant markup
    head.appendChild(label);
    head.appendChild(chev);
    head.addEventListener("click", function () {
      if (folded) {
        if (autoFold || reviewLive()) autoFoldSuppressed = true; // tapped open while it was folded on its own
        if (keyboardOpen) keyboardForcedOpen = true;
        setManualFold(false);
      } else {
        keyboardForcedOpen = false;
        setManualFold(true); // stays folded for this tab until tapped open again
      }
      renderTray();
    });
    tray.appendChild(head);
    if (folded) return;
    var bl = balanceLine(trayData.balance);
    if (bl) {
      var bal = el("p", "tray-balance");
      bal.textContent = bl;
      tray.appendChild(bal);
    }

    var scroller = el("div", "tray-scroll"); // the cards and details scroll here; the button below never overlaps them
    tray.appendChild(scroller);
    if (trayReading.length) scroller.appendChild(readingEl()); // "Reading 3 photos · Sam": not tray items, nothing to save
    var notice = trayExpiryNotice(trayData, Date.now());
    var btn = trayButton(trayData);
    if (notice) {
      var nb = el("div", "tray-notice");
      var nt = el("span");
      nt.textContent = notice;
      nb.appendChild(nt);
      if (btn.kind === "finalise" || btn.kind === "save") {
        var nbtn = el("button", "chat-chip", { type: "button" });
        nbtn.textContent = btn.kind === "save" ? "Save to site" : "Finalise list";
        nbtn.addEventListener("click", function () { pressTray(btn.kind === "save" ? "apply_plan" : "finalise_plan"); });
        nb.appendChild(nbtn);
      }
      scroller.appendChild(nb);
    }
    var row = el("div", "tray-cards", { role: "list", "aria-label": "Changes in the tray" });
    var fresh = [];
    trayData.items.forEach(function (item) {
      var isNew = !!(opts && opts.highlight && opts.seen && !opts.seen[item.id]);
      if (isNew) fresh.push(item.id);
      row.appendChild(trayCard(item, isNew));
    });
    scroller.appendChild(row);
    var open = trayDetail && trayData.items.filter(function (i) { return i.id === trayDetail; })[0];
    if (open) {
      var detailEl = trayDetailEl(open);
      scroller.appendChild(detailEl);
      if (revealDetail) {
        revealDetail = false;
        // the tray scrolls inside .tray-scroll and the button sits in its own row below, so "nearest" is enough
        if (detailEl.scrollIntoView) detailEl.scrollIntoView({ block: "nearest" });
      }
    }
    if (trayMsg) {
      var m = el("p", "tray-msg", { role: "status" });
      m.textContent = trayMsg;
      scroller.appendChild(m);
    } else if (btn.kind === "blocked" && trayData.blocked) {
      var bm = el("p", "tray-msg");
      bm.textContent = trayData.blocked;
      scroller.appendChild(bm);
    }
    var waitNote = readingSaveNote(trayReading);
    if (waitNote && btn.kind === "save") {
      var wn = el("p", "tray-msg tray-wait");
      wn.textContent = waitNote; // Save still works
      scroller.appendChild(wn);
    }
    var go = el("button", "save-button tray-go", { type: "button" });
    go.textContent = btn.label;
    go.disabled = btn.kind === "finalising" || btn.kind === "blocked" || trayBusy;
    go.addEventListener("click", function () { pressTray(btn.kind === "save" ? "apply_plan" : "finalise_plan"); });
    tray.appendChild(go);
    if (fresh.length) {
      var target = row.querySelector('[data-id="' + fresh[0] + '"]');
      if (target && target.scrollIntoView) target.scrollIntoView({ inline: "start", block: "nearest" });
      setTimeout(function () { Array.prototype.forEach.call(row.querySelectorAll(".is-new"), function (c) { c.classList.remove("is-new"); }); }, 4000);
    }
  }

  function trayCall(method, path, body) {
    return authedFetch(apiBase + path, { method: method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  function scheduleTrayPoll() {
    clearTimeout(trayTimer);
    if ((!trayData && !trayReading.length) || panel.hidden || mode !== "editor") return;
    if (!trayData) {
      trayTimer = setTimeout(function () { loadTray({ highlight: true }); }, 10000);
      return;
    }
    var waiting = trayReading.length > 0 || trayData.state === "finalising" || trayData.items.some(function (i) { return i.photo && i.photo.status === "pending"; });
    if (waiting) trayTimer = setTimeout(function () { loadTray({ highlight: true }); }, 10000); // each load is a server dry run: poll slowly, and only while something is pending
  }

  /** Fetches the household's tray and draws it. highlight: cards that weren't there before get the new-card treatment and the row scrolls to them. */
  var trayLoading = null; // the request in flight: asking again while it runs joins it instead of starting another dry run on the server
  var trayHighlight = false;
  function loadTray(opts) {
    if (mode !== "editor" || !RA || !RA.getSession()) return Promise.resolve();
    if (opts && opts.highlight) trayHighlight = true;
    if (trayLoading) return trayLoading;
    clearTimeout(trayTimer);
    var seq = ++traySeq;
    opts = trayHighlight ? { highlight: true } : opts;
    trayHighlight = false;
    var request = trayCall("GET", "/plan").then(
      function (res) { return res.ok ? res.json() : null; },
      function () { return null; }
    ).then(function (j) {
      if (seq !== traySeq || mode !== "editor" || !j) return;
      var next = cleanTray(j.tray, origin, photoBase);
      trayReading = cleanReading(j.reading);
      var wasSeen = traySeen;
      traySeen = {};
      if (next) next.items.forEach(function (i) { traySeen[i.id] = true; });
      if (!wasSeen && opts && opts.highlight === undefined) opts = {};
      trayData = next;
      var landed = wasSeen && next && next.items.some(function (i) { return !wasSeen[i.id]; });
      var gone = wasSeen && Object.keys(wasSeen).some(function (id) { return !traySeen[id]; });
      if (landed) autoFold = false; // something new landed: show it (unless the reader folded it: then the dot says so)
      if ((landed || gone) && trayManualFold && !trayChanged) {
        trayChanged = true;
        saveTrayFold();
      }
      if (trayDetail && (!next || !next.items.some(function (i) { return i.id === trayDetail; }))) trayDetail = null;
      renderTray(opts && opts.highlight && wasSeen ? { highlight: true, seen: wasSeen } : null); // compared with what was shown BEFORE this load
      scheduleTrayPoll();
    });
    trayLoading = request;
    var done = function () { if (trayLoading === request) trayLoading = null; };
    request.then(done, done);
    return request;
  }

  function clearTray() {
    trayLoading = null;
    traySeq++;
    trayData = null;
    trayReading = [];
    traySeen = null;
    trayMsg = "";
    trayDetail = null;
    clearTimeout(trayTimer);
    renderTray();
  }

  /** The two buttons the tray has (and the chips that press them): Finalise list, and Save to site. Always a tap by a person. */
  function pressTray(action) {
    if (streaming || !trayData) return;
    if (action === "finalise_plan") {
      if (trayData.state === "finalising") return;
      // the drafts review card is still open: answering it is the next step of Finalise, so take them there instead of starting over
      var openReview = log.querySelector(".chat-review:not(.is-old)");
      if (openReview) {
        openReview.scrollIntoView({ block: "nearest", behavior: "smooth" });
        var first = openReview.querySelector(".chat-review-done");
        if (first) first.focus({ preventScroll: true });
        return;
      }
      trayData.state = "finalising";
      renderTray();
      send("Finalise list", { action: "finalise" });
    } else if (action === "apply_plan") {
      var b = trayButton(trayData);
      if (b.kind === "save") saveTray();
      else if (b.kind === "finalise") pressTray("finalise_plan");
    }
  }

  /** Save to site (or Save now on one card): POST /plan/apply. One commit; the summary lands in the chat, new recipes as "Publishing…" cards. */
  function saveTray(itemId) {
    if (trayBusy || streaming) return;
    trayBusy = true;
    trayMsg = itemId ? "Saving that change…" : "Saving…";
    renderTray();
    paintNotice();
    trayCall("POST", "/plan/apply", { item_id: itemId, conversation_id: chat.server && chat.id ? chat.id : undefined })
      .then(function (res) {
        return res.json().then(function (j) { return { status: res.status, body: j || {} }; }, function () { return { status: res.status, body: {} }; });
      })
      .then(
        function (r) {
          trayBusy = false;
          markUnread();
          paintNotice();
          if (r.status === 200) {
            trayMsg = "";
            var msg = { role: "assistant", content: String(r.body.summary || "Saved."), cards: cleanCards(r.body.cards, origin) };
            chat.messages.push(msg);
            retireChips();
            log.appendChild(messageEl(msg, true));
            toBottom();
            watchPublishing();
            loadTray();
          } else if (r.status === 409 && r.body.clash) {
            trayMsg = "";
            loadTray().then(function () {
              send("Saving hit a clash: " + String((r.body.clash[0] && r.body.clash[0].reason) || "a recipe changed on the site") + ". Help me resolve it.");
            });
          } else {
            trayMsg = String(r.body.error || "Couldn't save just now.").slice(0, 200);
            loadTray();
          }
        },
        function (err) {
          trayBusy = false;
          markUnread();
          paintNotice();
          trayMsg = err && err.name === "AuthExpired" ? "" : "Couldn't save just now. Nothing was changed.";
          renderTray();
        }
      );
  }

  // --- "Publishing…": a saved recipe's page isn't live for a minute or two; its card stays inert until the server sees the page ---
  var publishTimer = null;
  var publishTries = 0;
  function watchPublishing() {
    clearTimeout(publishTimer);
    if (mode !== "editor" || !RA) return;
    var slugs = [];
    chat.messages.forEach(function (m) {
      (m.cards || []).forEach(function (c) { if (c.publishing && c.slug && slugs.indexOf(c.slug) === -1) slugs.push(c.slug); });
    });
    if (!slugs.length || publishTries > 60) return;
    publishTimer = setTimeout(function () {
      publishTries++;
      authedFetch(apiBase + "/status?slugs=" + encodeURIComponent(slugs.slice(0, 8).join(","))).then(
        function (res) { return res.ok ? res.json() : null; },
        function () { return null; }
      ).then(function (j) {
        var live = (j && j.live) || {};
        var changed = false;
        chat.messages.forEach(function (m) {
          (m.cards || []).forEach(function (c) { if (c.publishing && live[c.slug] === true) { c.publishing = false; changed = true; } });
        });
        if (changed && !streaming) renderAll();
        else watchPublishing();
      });
    }, publishTries ? 6000 : 3000);
  }

  // The tray folds to one line while the on-screen keyboard is up, and opens again when it closes or a message is sent.
  function checkKeyboard() {
    var vv = window.visualViewport;
    var open = !!vv && window.innerHeight - vv.height > 120 && doc.activeElement === input;
    if (open === keyboardOpen) return;
    keyboardOpen = open;
    panel.classList.toggle("kb-open", open);
    if (!open) keyboardForcedOpen = false;
    if (trayData) renderTray();
  }
  if (window.visualViewport) window.visualViewport.addEventListener("resize", checkKeyboard);
  input.addEventListener("focus", function () {
    checkKeyboard();
    // iOS can report the viewport before the keyboard has finished sliding up: measure again once it has.
    setTimeout(function () { layoutPanel(); checkKeyboard(); if (!panel.hidden) toBottom(); }, 350);
  });
  input.addEventListener("blur", function () { setTimeout(checkKeyboard, 50); });

  // --- panel open / close / new chat ------------------------------------------------------------------------------------------
  function open(opts) {
    if (!panel.hidden) return;
    panel.hidden = false;
    bubble.setAttribute("aria-expanded", "true");
    doc.body.classList.add("chat-open");
    unread = false;
    if (lastReplyAt) markSeen(lastReplyAt);
    paintNotice();
    paintContext();
    layoutPanel();
    toBottom();
    if (mode === "editor") loadTray();
    if (!(opts && opts.restore)) input.focus({ preventScroll: true }); // a restored panel must not pop the keyboard up
    saveUi();
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    bubble.setAttribute("aria-expanded", "false");
    doc.body.classList.remove("chat-open");
    paintNotice();
    bubble.focus({ preventScroll: true });
    saveUi();
  }
  function newChat() {
    if (streaming) streaming.abort();
    streaming = null;
    setBusy(false);
    pending = [];
    creating = null;
    photoNote = "";
    paintShelf();
    schedulePhotoPoll(null);
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
  // --- photos to send ------------------------------------------------------------------------------------------------------------
  // Each picked photo is decoded and redrawn on a canvas at most 1600px on the long edge as a JPEG (no EXIF leaves the phone, and the upload
  // stays small); the server checks and re-encodes it again. It is uploaded at once, on its own (POST /chat/uploads), while the editor types,
  // so sending is instant: { url (a local preview), data (the JPEG as a data URL), state: uploading | done | failed | local, path, promise }.
  // "local": the server has no upload route (an older one): the photo goes with the message as data, as before.
  var MAX_PHOTOS = 8;
  var pending = [];
  var photoNote = "";
  var sendQueued = false;
  var creating = null; // the first upload of a chat that doesn't exist yet makes it; the others wait for its id
  function uploadPhoto(p) {
    p.state = "uploading";
    var post = function (convId) {
      return authedFetch(apiBase + "/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: p.data, conversation_id: convId || undefined }) }).then(function (res) {
        return res.json().then(
          function (j) {
            if (res.status === 404 && j && j.error === "Not found") return { local: true }; // an older server without the upload route
            if (!res.ok) throw new Error((j && j.error) || "upload");
            return j;
          },
          function () { throw new Error("upload"); }
        );
      });
    };
    var forChat = chat;
    var run;
    if (chat.id) run = post(chat.id);
    else if (creating) {
      run = creating.then(function (id) {
        if (id === "local") return { local: true };
        if (!id) throw new Error("upload"); // the first one failed: retry this one by hand
        return post(id);
      });
    } else {
      run = post(null);
      var mine = (creating = run.then(function (j) { return j && j.local ? "local" : j && j.conversation_id; }, function () { return null; }));
      mine.then(function () { if (creating === mine) creating = null; });
    }
    p.promise = run.then(
      function (j) {
        if (chat !== forChat || pending.indexOf(p) === -1) return; // a new chat, or the photo was removed meanwhile
        if (j.local) {
          p.state = "local";
        } else {
          if (!chat.id && typeof j.conversation_id === "string") {
            chat.id = j.conversation_id; // the upload made the chat: the message goes to it
            rememberEditorChat();
            saveUi();
          }
          if (j.conversation_id !== chat.id || typeof j.path !== "string") throw new Error("moved");
          p.path = j.path;
          p.state = "done";
        }
        paintShelf();
      }
    ).then(null, function (err) {
      if (pending.indexOf(p) === -1) return;
      p.state = "failed";
      if (err && err.message && err.message !== "upload" && err.message !== "moved") photoNote = err.message;
      paintShelf();
    });
    paintShelf();
    return p.promise;
  }
  function paintShelf() {
    while (shelf.firstChild) shelf.removeChild(shelf.firstChild);
    var before = chatPhotoCount();
    pending.forEach(function (p, i) {
      var chip = el("div", "chat-attachment" + (p.state === "uploading" ? " is-uploading" : p.state === "failed" ? " is-failed" : ""));
      chip.appendChild(el("img", "chat-attachment-img", { src: p.url, alt: "Photo " + (before + i + 1) }));
      var num = el("span", "chat-photo-num", { "aria-hidden": "true" });
      num.textContent = String(before + i + 1); // the number it will have in this chat
      chip.appendChild(num);
      if (p.state === "uploading") {
        var spin = el("span", "chat-attachment-state", { role: "status" });
        spin.textContent = "Uploading…";
        chip.appendChild(spin);
      } else if (p.state === "failed") {
        var again = el("button", "chat-attachment-state", { type: "button" });
        again.textContent = "Retry";
        again.addEventListener("click", function () {
          photoNote = "";
          uploadPhoto(p);
        });
        chip.appendChild(again);
      }
      var x = iconButton("chat-attachment-remove", "Remove photo " + (before + i + 1), ICON.close);
      x.addEventListener("click", function () {
        pending.splice(pending.indexOf(p), 1);
        paintShelf();
        input.focus({ preventScroll: true }); // the button is gone: keep focus somewhere sensible
      });
      chip.appendChild(x);
      shelf.appendChild(chip);
    });
    if (photoNote) {
      var n = el("p", "chat-attachment-note", { role: "status" });
      n.textContent = photoNote;
      shelf.appendChild(n);
    }
    shelf.hidden = !pending.length && !photoNote;
    attachBtn.disabled = pending.length >= MAX_PHOTOS;
  }
  function downscale(file) {
    return new Promise(function (resolve, reject) {
      var src = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (!w || !h) return reject(new Error("size"));
        var attempt = [[1600, 0.82], [1600, 0.68], [1280, 0.6], [1000, 0.55]];
        var data = "";
        for (var i = 0; i < attempt.length; i++) {
          var k = Math.min(1, attempt[i][0] / Math.max(w, h));
          var c = doc.createElement("canvas");
          c.width = Math.max(1, Math.round(w * k));
          c.height = Math.max(1, Math.round(h * k));
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          data = c.toDataURL("image/jpeg", attempt[i][1]);
          if (data.length < 1100000) break; // ~800 KB of JPEG: four of them stay under the request limit
        }
        resolve({ url: src, data: data });
      };
      img.onerror = function () {
        URL.revokeObjectURL(src);
        reject(new Error("decode"));
      };
      img.src = src;
    });
  }
  /** How many photos this chat already has (the next one picked is that + 1). */
  function chatPhotoCount() {
    var n = 0;
    chat.messages.forEach(function (m) {
      if (m.role !== "user" || !m.images) return;
      var top = m.numbers && m.numbers.length ? m.numbers[m.numbers.length - 1] : 0;
      n = Math.max(n + m.images.length, top);
    });
    return n;
  }
  attachBtn.addEventListener("click", function () {
    if (!streaming && pending.length < MAX_PHOTOS) picker.click();
  });
  picker.addEventListener("change", function () {
    var picked = Array.prototype.slice.call(picker.files || []);
    var room = MAX_PHOTOS - pending.length;
    var files = picked.slice(0, room);
    picker.value = "";
    photoNote = picked.length > room ? (room ? "Only " + MAX_PHOTOS + " photos per message; added the first " + room + "." : "That's " + MAX_PHOTOS + " photos already, the most for one message: send these first, or remove one.") : "";
    files.reduce(function (chain, file) {
      return chain.then(function () {
        if (!/^image\//.test(file.type || "image/")) { photoNote = (photoNote ? photoNote + " " : "") + "Only photos can be attached."; return; }
        return downscale(file).then(
          function (p) {
            if (pending.length >= MAX_PHOTOS) return;
            pending.push(p);
            if (mode === "editor" && chat.server) uploadPhoto(p);
          },
          function () { photoNote = (photoNote ? photoNote + " " : "") + "Couldn't read one of those photos. Try a JPEG or PNG."; }
        );
      });
    }, Promise.resolve()).then(paintShelf);
  });

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }
  input.addEventListener("input", function () {
    autosize();
    saveUi();
  });
  window.addEventListener("pagehide", function () {
    leaving = true;
    saveUi();
  });
  window.addEventListener("beforeunload", function () { leaving = true; });
  window.addEventListener("pageshow", function (e) { if (e.persisted) leaving = false; }); // back from the bfcache: alive again

  // Scrolling up in the conversation folds the tray (phones), so the older messages get the room. It opens again on a tap, a new card or the end of a turn.
  var lastLogTop = 0;
  var foldLockUntil = 0;
  log.addEventListener("scroll", function () {
    var top = log.scrollTop;
    var up = top < lastLogTop - 4;
    lastLogTop = top;
    if (!up || Date.now() < foldLockUntil || !narrowScreen() || !trayData || autoFold) return;
    if (log.scrollHeight - top - log.clientHeight > 120) {
      foldLockUntil = Date.now() + 500; // folding resizes the log: ignore the scroll events that causes
      setAutoFold(true);
    }
  }, { passive: true });

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
  paintBubble();
  paintNotice();
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
