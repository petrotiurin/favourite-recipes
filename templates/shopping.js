// Shopping page enhancement. Re-renders #shopping-app (and the account button in
// #shopping-account) from the JSON the build embedded (#shopping-data); it never loads the
// list at runtime. Adds:
// - the servings picker: opens on the agent's plan (servings per recipe, from the list's 2-serving
//   base), "1/2/4" sets every recipe, and "Per recipe" changes single recipes (kept in this browser),
// - ticks while shopping, kept in this browser only (anyone can use them),
// - the recipes each item is for: its row shows their photos, and tapping them names the recipes,
// - for the signed-in editor: the "At home" tab, where each row is a fill bar (slide across
//   it for some, tap the house for all). Edits stay in this browser until Save, which sends
//   them in one go to the MCP server's /stocktake endpoint (one commit, one deploy).
// Sign-in is the shared templates/auth.js (window.RecipeAuth: email + password, or an emailed code / magic link; the sheet, the
// account button and the session live there, so the chat can use them too). The UI patterns are described in design.md.
(function () {
  "use strict";
  var dataEl = document.getElementById("shopping-data");
  var app = document.getElementById("shopping-app");
  var accountEl = document.getElementById("shopping-account");
  if (!dataEl || !app) return;
  var data = JSON.parse(dataEl.textContent);
  var RA = window.RecipeAuth; // absent when the build has no Supabase sign-in: the page is then read-only
  var auth = RA ? data.auth : null; // { api, ... } turns on the editor's stocktake

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
  var PLAN_KEY = "shopping-plan:" + data.version;
  var TICKS_KEY = "shopping-ticks:" + data.version;
  var PENDING_KEY = "shopping-stocktake:" + data.version;
  var DRAFT_KEY = "shopping-draft:" + data.version;
  try {
    // Ticks, unsaved edits and saved-but-not-yet-deployed stocktakes belong to one list: drop other lists' ones.
    Object.keys(localStorage).forEach(function (k) {
      if (/^shopping-(ticks|stocktake|draft|plan):/.test(k) && [TICKS_KEY, PENDING_KEY, DRAFT_KEY, PLAN_KEY].indexOf(k) === -1) {
        localStorage.removeItem(k);
      }
    });
    localStorage.removeItem("shopping-servings"); // the old one-number-for-all pick
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

  // Servings per recipe: the agent's plan, or this browser's changes to it. Changes are dropped
  // when the agent changes the plan, so a new plan always shows.
  var plan = data.plan || {};
  var slugs = Object.keys(plan);
  var MAX_SERVINGS = 12;
  function samePlan(a, b) {
    return slugs.every(function (slug) {
      return a && b && a[slug] === b[slug];
    });
  }
  var storedPlan = load(PLAN_KEY, null);
  var startServings = Object.assign({}, plan);
  if (storedPlan && samePlan(storedPlan.plan, plan) && storedPlan.servings) {
    slugs.forEach(function (slug) {
      var n = storedPlan.servings[slug];
      if (n >= 1 && n <= MAX_SERVINGS && n === Math.round(n)) startServings[slug] = n;
    });
  } else save(PLAN_KEY, undefined);
  var state = {
    servings: startServings, // slug -> servings
    perRecipeOpen: false,
    ticks: load(TICKS_KEY, []),
    have: have,
    stocktakeAt: stocktakeAt,
    savedNow: false,
    draft: load(DRAFT_KEY, null), // unsaved "at home" edits: { id: true | number }
    tab: "list", // list | home (editor only)
    homeOpen: false, // the "Already at home" fold
    openFor: [], // ids of the rows whose recipe names are shown
    collapsed: load("shopping-collapsed", []), // names of the aisle sections folded away (both tabs)
    message: null, // { text, error }
    busy: false,
  };

  function isEditor() {
    return !!(auth && RA.getSession());
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
  function servingsOf(slug) {
    return state.servings[slug] || data.fallback;
  }
  // Each recipe's share of the 2-serving amount times its servings / base; items without `amounts`
  // (older lists) scale by their recipes' average. Keep in sync with neededAmount in shopping-list.js.
  function need(item) {
    if (item.amount === undefined) return null;
    if (item.amounts) {
      return Object.keys(item.amounts).reduce(function (n, slug) {
        return n + (item.amounts[slug] * servingsOf(slug)) / data.base;
      }, 0);
    }
    var rs = item.recipes && item.recipes.length ? item.recipes : slugs;
    var mean = rs.length
      ? rs.reduce(function (n, slug) {
          return n + servingsOf(slug);
        }, 0) / rs.length
      : data.fallback;
    return (item.amount * mean) / data.base;
  }
  function needText(item) {
    if (item.amount === undefined) return item.quantity || "";
    var n = need(item);
    return Math.abs(n - item.amount) < 1e-9 ? item.quantity : withUnit(formatNumber(n, item.unit), item.unit);
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
    minus: svg('<path d="M6 12h12"/>'),
    plus: svg('<path d="M12 6v12M6 12h12"/>'),
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

  /** The one number every recipe is on, or null when they differ. */
  function uniform(map) {
    var first = map[slugs[0]];
    return slugs.every(function (slug) {
      return map[slug] === first;
    })
      ? first
      : null;
  }
  // "Plan" is the agent's plan; it is left out when the plan is one of 1/2/4 for every recipe (that button is the plan then).
  function showPlanButton() {
    var u = uniform(plan);
    return slugs.length > 0 && [1, 2, 4].indexOf(u) === -1;
  }
  function planRecipeHtml(slug) {
    var r = (data.recipes && data.recipes[slug]) || { title: slug };
    var n = servingsOf(slug);
    var changed = n !== plan[slug];
    var label = esc(r.title);
    return (
      '<li class="serves-row' + (changed ? " is-changed" : "") + '">' +
      (r.image ? '<img src="' + esc(r.image) + '" alt="">' : "") +
      '<span class="serves-name"><span>' + label + "</span>" + (changed ? '<small>custom</small>' : "") + "</span>" +
      '<span class="stepper">' +
      '<button type="button" class="step" data-step="' + esc(slug) + '" data-delta="-1" data-focus="step-down-' + esc(slug) + '"' +
      (n <= 1 ? " disabled" : "") + ' aria-label="Fewer servings of ' + label + '">' + ICON.minus + "</button>" +
      '<span class="step-count" aria-live="polite" aria-label="' + label + ", " + n + " servings" + '">' + n + "</span>" +
      '<button type="button" class="step" data-step="' + esc(slug) + '" data-delta="1" data-focus="step-up-' + esc(slug) + '"' +
      (n >= MAX_SERVINGS ? " disabled" : "") + ' aria-label="More servings of ' + label + '">' + ICON.plus + "</button>" +
      "</span></li>"
    );
  }
  function servingsHtml() {
    var onPlan = samePlan(state.servings, plan);
    var u = uniform(state.servings);
    var planButton = showPlanButton();
    var html =
      '<div class="shop-card servings-card"><div class="servings-top"><span>Servings</span>' +
      '<div class="seg" role="group" aria-label="Servings of every recipe">';
    if (planButton) {
      html += '<button type="button" data-serves="plan" data-focus="serves-plan" aria-pressed="' + onPlan + '" aria-label="As planned">Plan</button>';
    }
    [1, 2, 4].forEach(function (n) {
      var pressed = u === n && !(planButton && onPlan);
      html += '<button type="button" data-serves="' + n + '" data-focus="serves-' + n + '" aria-pressed="' + pressed + '" aria-label="' + n + ' for every recipe">' + n + "</button>";
    });
    html += "</div></div>";
    if (!slugs.length) return html + "</div>";
    var summary = onPlan ? (planButton ? "as planned" : "") : u === null ? "your mix" : "";
    html +=
      '<button type="button" class="per-recipe-toggle" data-act="per-recipe" data-focus="per-recipe" aria-expanded="' + state.perRecipeOpen + '">' +
      "<span>Per recipe" + (summary ? '<span class="per-recipe-summary"> &middot; ' + summary + "</span>" : "") + "</span>" + ICON.chevron + "</button>";
    if (state.perRecipeOpen) html += '<ul class="serves-list">' + slugs.map(planRecipeHtml).join("") + "</ul>";
    return html + "</div>";
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

  // A row shows at most this many recipe photos, then "+n" (as in shopping-list.js).
  var ROW_PHOTOS = 3;
  function rowRecipes(item) {
    return (item.recipes || [])
      .map(function (slug) {
        return data.recipes && data.recipes[slug];
      })
      .filter(Boolean);
  }
  /** The photos of the recipes an item is for; tapping them shows the recipes' names (links) under the row. */
  function rowForHtml(item, rs) {
    if (!rs.length) return "";
    var open = state.openFor.indexOf(item.id) !== -1;
    var imgs = rs.slice(0, ROW_PHOTOS).map(function (r) {
      return '<img src="' + esc(r.image) + '" alt="">';
    }).join("");
    var more = rs.length > ROW_PHOTOS ? '<span class="row-more">+' + (rs.length - ROW_PHOTOS) + "</span>" : "";
    var names = rs.map(function (r) {
      return r.title;
    }).join(", ");
    return (
      '<button type="button" class="row-for" data-for="' + item.id + '" data-focus="for-' + item.id + '" aria-expanded="' + open +
      '" aria-label="For ' + esc(names) + '">' + imgs + more + "</button>"
    );
  }
  function rowRecipesHtml(item, rs) {
    if (!rs.length || state.openFor.indexOf(item.id) === -1) return "";
    return (
      '<div class="row-recipes">' +
      rs.map(function (r) {
        return '<a href="' + esc(r.href) + '"><img src="' + esc(r.image) + '" alt=""><span>' + esc(r.title) + "</span></a>";
      }).join("") +
      "</div>"
    );
  }

  // The tick and the quantity are both labels for the checkbox, so the whole row still ticks; the photos between them are a button.
  function shopRow(item, r) {
    var ticked = state.ticks.indexOf(item.id) !== -1;
    var rs = rowRecipes(item);
    var partial = r.status === "partial";
    var qty = partial ? amountText(item, r.left) : needText(item);
    var some = partial
      ? ICON.houseSome("icon icon-some") +
        '<span class="sr-only">(have ' + esc(amountText(item, effective()[item.id])) + " of " + esc(needText(item)) + " at home)</span>"
      : "";
    return (
      '<li class="shop-row"><label class="shop-item"><input type="checkbox" class="tick" id="tick-' + item.id + '" data-tick="' + item.id +
      '" data-focus="tick-' + item.id + '"' + (ticked ? " checked" : "") + '><span class="shop-name">' + esc(item.name) + noteHtml(item) +
      "</span>" + some + "</label>" + rowForHtml(item, rs) + '<label class="shop-qty" for="tick-' + item.id + '">' + esc(qty) + "</label>" +
      rowRecipesHtml(item, rs) + "</li>"
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

  function render() {
    var focused = document.activeElement && document.activeElement.getAttribute("data-focus");
    if (state.tab === "home" && !isEditor()) state.tab = "list";
    app.innerHTML = (isEditor() ? tabsHtml() : "") + (state.tab === "home" ? homeViewHtml() : listViewHtml());
    if (focused) {
      var el = document.querySelector('[data-focus="' + focused + '"]');
      if (el) el.focus();
    }
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

  // Kept per list, with the plan it was made from; back on the plan, nothing is kept.
  function saveServings() {
    save(PLAN_KEY, samePlan(state.servings, plan) ? undefined : { plan: plan, servings: state.servings });
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

  // --- sign-in: the shared templates/auth.js does the work; this page reacts to it ---
  function accessToken() {
    return RA.getAccessToken();
  }
  function signedOut(text) {
    RA.sessionExpired(text);
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
    var el = e.target.closest("button");
    if (!el || el.disabled) return;
    var act = el.getAttribute("data-act");
    if (el.hasAttribute("data-serves")) {
      var serves = el.getAttribute("data-serves");
      state.servings = {};
      slugs.forEach(function (slug) {
        state.servings[slug] = serves === "plan" ? plan[slug] : Number(serves);
      });
      saveServings();
    } else if (el.hasAttribute("data-step")) {
      var stepSlug = el.getAttribute("data-step");
      var next = servingsOf(stepSlug) + Number(el.getAttribute("data-delta"));
      if (next < 1 || next > MAX_SERVINGS) return;
      state.servings[stepSlug] = next;
      saveServings();
    } else if (act === "per-recipe") {
      state.perRecipeOpen = !state.perRecipeOpen;
    } else if (el.hasAttribute("data-tab")) {
      state.tab = el.getAttribute("data-tab");
      state.message = null;
    } else if (el.hasAttribute("data-for")) {
      var forId = el.getAttribute("data-for");
      var at = state.openFor.indexOf(forId);
      if (at === -1) state.openFor.push(forId);
      else state.openFor.splice(at, 1);
    } else if (el.hasAttribute("data-house")) {
      var id = el.getAttribute("data-house");
      setDraft(id, rowState(byId[id]).level === "all" ? 0 : true);
    } else if (act === "update") {
      if (isEditor()) state.tab = "home";
      else return RA.openSignIn();
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

  if (auth) {
    RA.setCopy({ title: "Update what's at home", lede: "Sign in once and you can mark what you already have." });
    if (accountEl) RA.renderAccount(accountEl);
    RA.onChange(function (session, info) {
      if (info.type === "sign-in") {
        state.tab = "home";
        state.message = null;
      } else if (info.type === "sign-out") state.tab = "list";
      else if (info.type === "password-saved") state.message = { text: info.message };
      else if (info.type === "error") state.message = { text: info.message, error: true };
      else return;
      render();
    });
  }
  render();
})();
