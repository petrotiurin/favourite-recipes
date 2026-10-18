// Shopping page enhancement. Re-renders #shopping-app from the JSON the build embedded
// (#shopping-data); it never loads the list at runtime. Adds:
// - the servings picker (1/2/4 per recipe, from the list's 2-serving base),
// - the "Take off what's at home" switch: on (default) shows only what's left to buy,
//   off shows the full list,
// - ticks while shopping, kept in this browser only (anyone can use them),
// - for the signed-in editor: the stocktake (what's already at home, fully or partly),
//   saved through the MCP server's /stocktake endpoint, which commits shopping-list.json.
// Sign-in is Supabase Auth's magic link, called over its REST API (no client library).
(function () {
  "use strict";
  var dataEl = document.getElementById("shopping-data");
  var app = document.getElementById("shopping-app");
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
  var SESSION_KEY = "shopping-editor-session";
  try {
    // Ticks and saved-but-not-yet-deployed stocktakes belong to one list: drop other lists' ones.
    Object.keys(localStorage).forEach(function (k) {
      if (/^shopping-(ticks|stocktake):/.test(k) && k !== TICKS_KEY && k !== PENDING_KEY) localStorage.removeItem(k);
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
  var pending = load(PENDING_KEY, null);
  if (pending && pending.saved && (!data.stocktake || pending.saved > data.stocktake)) have = pending.have;
  else save(PENDING_KEY, undefined);

  var state = {
    servings: [1, 2, 4].indexOf(load("shopping-servings", data.base)) === -1 ? data.base : load("shopping-servings", data.base),
    hideHome: load("shopping-hide-home", true) !== false,
    ticks: load(TICKS_KEY, []),
    have: have,
    draft: null, // the stocktake being edited: { id: true | number }
    session: load(SESSION_KEY, null),
    signIn: "closed", // closed | open | sent
    email: "",
    message: null, // { text, error }
    busy: false,
  };

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
  // A count goes up by 1; grams and millilitres by a round step that suits the amount.
  function stepFor(item) {
    if (!METRIC.test(item.unit)) return 1;
    var a = item.amount;
    return a >= 1000 ? 100 : a >= 400 ? 50 : a >= 100 ? 25 : a >= 30 ? 10 : 5;
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

  // --- rendering ---
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function noteHtml(item) {
    return item.note ? '<span class="shopping-note">, ' + esc(item.note) + "</span>" : "";
  }
  function qtyHtml(text) {
    return text ? "<strong>" + esc(text) + "</strong> " : "";
  }

  function shopRow(item, r) {
    var ticked = state.ticks.indexOf(item.id) !== -1;
    var qty = state.hideHome && r.status === "partial" ? amountText(item, r.left) : needText(item);
    var chip = "";
    if (r.status === "partial") {
      chip = state.hideHome
        ? '<span class="shopping-have">have ' + esc(amountText(item, state.have[item.id])) + " of " + esc(needText(item)) + "</span>"
        : '<span class="shopping-have">have ' + esc(amountText(item, state.have[item.id])) + "</span>";
    } else if (r.status === "home") {
      chip = '<span class="shopping-have is-home">at home</span>';
    }
    return (
      '<li><label class="shopping-item"><input type="checkbox" data-tick="' + item.id + '"' + (ticked ? " checked" : "") + "><span>" +
      qtyHtml(qty) + esc(item.name) + noteHtml(item) + (chip ? " " + chip : "") + "</span></label></li>"
    );
  }

  function stockRow(item) {
    var v = state.draft[item.id];
    var partial = typeof v === "number";
    var r = remaining(item, state.draft);
    var cls = r.status === "home" ? " is-home" : partial ? " is-partial" : "";
    var html =
      '<li class="stock-row' + cls + '"><div class="stock-main">' +
      '<label class="shopping-item"><input type="checkbox" data-have-all="' + item.id + '"' + (v === true ? " checked" : "") + (partial ? " data-partial" : "") + ">" +
      "<span>" + qtyHtml(needText(item)) + esc(item.name) + noteHtml(item) + "</span></label>";
    if (item.amount !== undefined) {
      html += '<button type="button" class="stock-some" data-some="' + item.id + '" aria-pressed="' + partial + '">Some</button>';
    }
    html += "</div>";
    if (partial) {
      var step = stepFor(item);
      html +=
        '<div class="stock-partial">' +
        '<span class="stock-partial-label">Have</span>' +
        '<button type="button" data-step="' + item.id + '" data-by="' + -step + '" aria-label="' + step + ' less">−</button>' +
        '<input type="number" inputmode="decimal" min="0" step="any" value="' + v + '" data-amount="' + item.id + '" data-focus="amount-' + item.id + '" aria-label="Amount of ' + esc(item.name) + ' at home">' +
        (item.unit ? '<span class="stock-unit">' + esc(item.unit) + "</span>" : "") +
        '<button type="button" data-step="' + item.id + '" data-by="' + step + '" aria-label="' + step + ' more">+</button>' +
        '<span class="stock-left" data-left="' + item.id + '">' + leftText(item) + "</span>" +
        "</div>";
    }
    return html + "</li>";
  }

  function leftText(item) {
    var r = remaining(item, state.draft);
    return r.status === "home" ? "enough, nothing to buy" : "buy " + esc(amountText(item, r.left));
  }

  function sectionHtml(name, rows, extraClass) {
    return (
      '<section class="shopping-section' + (extraClass || "") + '"><h2>' + esc(name) + "</h2>" +
      '<ul class="shopping-items">' + rows.join("") + "</ul></section>"
    );
  }

  function toolbarHtml() {
    var html = '<div class="shopping-toolbar">';
    if (!state.draft) {
      html +=
        '<button type="button" class="switch" role="switch" data-act="toggle-home" aria-checked="' + state.hideHome + '">' +
        '<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>' +
        "<span>Take off what's at home</span></button>";
    }
    html += '<div class="servings-picker" role="group" aria-label="Servings per recipe"><span class="servings-label">Servings per recipe</span>';
    [1, 2, 4].forEach(function (n) {
      html += '<button type="button" data-serves="' + n + '" aria-pressed="' + (n === state.servings) + '">' + n + "</button>";
    });
    html += "</div>";
    if (!state.draft && state.session) {
      html += '<button type="button" class="stock-start" data-act="edit">🏠 What\'s at home?</button>';
    }
    return html + "</div>";
  }

  function stocktakeBarHtml() {
    return (
      '<div class="stock-bar">' +
      '<p class="stock-help"><strong>What\'s at home?</strong> Tick what you have enough of. For part of an amount, tap <em>Some</em>.</p>' +
      '<div class="stock-actions">' +
      '<button type="button" data-act="all-home">All at home</button>' +
      '<button type="button" data-act="none-home">Clear all</button>' +
      '<span class="stock-spacer"></span>' +
      '<button type="button" data-act="cancel"' + (state.busy ? " disabled" : "") + ">Cancel</button>" +
      '<button type="button" class="primary" data-act="save"' + (state.busy ? " disabled" : "") + ">" + (state.busy ? "Saving…" : "Save") + "</button>" +
      "</div></div>"
    );
  }

  function messageHtml() {
    if (!state.message) return "";
    return '<p class="shopping-status' + (state.message.error ? " is-error" : "") + '" role="status">' + esc(state.message.text) + "</p>";
  }

  function listHtml() {
    var html = "";
    if (state.draft) {
      data.sections.forEach(function (section) {
        html += sectionHtml(section.name, section.items.map(stockRow));
      });
      return html;
    }
    var home = [];
    var shown = 0;
    data.sections.forEach(function (section) {
      var rows = [];
      section.items.forEach(function (item) {
        var r = remaining(item, state.have);
        if (state.hideHome && r.status === "home") home.push(item);
        else {
          rows.push(shopRow(item, r));
          shown++;
        }
      });
      if (rows.length) html += sectionHtml(section.name, rows);
    });
    if (!shown) html += '<p class="shopping-empty">Everything on the list is already at home.</p>';
    var ticked = items.filter(function (item) {
      return state.ticks.indexOf(item.id) !== -1 && !(state.hideHome && remaining(item, state.have).status === "home");
    }).length;
    if (ticked) {
      html =
        '<div class="shopping-progress"><span>' + ticked + " of " + shown + ' ticked</span><button type="button" class="link-button" data-act="clear-ticks">Untick all</button></div>' +
        html;
    }
    if (home.length) {
      html +=
        '<details class="shopping-section shopping-home"><summary>Already at home (' + home.length + ")</summary>" +
        '<ul class="shopping-items">' +
        home.map(function (item) {
          return "<li>" + qtyHtml(needText(item)) + esc(item.name) + noteHtml(item) + "</li>";
        }).join("") +
        "</ul></details>";
    }
    return html;
  }

  function editorHtml() {
    if (!auth || state.draft) return "";
    if (state.session) {
      return (
        '<div class="shopping-editor">Signed in as ' + esc(state.session.email || "editor") +
        ' · <button type="button" class="link-button" data-act="signout">Sign out</button></div>'
      );
    }
    if (state.signIn === "sent") {
      return (
        '<div class="shopping-editor">Sign-in link sent to ' + esc(state.email) +
        ". Open it on this device. <button type=\"button\" class=\"link-button\" data-act=\"signin-open\">Use another email</button></div>"
      );
    }
    if (state.signIn === "open") {
      return (
        '<form class="shopping-editor signin-form" data-form="signin">' +
        '<label for="signin-email">Editor email</label>' +
        '<input id="signin-email" type="email" autocomplete="email" required value="' + esc(state.email) + '" data-focus="signin-email">' +
        '<button type="submit"' + (state.busy ? " disabled" : "") + ">" + (state.busy ? "Sending…" : "Email me a sign-in link") + "</button>" +
        "</form>"
      );
    }
    return '<div class="shopping-editor"><button type="button" class="link-button" data-act="signin-open">Editor sign-in</button></div>';
  }

  function render() {
    var focused = document.activeElement && document.activeElement.getAttribute("data-focus");
    app.innerHTML = toolbarHtml() + (state.draft ? stocktakeBarHtml() : "") + messageHtml() + listHtml() + editorHtml();
    app.querySelectorAll("[data-partial]").forEach(function (el) {
      el.indeterminate = true;
    });
    if (focused) {
      var el = app.querySelector('[data-focus="' + focused + '"]');
      if (el) el.focus();
    }
  }

  // --- Supabase Auth (magic link, REST) ---
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
  // Coming back from the magic link: Supabase puts the tokens (or an error) in the URL fragment.
  function readRedirect() {
    if (!auth || location.hash.length < 2) return;
    var params = new URLSearchParams(location.hash.slice(1));
    if (params.get("access_token")) {
      setSession(sessionFrom(Object.fromEntries(params)));
      state.message = { text: "Signed in. Tap “What's at home?” to mark what you already have." };
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
  function signedOut(text) {
    setSession(null);
    state.signIn = "open";
    state.message = { text: text, error: true };
  }

  function sendSignInLink() {
    var redirect = location.origin + location.pathname;
    state.busy = true;
    state.message = null;
    render();
    authFetch("otp?redirect_to=" + encodeURIComponent(redirect), { email: state.email, create_user: false })
      .then(function (res) {
        if (res.ok) {
          state.signIn = "sent";
          return;
        }
        return res.json().then(
          function (j) {
            var reason = j.msg || j.error_description || j.message || "";
            state.message = /signup|not.*found|not allowed/i.test(reason)
              ? { text: "That email can't sign in here.", error: true }
              : { text: "Couldn't send the link" + (reason ? ": " + reason : "") + ".", error: true };
          },
          function () {
            state.message = { text: "Couldn't send the link. Try again.", error: true };
          }
        );
      })
      .catch(function () {
        state.message = { text: "Couldn't reach the sign-in service. Check your connection.", error: true };
      })
      .then(function () {
        state.busy = false;
        render();
      });
  }

  // --- stocktake ---
  function startStocktake() {
    state.draft = Object.assign({}, state.have);
    state.message = null;
    render();
    app.scrollIntoView({ block: "start" });
  }
  function setAmount(id, value) {
    var item = byId[id];
    var v = Math.max(0, Math.round(value * 100) / 100);
    state.draft[id] = v;
    // Typing doesn't re-render (it would steal the cursor); update the row in place.
    var left = app.querySelector('[data-left="' + id + '"]');
    if (left) left.innerHTML = leftText(item);
    var row = left && left.closest(".stock-row");
    if (row) {
      var home = remaining(item, state.draft).status === "home";
      row.classList.toggle("is-home", home);
      row.classList.toggle("is-partial", !home);
    }
  }
  function saveStocktake() {
    var payload = items.map(function (item) {
      var v = state.draft[item.id];
      var entry = { name: item.name };
      if (item.quantity) entry.quantity = item.quantity;
      if (v === true || (typeof v === "number" && v > 0)) entry.have = v;
      return entry;
    });
    state.busy = true;
    state.message = null;
    render();
    accessToken()
      .then(function (token) {
        if (!token) {
          signedOut("Your sign-in has expired. Sign in again; your ticks are kept until you leave the page.");
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
            save(PENDING_KEY, { saved: out.body.stocktake, have: saved });
            state.message = { text: "Saved. The shopping agent sees it now; the page updates for everyone in about a minute." };
          } else if (out.res.status === 401) {
            signedOut(out.body.error || "Sign in again to save.");
          } else {
            state.message = { text: out.body.error || "Saving failed. Try again.", error: true };
          }
        });
      })
      .catch(function () {
        state.message = { text: "Couldn't reach the server. Check your connection and try again.", error: true };
      })
      .then(function () {
        state.busy = false;
        render();
      });
  }

  // --- events ---
  app.addEventListener("click", function (e) {
    var el = e.target.closest("button");
    if (!el || !app.contains(el)) return;
    var act = el.getAttribute("data-act");
    if (el.hasAttribute("data-serves")) {
      state.servings = Number(el.getAttribute("data-serves"));
      save("shopping-servings", state.servings);
    } else if (el.hasAttribute("data-some")) {
      var item = byId[el.getAttribute("data-some")];
      if (typeof state.draft[item.id] === "number") delete state.draft[item.id];
      else {
        // Start at about half of what's needed, on the item's step.
        var step = stepFor(item);
        state.draft[item.id] = Math.max(step, Math.floor(item.amount / 2 / step) * step);
      }
    } else if (el.hasAttribute("data-step")) {
      var id = el.getAttribute("data-step");
      state.draft[id] = Math.max(0, Math.round(((state.draft[id] || 0) + Number(el.getAttribute("data-by"))) * 100) / 100);
    } else if (act === "toggle-home") {
      state.hideHome = !state.hideHome;
      save("shopping-hide-home", state.hideHome);
    } else if (act === "clear-ticks") {
      state.ticks = [];
      save(TICKS_KEY, undefined);
    } else if (act === "edit") {
      return startStocktake();
    } else if (act === "all-home") {
      items.forEach(function (item) {
        state.draft[item.id] = true;
      });
    } else if (act === "none-home") {
      state.draft = {};
    } else if (act === "cancel") {
      state.draft = null;
    } else if (act === "save") {
      return saveStocktake();
    } else if (act === "signin-open") {
      state.signIn = "open";
      state.message = null;
      render();
      var input = document.getElementById("signin-email");
      if (input) input.focus();
      return;
    } else if (act === "signout") {
      var token = state.session && state.session.access_token;
      if (token) authFetch("logout", {}, token).catch(function () {});
      setSession(null);
      state.signIn = "closed";
      state.message = { text: "Signed out." };
    } else {
      return;
    }
    render();
  });

  app.addEventListener("change", function (e) {
    var el = e.target;
    if (el.hasAttribute("data-tick")) {
      var id = el.getAttribute("data-tick");
      state.ticks = state.ticks.filter(function (t) {
        return t !== id;
      });
      if (el.checked) state.ticks.push(id);
      save(TICKS_KEY, state.ticks);
      render();
    } else if (el.hasAttribute("data-have-all")) {
      var hid = el.getAttribute("data-have-all");
      if (state.draft[hid] === true) delete state.draft[hid];
      else state.draft[hid] = true;
      render();
    }
    // Typed amounts are applied in place on "input" (setAmount). Re-rendering on "change" would
    // replace the button being tapped when the field loses focus, swallowing e.g. the Save tap.
  });

  app.addEventListener("input", function (e) {
    var el = e.target;
    if (el.hasAttribute("data-amount")) {
      var v = parseFloat(el.value);
      setAmount(el.getAttribute("data-amount"), Number.isFinite(v) ? v : 0);
    } else if (el.id === "signin-email") {
      state.email = el.value.trim();
    }
  });

  app.addEventListener("submit", function (e) {
    if (e.target.getAttribute("data-form") !== "signin") return;
    e.preventDefault();
    state.email = document.getElementById("signin-email").value.trim();
    if (state.email) sendSignInLink();
  });

  readRedirect();
  render();
})();
