// Shopping page enhancement. Re-renders #shopping-app (and the account button in
// #shopping-account) from the JSON the build embedded (#shopping-data); it never loads the
// list at runtime. Adds:
// - the servings picker (1/2/4 per recipe, from the list's 2-serving base),
// - ticks while shopping, kept in this browser only (anyone can use them),
// - for the signed-in editor: the "At home" tab, where each row is a fill bar (slide across
//   it for some, tap the house for all). Edits stay in this browser until Save, which sends
//   them in one go to the MCP server's /stocktake endpoint (one commit, one deploy).
// Sign-in is Supabase Auth's email code (the same email also has a magic link), called over
// its REST API (no client library). The UI patterns are described in design.md.
(function () {
  "use strict";
  var dataEl = document.getElementById("shopping-data");
  var app = document.getElementById("shopping-app");
  var accountEl = document.getElementById("shopping-account");
  if (!dataEl || !app) return;
  var data = JSON.parse(dataEl.textContent);
  var auth = data.auth;

  // --- storage (can throw in private mode / blocked storage: everything still works without it) ---
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }
  var TICKS_KEY = "shopping-ticks:" + data.version;
  var PENDING_KEY = "shopping-stocktake:" + data.version;
  var DRAFT_KEY = "shopping-draft:" + data.version;
  var SESSION_KEY = "shopping-editor-session";
  var EMAIL_KEY = "shopping-editor-email";
  try {
    // Ticks, unsaved edits and saved-but-not-yet-deployed stocktakes belong to one list: drop other lists' ones.
    Object.keys(localStorage).forEach(function (k) {
      if (/^shopping-(ticks|stocktake|draft):/.test(k) && [TICKS_KEY, PENDING_KEY, DRAFT_KEY].indexOf(k) === -1) {
        localStorage.removeItem(k);
      }
    });
  } catch (e) {}

  var items = [];
  data.sections.forEach(function (section, si) {
    section.items.forEach(function (item, ii) {
      item.id = si + "-" + ii;
      items.push(item);
    });
  });
  var byId = {};
  items.forEach(function (item) {
    byId[item.id] = item;
  });

  // The stocktake baked into the page, or a newer one saved from this browser that the site
  // hasn't redeployed with yet.
  var have = {};
  items.forEach(function (item) {
    if (item.have !== undefined) have[item.id] = item.have;
  });
  var stocktakeAt = data.stocktake;
  var pending = load(PENDING_KEY, null);
  if (pending && pending.saved && (!data.stocktake || pending.saved > data.stocktake)) {
    have = pending.have;
    stocktakeAt = pending.saved;
  } else save(PENDING_KEY, undefined);

  var storedServings = load("shopping-servings", data.base);
  var state = {
    servings: [1, 2, 4].indexOf(storedServings) === -1 ? data.base : storedServings,
    ticks: load(TICKS_KEY, []),
    have: have,
    stocktakeAt: stocktakeAt,
    savedNow: false,
    draft: load(DRAFT_KEY, null), // unsaved "at home" edits: { id: true | number }
    tab: "list", // list | home (editor only)
    homeOpen: false, // the "Already at home" fold
    collapsed: load("shopping-collapsed", []), // names of the aisle sections folded away (both tabs)
    session: load(SESSION_KEY, null),
    accountOpen: false,
    sheet: null, // null | email | code
    email: load(EMAIL_KEY, ""),
    code: "",
    sheetMessage: null,
    message: null, // { text, error }
    busy: false,
  };

  function isEditor() {
    return !!(auth && state.session);
  }

  // --- quantities ---
  var METRIC = /^(g|kg|ml|l)$/i;
  var FRACTIONS = [[0, ""], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""]];

  function formatNumber(value, unit) {
    if (METRIC.test(unit)) return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
    if (value >= 10) return String(Math.round(value));
    var whole = Math.floor(value);
    var frac = value - whole;
    var best = FRACTIONS[0];
    FRACTIONS.forEach(function (f) {
      if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
    });
    if (best[0] === 1) return String(whole + 1);
    if (whole === 0 && best[0] === 0) return "⅛";
    return (whole ? String(whole) : "") + best[1];
  }
  function withUnit(text, unit) {
    return text + (!unit ? "" : METRIC.test(unit) ? unit : " " + unit);
  }
  function factor() {
    return state.servings / data.base;
  }
  function need(item) {
    return item.amount === undefined ? null : item.amount * factor();
  }
  function needText(item) {
    if (item.amount === undefined) return item.quantity || "";
    return factor() === 1 ? item.quantity : withUnit(formatNumber(need(item), item.unit), item.unit);
  }
  function amountText(item, value) {
    return withUnit(formatNumber(value, item.unit), item.unit);
  }
  // Slider steps: halves for a few of something, else 1; grams and millilitres by a round step that suits the amount.
  function stepFor(item) {
    var n = need(item);
    if (!METRIC.test(item.unit)) return n < 4 ? 0.5 : 1;
    return n >= 1000 ? 100 : n >= 400 ? 50 : n >= 100 ? 25 : n >= 30 ? 10 : 5;
  }

  /** { status: "buy" | "partial" | "home", left } at the chosen servings, for a stocktake `h`. */
  function remaining(item, h) {
    var v = h[item.id];
    if (v === true) return { status: "home", left: 0 };
    if (typeof v === "number" && v > 0 && item.amount !== undefined) {
      var left = need(item) - v;
      return left > 1e-9 ? { status: "partial", left: left } : { status: "home", left: 0 };
    }
    return { status: "buy", left: need(item) };
  }
  // What the editor sees is their unsaved edits; everyone else sees the saved stocktake.
  function effective() {
    return isEditor() && state.draft ? state.draft : state.have;
  }
  function norm(v) {
    return v === true ? true : typeof v === "number" && v > 0 ? v : 0;
  }
  function changedCount() {
    if (!state.draft) return 0;
    return items.filter(function (item) {
      return norm(state.draft[item.id]) !== norm(state.have[item.id]);
    }).length;
  }
  function counts(h) {
    var c = { buy: 0, home: 0, partly: 0 };
    items.forEach(function (item) {
      var s = remaining(item, h).status;
      if (s === "home") c.home++;
      else {
        c.buy++;
        if (s === "partial") c.partly++;
      }
    });
    return c;
  }
  function shortDate(iso) {
    var d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  // --- icons (the house family is the page's icon language, see design.md; duplicated in shopping-list.js) ---
  function svg(body, cls, filled) {
    return (
      '<svg class="' + (cls || "icon") + '" viewBox="0 0 24 24" fill="' + (filled ? "currentColor" : "none") +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>"
    );
  }
  var HOUSE = '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>';
  var ICON = {
    house: svg(HOUSE),
    houseSome: function (cls) {
      return svg(HOUSE + '<rect x="5" y="14" width="14" height="6" fill="currentColor"/>', cls);
    },
    houseAll: svg('<path d="M3 11l9-7 9 7v9H3z"/>', "icon", true),
    houseClear: svg(HOUSE + '<path d="M9 13l6 6M15 13l-6 6"/>'),
    cart: svg('<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>'),
    slide: svg('<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
    check: svg('<path d="M5 12l5 5 9-10"/>'),
    undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>', "icon chevron"),
  };

  // --- rendering ---
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function noteHtml(item) {
    return item.note ? '<span class="shop-note">' + esc(item.note) + "</span>" : "";
  }
  /** An aisle section; tapping its heading folds it away (a <details>, so it also works without JS). */
  function sectionHtml(name, count, rows) {
    var open = state.collapsed.indexOf(name) === -1;
    return (
      '<details class="shop-section" data-section="' + esc(name) + '"' + (open ? " open" : "") + "><summary><h2>" + esc(name) + "</h2>" +
      '<span class="section-count">' + count + "</span>" + ICON.chevron + '</summary><ul class="shop-list">' + rows + "</ul></details>"
    );
  }
  function messageHtml() {
    if (!state.message) return "";
    return '<p class="shopping-status' + (state.message.error ? " is-error" : "") + '" role="status">' + esc(state.message.text) + "</p>";
  }

  function accountHtml() {
    if (!auth) return "";
    if (!state.session) {
      return '<button type="button" class="pill" data-act="signin" data-focus="signin">' + ICON.person + "Sign in</button>";
    }
    var email = state.session.email || "";
    var html =
      '<button type="button" class="avatar" data-act="account" data-focus="account" aria-expanded="' + state.accountOpen +
      '" aria-label="Signed in as ' + esc(email || "editor") + '">' + esc((email || "E").charAt(0).toUpperCase()) + "</button>";
    if (state.accountOpen) {
      html +=
        '<div class="account-menu"><p>Signed in as ' + esc(email || "editor") + "</p>" +
        '<button type="button" class="text-button" data-act="signout">Sign out</button></div>';
    }
    return html;
  }

  function tabsHtml() {
    var c = counts(effective());
    var dirty = changedCount() > 0;
    var tab = function (id, icon, count, label, extra) {
      return (
        '<button type="button" role="tab" data-tab="' + id + '" data-focus="tab-' + id + '" aria-selected="' + (state.tab === id) +
        '" aria-label="' + label + '">' + icon + "<span>" + count + "</span>" + (extra || "") + "</button>"
      );
    };
    return (
      '<div class="tabs" role="tablist" id="shop-tabs">' +
      tab("list", ICON.cart, c.buy, "Shopping list, " + c.buy + " to buy") +
      tab("home", ICON.house, c.home, "At home, " + c.home + " items" + (dirty ? ", unsaved changes" : ""), dirty ? '<span class="unsaved-dot"></span>' : "") +
      "</div>"
    );
  }

  function servingsHtml() {
    var html = '<div class="shop-card"><span>Servings of each recipe</span><div class="seg" role="group" aria-label="Servings of each recipe">';
    [1, 2, 4].forEach(function (n) {
      html += '<button type="button" data-serves="' + n + '" data-focus="serves-' + n + '" aria-pressed="' + (n === state.servings) + '">' + n + "</button>";
    });
    return html + "</div></div>";
  }

  function homeCardHtml() {
    if (!state.stocktakeAt && !auth) return "";
    var c = counts(effective());
    var title = state.stocktakeAt ? "Home checked " + shortDate(state.stocktakeAt) : "Home not checked yet";
    var sub = c.home || c.partly ? c.home + " at home, " + c.partly + " partly. Already taken off." : "Everything is on the list.";
    if (changedCount()) sub += " Not saved yet.";
    return (
      '<div class="home-card">' + ICON.houseSome() +
      '<span class="home-card-text"><strong>' + esc(title) + "</strong><span>" + esc(sub) + "</span></span>" +
      (auth ? '<button type="button" class="text-button" data-act="update" data-focus="update">Update</button>' : "") +
      "</div>"
    );
  }

  function shopRow(item, r) {
    var ticked = state.ticks.indexOf(item.id) !== -1;
    var partial = r.status === "partial";
    var qty = partial ? amountText(item, r.left) : needText(item);
    var some = partial
      ? ICON.houseSome("icon icon-some") +
        '<span class="sr-only">(have ' + esc(amountText(item, effective()[item.id])) + " of " + esc(needText(item)) + " at home)</span>"
      : "";
    return (
      '<li><label class="shop-item"><input type="checkbox" class="tick" data-tick="' + item.id + '" data-focus="tick-' + item.id + '"' +
      (ticked ? " checked" : "") + '><span class="shop-name">' + esc(item.name) + noteHtml(item) + "</span>" + some +
      '<span class="shop-qty">' + esc(qty) + "</span></label></li>"
    );
  }

  function listViewHtml() {
    var h = effective();
    var html = messageHtml() + servingsHtml() + homeCardHtml();
    var home = [];
    var shown = 0;
    data.sections.forEach(function (section) {
      var rows = [];
      section.items.forEach(function (item) {
        var r = remaining(item, h);
        if (r.status === "home") home.push(item);
        else {
          rows.push(shopRow(item, r));
          shown++;
        }
      });
      if (rows.length) html += sectionHtml(section.name, rows.length, rows.join(""));
    });
    if (!shown) html += '<p class="shopping-empty">Everything on the list is already at home.</p>';
    if (home.length) {
      html +=
        '<details class="shop-home" data-details="home"' + (state.homeOpen ? " open" : "") + "><summary>Already at home (" + home.length + ")</summary><ul>" +
        home.map(function (item) {
          return "<li><span>" + esc(item.name) + "</span><span>" + esc(needText(item)) + "</span></li>";
        }).join("") +
        "</ul></details>";
    }
    if (state.ticks.length) {
      html += '<div class="shop-footer"><button type="button" class="text-button is-quiet" data-act="clear-ticks">Start again (untick all)</button></div>';
    }
    return html;
  }

  /** How a row on the "At home" tab looks for the unsaved edits. */
  function rowState(item) {
    var v = state.draft ? state.draft[item.id] : state.have[item.id];
    var n = need(item);
    var level = v === true || (typeof v === "number" && n !== null && v >= n - 1e-9) ? "all" : typeof v === "number" && v > 0 ? "some" : "none";
    var amt =
      level === "some" ? formatNumber(v, item.unit) + " / " + withUnit(formatNumber(n, item.unit), item.unit) : needText(item);
    return {
      level: level,
      value: typeof v === "number" ? Math.min(v, n) : level === "all" ? n : 0,
      pct: level === "all" ? 100 : level === "some" ? Math.round((v / n) * 100) : 0,
      amt: amt,
      changed: !!state.draft && norm(state.draft[item.id]) !== norm(state.have[item.id]),
    };
  }

  function fillRowHtml(item) {
    var s = rowState(item);
    var hasRange = item.amount !== undefined;
    var html =
      '<li class="fill-row' + (hasRange ? " has-range" : "") + (s.changed ? " is-changed" : "") + '" data-row="' + item.id +
      '" data-level="' + s.level + '" style="--fill: ' + s.pct + '%">' +
      '<span class="fill-name">' + esc(item.name) + "</span>" +
      '<span class="fill-amt">' + esc(s.amt) + "</span>";
    if (hasRange) {
      html +=
        '<input type="range" class="fill-range" data-range="' + item.id + '" data-focus="range-' + item.id + '" min="0" max="' + need(item) +
        '" step="' + stepFor(item) + '" value="' + s.value + '" aria-label="' + esc(item.name) + ', how much is at home" aria-valuetext="' + esc(s.amt) + '">';
    }
    return (
      html +
      '<button type="button" class="fill-house" data-house="' + item.id + '" data-focus="house-' + item.id + '" aria-pressed="' + (s.level === "all") +
      '" aria-label="' + esc(item.name) + ', have it all">' + (s.level === "all" ? ICON.houseAll : ICON.house) + "</button></li>"
    );
  }

  function saveBarHtml() {
    var n = changedCount();
    var html = '<div class="save-bar" id="save-bar">';
    if (state.busy) {
      html += '<button type="button" class="save-button" disabled>Saving…</button>';
    } else if (n) {
      html +=
        '<button type="button" class="icon-button" data-act="discard" data-focus="discard" aria-label="Undo unsaved changes">' + ICON.undo + "</button>" +
        '<button type="button" class="save-button" data-act="save" data-focus="save" aria-label="Save ' + n + " change" + (n === 1 ? "" : "s") +
        '">Save <span class="save-count">' + n + "</span></button>";
    } else {
      var text = state.savedNow ? "Saved just now" : state.stocktakeAt ? "Saved " + shortDate(state.stocktakeAt) : "Nothing saved yet";
      html += '<div class="saved-state" role="status">' + ICON.check + esc(text) + "</div>";
    }
    return html + "</div>";
  }

  function homeViewHtml() {
    var html =
      messageHtml() +
      '<p class="home-hint" aria-hidden="true"><span>' + ICON.slide + "slide or tap sides = some</span><span>" + ICON.houseAll + "tap = all</span></p>";
    data.sections.forEach(function (section) {
      html += sectionHtml(section.name, section.items.length, section.items.map(fillRowHtml).join(""));
    });
    html +=
      '<div class="home-tools"><button type="button" class="icon-button" data-act="reset-home" data-focus="reset-home" aria-label="Nothing at home: clear every row">' +
      ICON.houseClear + "</button></div>";
    return html + saveBarHtml();
  }

  function sheetHtml() {
    if (!state.sheet) return "";
    var code = state.sheet === "code";
    var html =
      '<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<div class="sheet-head"><div><h2 id="sheet-title">Update what\'s at home</h2><p>' +
      (code ? "We sent a code to " + esc(state.email) + ". It works on any device." : "Sign in once and you can mark what you already have.") +
      '</p></div><button type="button" class="icon-button" data-act="sheet-close" aria-label="Close">' + ICON.close + "</button></div>";
    if (state.sheetMessage) {
      html += '<p class="shopping-status' + (state.sheetMessage.error ? " is-error" : "") + '" role="status">' + esc(state.sheetMessage.text) + "</p>";
    }
    if (!code) {
      html +=
        '<form data-form="email"><label for="signin-email">Email</label>' +
        '<input id="signin-email" type="email" autocomplete="email" required value="' + esc(state.email) + '" data-focus="signin-email">' +
        '<button type="submit" class="save-button"' + (state.busy ? " disabled" : "") + ">" + (state.busy ? "Sending…" : "Email me a code") + "</button></form>" +
        '<p class="sheet-note">Only family editors can sign in. You\'ll stay signed in on this device.</p>';
    } else {
      html +=
        '<form data-form="code"><label for="signin-code">Code from the email</label>' +
        '<input id="signin-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required value="' +
        esc(state.code) + '" data-focus="signin-code">' +
        '<button type="submit" class="save-button"' + (state.busy ? " disabled" : "") + ">" + (state.busy ? "Signing in…" : "Sign in") + "</button></form>" +
        '<div class="sheet-links"><button type="button" class="text-button is-quiet" data-act="sheet-email">Change email</button>' +
        '<button type="button" class="text-button" data-act="resend"' + (state.busy ? " disabled" : "") + ">Send a new code</button></div>" +
        '<p class="sheet-note">The email also has a sign-in link, if you\'d rather tap that on this device.</p>';
    }
    return html + "</div></div>";
  }

  function render() {
    var focused = document.activeElement && document.activeElement.getAttribute("data-focus");
    if (state.tab === "home" && !isEditor()) state.tab = "list";
    app.innerHTML = (isEditor() ? tabsHtml() : "") + (state.tab === "home" ? homeViewHtml() : listViewHtml()) + sheetHtml();
    if (accountEl) accountEl.innerHTML = accountHtml();
    document.body.classList.toggle("sheet-open", !!state.sheet);
    if (focused) {
      var el = document.querySelector('[data-focus="' + focused + '"]');
      if (el) el.focus();
    }
    // An open sheet keeps focus inside it: on its field, unless something in it already has focus.
    var sheet = app.querySelector(".sheet");
    if (sheet && !sheet.contains(document.activeElement)) sheet.querySelector("input").focus();
  }

  // Dragging updates the row in place (re-rendering would drop the pointer capture), plus the tab counts and the save bar.
  function updateRow(id) {
    var row = app.querySelector('[data-row="' + id + '"]');
    if (!row) return;
    var item = byId[id];
    var s = rowState(item);
    row.style.setProperty("--fill", s.pct + "%");
    row.setAttribute("data-level", s.level);
    row.classList.toggle("is-changed", s.changed);
    row.querySelector(".fill-amt").textContent = s.amt;
    var range = row.querySelector(".fill-range");
    if (range) {
      range.value = s.value;
      range.setAttribute("aria-valuetext", s.amt);
    }
    var house = row.querySelector(".fill-house");
    house.setAttribute("aria-pressed", String(s.level === "all"));
    house.innerHTML = s.level === "all" ? ICON.houseAll : ICON.house;
    var tabs = document.getElementById("shop-tabs");
    if (tabs) tabs.outerHTML = tabsHtml();
    var bar = document.getElementById("save-bar");
    if (bar) bar.outerHTML = saveBarHtml();
  }

  // --- unsaved edits ---
  function ensureDraft() {
    if (!state.draft) state.draft = Object.assign({}, state.have);
  }
  function persistDraft() {
    save(DRAFT_KEY, changedCount() ? state.draft : undefined);
  }
  function setDraft(id, v) {
    ensureDraft();
    if (v === true || (typeof v === "number" && v > 0)) state.draft[id] = v;
    else delete state.draft[id];
    state.savedNow = false;
    persistDraft();
  }
  /** A slider position (0..need) as a stocktake value: all of it is `true`, so it doesn't depend on servings. */
  function fromSlider(item, value) {
    var n = need(item);
    return value >= n - 1e-9 ? true : value;
  }

  // --- Supabase Auth (email code or magic link, REST) ---
  function setSession(session) {
    state.session = session;
    save(SESSION_KEY, session || undefined);
  }
  function emailFromJwt(token) {
    try {
      var payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(payload)))).email || "";
    } catch (e) {
      return "";
    }
  }
  function sessionFrom(tokens) {
    var expiresAt = Number(tokens.expires_at) || Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) || 3600);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      email: (tokens.user && tokens.user.email) || emailFromJwt(tokens.access_token),
    };
  }
  function signedIn(session) {
    setSession(session);
    state.sheet = null;
    state.sheetMessage = null;
    state.code = "";
    state.tab = "home";
  }
  // Coming back from the magic link: Supabase puts the tokens (or an error) in the URL fragment.
  function readRedirect() {
    if (!auth || location.hash.length < 2) return;
    var params = new URLSearchParams(location.hash.slice(1));
    if (params.get("access_token")) {
      signedIn(sessionFrom(Object.fromEntries(params)));
    } else if (params.get("error_description")) {
      state.message = { text: "Sign-in failed: " + params.get("error_description").replace(/\+/g, " ") + ". Try again.", error: true };
    } else {
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
  }
  function authFetch(path, body, token) {
    var headers = { apikey: auth.supabaseKey, "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(auth.supabaseUrl + "/auth/v1/" + path, { method: "POST", headers: headers, body: JSON.stringify(body || {}) });
  }
  function errorReason(res) {
    return res.json().then(
      function (j) {
        return j.msg || j.error_description || j.message || "";
      },
      function () {
        return "";
      }
    );
  }
  function accessToken() {
    var s = state.session;
    if (!s) return Promise.resolve(null);
    if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return authFetch("token?grant_type=refresh_token", { refresh_token: s.refresh_token })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (tokens) {
        if (!tokens || !tokens.access_token) return null;
        setSession(sessionFrom(tokens));
        return tokens.access_token;
      });
  }
  function openSheet(message) {
    state.sheet = "email";
    state.sheetMessage = message || null;
    state.accountOpen = false;
  }
  function signedOut(text) {
    setSession(null);
    openSheet({ text: text, error: true });
  }
  function busyThen(promise, done) {
    state.busy = true;
    render();
    return promise
      .catch(function () {
        done({ text: "Couldn't reach the server. Check your connection and try again.", error: true });
      })
      .then(function () {
        state.busy = false;
        render();
      });
  }
  function sendCode() {
    state.sheetMessage = null;
    save(EMAIL_KEY, state.email);
    var redirect = location.origin + location.pathname;
    busyThen(
      // The email carries both the code ({{ .Token }}) and the magic link back to this page.
      authFetch("otp?redirect_to=" + encodeURIComponent(redirect), { email: state.email, create_user: false }).then(function (res) {
        if (res.ok) {
          state.sheet = "code";
          state.code = "";
          return;
        }
        return errorReason(res).then(function (reason) {
          state.sheetMessage = /signup|not.*found|not allowed/i.test(reason)
            ? { text: "That email can't sign in here.", error: true }
            : { text: "Couldn't send the code" + (reason ? ": " + reason : "") + ".", error: true };
        });
      }),
      function (m) {
        state.sheetMessage = m;
      }
    );
  }
  function verifyCode() {
    state.sheetMessage = null;
    busyThen(
      authFetch("verify", { type: "email", email: state.email, token: state.code }).then(function (res) {
        if (!res.ok) {
          state.sheetMessage = { text: "That code didn't work. Check it, or send a new one.", error: true };
          return;
        }
        return res.json().then(function (tokens) {
          signedIn(sessionFrom(tokens));
        });
      }),
      function (m) {
        state.sheetMessage = m;
      }
    );
  }

  // --- saving the stocktake ---
  function saveStocktake() {
    ensureDraft();
    var draft = state.draft;
    var payload = items.map(function (item) {
      var v = draft[item.id];
      var entry = { name: item.name };
      if (item.quantity) entry.quantity = item.quantity;
      if (v === true || (typeof v === "number" && v > 0)) entry.have = v;
      return entry;
    });
    state.message = null;
    busyThen(
      accessToken().then(function (token) {
        if (!token) {
          signedOut("Your sign-in has expired. Sign in again to save; your changes are kept.");
          return;
        }
        return fetch(auth.api, {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ items: payload }),
        }).then(function (res) {
          return res.json().then(
            function (j) {
              return { res: res, body: j };
            },
            function () {
              return { res: res, body: {} };
            }
          );
        }).then(function (out) {
          if (out.res.ok) {
            var saved = {};
            payload.forEach(function (entry, i) {
              if (entry.have !== undefined) saved[items[i].id] = entry.have;
            });
            state.have = saved;
            state.draft = null;
            state.savedNow = true;
            state.stocktakeAt = out.body.stocktake || new Date().toISOString();
            save(DRAFT_KEY, undefined);
            save(PENDING_KEY, { saved: state.stocktakeAt, have: saved });
          } else if (out.res.status === 401) {
            signedOut(out.body.error || "Sign in again to save; your changes are kept.");
          } else {
            state.message = { text: out.body.error || "Saving failed. Try again.", error: true };
          }
        });
      }),
      function (m) {
        state.message = m;
      }
    );
  }

  // --- events ---
  function onClick(e) {
    if (e.target.classList && e.target.classList.contains("sheet-backdrop")) {
      state.sheet = null;
      return render();
    }
    var el = e.target.closest("button");
    if (!el || el.disabled) return;
    var act = el.getAttribute("data-act");
    if (el.hasAttribute("data-serves")) {
      state.servings = Number(el.getAttribute("data-serves"));
      save("shopping-servings", state.servings);
    } else if (el.hasAttribute("data-tab")) {
      state.tab = el.getAttribute("data-tab");
      state.message = null;
    } else if (el.hasAttribute("data-house")) {
      var id = el.getAttribute("data-house");
      setDraft(id, rowState(byId[id]).level === "all" ? 0 : true);
    } else if (act === "signin") {
      openSheet();
    } else if (act === "update") {
      if (isEditor()) state.tab = "home";
      else openSheet();
    } else if (act === "account") {
      state.accountOpen = !state.accountOpen;
    } else if (act === "signout") {
      var token = state.session && state.session.access_token;
      if (token) authFetch("logout", {}, token).catch(function () {});
      setSession(null);
      state.accountOpen = false;
      state.tab = "list";
    } else if (act === "sheet-close") {
      state.sheet = null;
    } else if (act === "sheet-email") {
      state.sheet = "email";
      state.sheetMessage = null;
    } else if (act === "resend") {
      return sendCode();
    } else if (act === "clear-ticks") {
      state.ticks = [];
      save(TICKS_KEY, undefined);
    } else if (act === "reset-home") {
      ensureDraft();
      state.draft = {};
      state.savedNow = false;
      persistDraft();
    } else if (act === "discard") {
      state.draft = null;
      save(DRAFT_KEY, undefined);
    } else if (act === "save") {
      return saveStocktake();
    } else {
      return;
    }
    render();
  }
  app.addEventListener("click", onClick);
  if (accountEl) accountEl.addEventListener("click", onClick);

  document.addEventListener("click", function (e) {
    // composedPath, not contains(): the clicked button may already have been re-rendered away.
    if (state.accountOpen && accountEl && e.composedPath().indexOf(accountEl) === -1) {
      state.accountOpen = false;
      render();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (state.sheet || state.accountOpen)) {
      state.sheet = null;
      state.accountOpen = false;
      render();
    }
  });

  app.addEventListener("change", function (e) {
    var el = e.target;
    if (!el.hasAttribute("data-tick")) return;
    var id = el.getAttribute("data-tick");
    state.ticks = state.ticks.filter(function (t) {
      return t !== id;
    });
    if (el.checked) state.ticks.push(id);
    save(TICKS_KEY, state.ticks);
    render();
  });

  app.addEventListener("input", function (e) {
    var el = e.target;
    if (el.hasAttribute("data-range")) {
      // Keyboard and screen readers drive the (visually hidden) range input.
      var id = el.getAttribute("data-range");
      setDraft(id, fromSlider(byId[id], Number(el.value)));
      updateRow(id);
    } else if (el.id === "signin-email") {
      state.email = el.value.trim();
    } else if (el.id === "signin-code") {
      state.code = el.value.replace(/\D/g, "");
    }
  });

  // Folded sections and "Already at home" stay as they were across re-renders ("toggle" doesn't bubble).
  app.addEventListener(
    "toggle",
    function (e) {
      var el = e.target;
      if (!el.getAttribute) return;
      if (el.getAttribute("data-details") === "home") state.homeOpen = el.open;
      var name = el.getAttribute("data-section");
      if (name === null) return;
      state.collapsed = state.collapsed.filter(function (n) {
        return n !== name;
      });
      if (!el.open) state.collapsed.push(name);
      save("shopping-collapsed", state.collapsed.length ? state.collapsed : undefined);
    },
    true
  );

  app.addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target.getAttribute("data-form");
    if (form === "email") {
      state.email = document.getElementById("signin-email").value.trim();
      if (state.email) sendCode();
    } else if (form === "code") {
      state.code = document.getElementById("signin-code").value.replace(/\D/g, "");
      if (state.code) verifyCode();
    }
  });

  // Sliding across a fill row sets how much is at home. A tap on its right half adds one step, on its
  // left half takes one away (a scroll doesn't count as a tap: the browser cancels the pointer), a
  // mostly vertical move is left to the page scroll.
  var drag = null;
  function tapAt(x) {
    var rect = drag.row.getBoundingClientRect();
    var item = byId[drag.id];
    var step = stepFor(item);
    var n = need(item);
    var current = rowState(item).value;
    var value = x - rect.left >= rect.width / 2 ? Math.min(n, current + step) : Math.max(0, current - step);
    setDraft(drag.id, value <= 0 ? 0 : fromSlider(item, value));
    updateRow(drag.id);
  }
  function slideTo(x) {
    var rect = drag.row.getBoundingClientRect();
    var frac = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    var item = byId[drag.id];
    var step = stepFor(item);
    var n = need(item);
    var value = frac > 0.97 ? n : Math.round((frac * n) / step) * step;
    setDraft(drag.id, value <= 0 ? 0 : fromSlider(item, value));
    updateRow(drag.id);
  }
  app.addEventListener("pointerdown", function (e) {
    var row = e.target.closest(".fill-row.has-range");
    if (!row || e.target.closest(".fill-house") || e.button > 0) return;
    drag = { id: row.getAttribute("data-row"), row: row, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId };
  });
  app.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      var dx = Math.abs(e.clientX - drag.x);
      var dy = Math.abs(e.clientY - drag.y);
      if (dy > 10 && dy > dx) {
        drag = null;
        return;
      }
      if (dx < 8) return;
      drag.active = true;
      try {
        drag.row.setPointerCapture(e.pointerId);
      } catch (err) {}
    }
    e.preventDefault();
    slideTo(e.clientX);
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var row = drag.row;
    if (!drag.active && e.type === "pointerup") tapAt(e.clientX);
    drag = null;
    try {
      row.releasePointerCapture(e.pointerId);
    } catch (err) {}
  }
  app.addEventListener("pointerup", endDrag);
  app.addEventListener("pointercancel", endDrag);

  readRedirect();
  render();
})();
