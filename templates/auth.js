// Sign-in shared by every page (docs/chatbot-design.md 4.2): the Supabase Auth session and the sign-in sheet, moved out of
// shopping.js so the shopping page's stocktake and the chat panel use the same one. Vanilla JS, no dependencies, plain fetch to
// Supabase's REST API (no client library). Only added to a page when the build was given SUPABASE_URL and SUPABASE_ANON_KEY
// (both public values, in this script tag's data-supabase-url / data-supabase-key); without it nothing here exists and pages
// stay read-only.
//
// Sign-in: email + password, or "No password? Email me a code" (6-digit code, and the same email carries a magic link that comes
// back to the page it was sent from); after a code or link sign-in the sheet offers "Set a password". The session lives in
// localStorage under one key, so signing in on one page (or tab) signs you in on all of them; the access token is refreshed
// shortly before it expires.
//
// window.RecipeAuth:
//   getSession()            { email, access_token, refresh_token, expires_at } or null
//   getAccessToken()        Promise of a token that is good for at least a minute (refreshed when needed), or null
//   refresh()               Promise: force a refresh now (a server said 401); a fresh token, or null if the session can't be renewed
//   onChange(fn)            fn(session, { type }) on "sign-in", "sign-out", "refresh", "password-saved", "error" (a failed magic link:
//                           info.message). Returns an unsubscribe function. A magic-link return that happened while the page was loading
//                           is delivered to the first listeners, a tick after they subscribe.
//   openSignIn({ title, lede })  opens the sheet (the copy is optional; setCopy gives a page its own defaults)
//   openSetPassword()       opens "Set a password" for the signed-in user
//   signOut()               signs out (tells Supabase, clears the session)
//   sessionExpired(text)    clears the session and opens the sheet with `text` as an error ("Your sign-in has expired...")
//   renderAccount(el, { compact })  keeps el showing a "Sign in" pill, or the avatar with its menu (email, Set a password, Sign out)
//   setCopy({ title, lede })     default sheet title and line for this page
(function () {
  "use strict";

  var SESSION_KEY = "shopping-editor-session"; // the shopping page's key, kept so existing sign-ins carry over
  var EMAIL_KEY = "shopping-editor-email";
  var HAS_PASSWORD_KEY = "shopping-editor-has-password"; // set once this browser has seen a password work

  // ---------------------------------------------------------------------------------------------------------------
  // Pure helpers (unit-tested in node)
  // ---------------------------------------------------------------------------------------------------------------
  function emailFromJwt(token) {
    try {
      var payload = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var json = typeof atob === "function" ? atob(payload) : Buffer.from(payload, "base64").toString("binary");
      return JSON.parse(decodeURIComponent(escape(json))).email || "";
    } catch (e) {
      return "";
    }
  }
  function sessionFrom(tokens, now) {
    var nowSec = Math.floor((now || Date.now()) / 1000);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Number(tokens.expires_at) || nowSec + (Number(tokens.expires_in) || 3600),
      email: (tokens.user && tokens.user.email) || emailFromJwt(tokens.access_token),
    };
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var pure = { emailFromJwt: emailFromJwt, sessionFrom: sessionFrom };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = pure;
    return;
  }

  var script = document.currentScript;
  var supabaseUrl = script && (script.getAttribute("data-supabase-url") || "").replace(/\/$/, "");
  var supabaseKey = script && script.getAttribute("data-supabase-key");
  if (!supabaseUrl || !supabaseKey) return;

  // ---------------------------------------------------------------------------------------------------------------
  // Storage (can throw in private mode / blocked storage: everything still works without it, for this page view)
  // ---------------------------------------------------------------------------------------------------------------
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

  var ICON = {
    person: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  var state = {
    session: load(SESSION_KEY, null),
    sheet: null, // null | email | code | password
    email: load(EMAIL_KEY, ""),
    password: "",
    code: "",
    message: null, // { text, error } shown in the sheet
    busy: false,
    accountOpen: false,
    copy: { title: "Sign in", lede: "Family editors can sign in here." },
    override: null, // the copy given to one openSignIn call (the chat's own wording), dropped when the sheet closes
  };
  var listeners = [];
  var accounts = []; // { el, compact }
  var initial = null; // what happened while the page loaded (a magic link coming back), handed to the first listeners

  function emit(type, extra) {
    var info = Object.assign({ type: type }, extra || {});
    listeners.slice().forEach(function (fn) {
      try {
        fn(state.session, info);
      } catch (e) {
        if (window.console) console.error(e);
      }
    });
    return info;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Supabase Auth REST
  // ---------------------------------------------------------------------------------------------------------------
  function authFetch(path, body, token, method) {
    var headers = { apikey: supabaseKey, "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(supabaseUrl + "/auth/v1/" + path, { method: method || "POST", headers: headers, body: JSON.stringify(body || {}) });
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
  function setSession(session) {
    state.session = session;
    save(SESSION_KEY, session || undefined);
  }

  var refreshing = null;
  function refreshNow() {
    var s = state.session;
    if (!s) return Promise.resolve(null);
    if (refreshing) return refreshing;
    refreshing = authFetch("token?grant_type=refresh_token", { refresh_token: s.refresh_token })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (tokens) {
        if (!tokens || !tokens.access_token) return null;
        setSession(sessionFrom(tokens));
        render();
        emit("refresh");
        return tokens.access_token;
      })
      .then(
        function (token) {
          refreshing = null;
          return token;
        },
        function (err) {
          refreshing = null;
          throw err;
        }
      );
    return refreshing;
  }
  function getAccessToken() {
    var s = state.session;
    if (!s) return Promise.resolve(null);
    if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return refreshNow();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The sheet
  // ---------------------------------------------------------------------------------------------------------------
  var root = document.createElement("div");
  root.id = "auth-sheet-root";
  document.body.appendChild(root);

  function sheetHtml() {
    var sheet = state.sheet;
    if (!sheet) return "";
    var copy = state.override || state.copy;
    var lede = {
      email: copy.lede,
      code: "We sent a code to " + esc(state.email) + ". It works on any device.",
      password: "Next time, sign in with your email and this password: no email to wait for.",
    }[sheet];
    var html =
      '<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<div class="sheet-head"><div><h2 id="sheet-title">' + esc(sheet === "password" ? "Set a password" : copy.title) + "</h2><p>" +
      lede + '</p></div><button type="button" class="icon-button" data-auth="sheet-close" aria-label="Close">' + ICON.close + "</button></div>";
    if (state.message) {
      html += '<p class="shopping-status' + (state.message.error ? " is-error" : "") + '" role="status">' + esc(state.message.text) + "</p>";
    }
    var submit = function (idle, working) {
      return '<button type="submit" class="save-button"' + (state.busy ? " disabled" : "") + ">" + (state.busy ? working : idle) + "</button></form>";
    };
    if (sheet === "email") {
      html +=
        '<form data-auth-form="email"><label for="signin-email">Email</label>' +
        '<input id="signin-email" type="email" autocomplete="username" required value="' + esc(state.email) + '" data-focus="signin-email">' +
        '<label for="signin-password">Password</label>' +
        '<input id="signin-password" type="password" autocomplete="current-password" required value="' + esc(state.password) +
        '" data-focus="signin-password">' +
        submit("Sign in", "Signing in…") +
        '<div class="sheet-links"><button type="button" class="text-button" data-auth="send-code"' + (state.busy ? " disabled" : "") +
        ">No password? Email me a code</button></div>" +
        '<p class="sheet-note">Only family editors can sign in. You\'ll stay signed in on this device.</p>';
    } else if (sheet === "code") {
      html +=
        '<form data-auth-form="code"><label for="signin-code">Code from the email</label>' +
        '<input id="signin-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required value="' +
        esc(state.code) + '" data-focus="signin-code">' +
        submit("Sign in", "Signing in…") +
        '<div class="sheet-links"><button type="button" class="text-button is-quiet" data-auth="sheet-email">Change email</button>' +
        '<button type="button" class="text-button" data-auth="resend"' + (state.busy ? " disabled" : "") + ">Send a new code</button></div>" +
        '<p class="sheet-note">The email also has a sign-in link, if you\'d rather tap that on this device.</p>';
    } else {
      // The hidden username lets password managers file the new password under the right email.
      html +=
        '<form data-auth-form="password"><input type="email" autocomplete="username" value="' + esc((state.session && state.session.email) || state.email) +
        '" hidden><label for="new-password">New password</label>' +
        '<input id="new-password" type="password" autocomplete="new-password" minlength="6" required value="' + esc(state.password) +
        '" data-focus="new-password">' +
        submit("Save password", "Saving…") +
        '<div class="sheet-links"><button type="button" class="text-button is-quiet" data-auth="sheet-close">Not now</button></div>' +
        '<p class="sheet-note">Let your browser save it. The email code still works if you forget it.</p>';
    }
    return html + "</div></div>";
  }

  function accountHtml(compact) {
    if (!state.session) {
      return (
        '<button type="button" class="pill' + (compact ? " is-compact" : "") + '" data-auth="signin" data-focus="signin"' + (compact ? ' aria-label="Sign in"' : "") + ">" +
        ICON.person + (compact ? "" : "Sign in") + "</button>"
      );
    }
    var email = state.session.email || "";
    var html =
      '<button type="button" class="avatar" data-auth="account" data-focus="account" aria-expanded="' + state.accountOpen +
      '" aria-label="Signed in as ' + esc(email || "editor") + '">' + esc((email || "E").charAt(0).toUpperCase()) + "</button>";
    if (state.accountOpen) {
      html +=
        '<div class="account-menu"><p>Signed in as ' + esc(email || "editor") + "</p>" +
        '<button type="button" class="text-button" data-auth="set-password">Set a password</button>' +
        '<button type="button" class="text-button" data-auth="signout">Sign out</button></div>';
    }
    return html;
  }

  function render() {
    var focused = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-focus");
    var focusedInRoot = focused && root.contains(document.activeElement);
    root.innerHTML = sheetHtml();
    document.body.classList.toggle("sheet-open", !!state.sheet);
    accounts = accounts.filter(function (a) {
      return a.el.isConnected;
    });
    accounts.forEach(function (a) {
      a.el.innerHTML = accountHtml(a.compact);
    });
    if (focused) {
      var again = (focusedInRoot ? root : document).querySelector('[data-focus="' + focused + '"]');
      if (again) again.focus();
    }
    // An open sheet keeps focus inside it: on its first empty field, unless something in it already has focus.
    var sheet = root.querySelector(".sheet");
    if (sheet && !sheet.contains(document.activeElement)) {
      var fields = sheet.querySelectorAll("input:not([hidden])");
      var empty = Array.prototype.filter.call(fields, function (f) {
        return !f.value;
      })[0];
      (empty || fields[0]).focus();
    }
  }

  function openSheet(message, copy) {
    state.sheet = "email";
    state.password = "";
    state.message = message || null;
    state.accountOpen = false;
    state.override = copy ? { title: copy.title || state.copy.title, lede: copy.lede || state.copy.lede } : null;
    render();
  }
  function closeSheet() {
    state.sheet = null;
    state.override = null;
    render();
  }

  function signedIn(session, extra) {
    setSession(session);
    state.sheet = null;
    state.override = null;
    state.message = null;
    state.code = "";
    state.password = "";
    state.accountOpen = false;
    render();
    return emit("sign-in", extra);
  }
  function expired(text) {
    setSession(null);
    emit("sign-out", { reason: "expired" });
    openSheet({ text: text, error: true });
  }
  function signOut() {
    var token = state.session && state.session.access_token;
    if (token) authFetch("logout", {}, token).catch(function () {});
    setSession(null);
    state.accountOpen = false;
    render();
    emit("sign-out", { reason: "user" });
  }

  function busyThen(promise) {
    state.busy = true;
    render();
    return promise
      .catch(function () {
        state.message = { text: "Couldn't reach the server. Check your connection and try again.", error: true };
      })
      .then(function () {
        state.busy = false;
        render();
      });
  }

  function sendCode() {
    state.message = null;
    save(EMAIL_KEY, state.email);
    // The magic link comes back to the page the sheet was opened on.
    var redirect = location.origin + location.pathname;
    busyThen(
      // The email carries both the code ({{ .Token }}) and the magic link ({{ .ConfirmationURL }}).
      authFetch("otp?redirect_to=" + encodeURIComponent(redirect), { email: state.email, create_user: false }).then(function (res) {
        if (res.ok) {
          state.sheet = "code";
          state.code = "";
          return;
        }
        return errorReason(res).then(function (reason) {
          state.message = /signup|not.*found|not allowed/i.test(reason)
            ? { text: "That email can't sign in here.", error: true }
            : { text: "Couldn't send the code" + (reason ? ": " + reason : "") + ".", error: true };
        });
      })
    );
  }
  function verifyCode() {
    state.message = null;
    busyThen(
      authFetch("verify", { type: "email", email: state.email, token: state.code }).then(function (res) {
        if (!res.ok) {
          state.message = { text: "That code didn't work. Check it, or send a new one.", error: true };
          return;
        }
        return res.json().then(function (tokens) {
          signedIn(sessionFrom(tokens));
          // Offer a password so the next sign-in needs no email, unless this browser already used one.
          if (!load(HAS_PASSWORD_KEY, false)) {
            state.sheet = "password";
            render();
          }
        });
      })
    );
  }
  function signInWithPassword() {
    state.message = null;
    save(EMAIL_KEY, state.email);
    busyThen(
      authFetch("token?grant_type=password", { email: state.email, password: state.password }).then(function (res) {
        if (!res.ok) {
          return errorReason(res).then(function (reason) {
            state.message = /invalid login credentials/i.test(reason)
              ? { text: "Wrong email or password. No password yet? Email yourself a code.", error: true }
              : { text: "Couldn't sign in" + (reason ? ": " + reason : "") + ".", error: true };
          });
        }
        return res.json().then(function (tokens) {
          save(HAS_PASSWORD_KEY, true);
          signedIn(sessionFrom(tokens));
        });
      })
    );
  }
  function setPassword() {
    state.message = null;
    busyThen(
      getAccessToken().then(function (token) {
        if (!token) return expired("Your sign-in has expired. Sign in with a code, then set a password.");
        return authFetch("user", { password: state.password }, token, "PUT").then(function (res) {
          if (res.ok) {
            save(HAS_PASSWORD_KEY, true);
            state.sheet = null;
            state.password = "";
            emit("password-saved", { message: "Password saved. Next time, sign in with it." });
            return;
          }
          return errorReason(res).then(function (reason) {
            state.message = { text: "Couldn't save the password" + (reason ? ": " + reason : "") + ".", error: true };
          });
        });
      })
    );
  }

  // Coming back from the magic link: Supabase puts the tokens (or an error) in the URL fragment.
  function readRedirect() {
    if (location.hash.length < 2) return;
    var params = new URLSearchParams(location.hash.slice(1));
    if (params.get("access_token")) {
      var session = sessionFrom(Object.fromEntries(params));
      setSession(session);
      initial = { type: "sign-in", via: "link" };
      // Offer a password so the next sign-in needs no email, unless this browser already used one.
      if (!load(HAS_PASSWORD_KEY, false)) {
        state.sheet = "password";
        state.message = null;
      }
    } else if (params.get("error_description")) {
      initial = { type: "error", message: "Sign-in failed: " + params.get("error_description").replace(/\+/g, " ") + ". Try again." };
    } else {
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------------------------------
  function onClick(e) {
    if (e.target.classList && e.target.classList.contains("sheet-backdrop") && root.contains(e.target)) return closeSheet();
    var el = e.target.closest && e.target.closest("[data-auth]");
    if (!el || el.disabled) return;
    var act = el.getAttribute("data-auth");
    if (act === "signin") openSheet();
    else if (act === "account") {
      state.accountOpen = !state.accountOpen;
      render();
    } else if (act === "set-password") openSetPassword();
    else if (act === "signout") signOut();
    else if (act === "sheet-close") closeSheet();
    else if (act === "sheet-email") {
      state.sheet = "email";
      state.message = null;
      render();
    } else if (act === "send-code") {
      var emailInput = document.getElementById("signin-email");
      if (!emailInput.reportValidity()) return;
      state.email = emailInput.value.trim();
      sendCode();
    } else if (act === "resend") sendCode();
  }
  document.addEventListener("click", function (e) {
    var inAccount = accounts.some(function (a) {
      return e.composedPath().indexOf(a.el) !== -1;
    });
    if (!inAccount && state.accountOpen) {
      state.accountOpen = false;
      render();
    }
    onClick(e);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (state.sheet || state.accountOpen)) {
      state.sheet = null;
      state.accountOpen = false;
      render();
      e.stopImmediatePropagation(); // the chat panel's own Escape handler must not also close the panel
    }
  }, true);
  root.addEventListener("input", function (e) {
    var el = e.target;
    if (el.id === "signin-email") state.email = el.value.trim();
    else if (el.id === "signin-password" || el.id === "new-password") state.password = el.value;
    else if (el.id === "signin-code") state.code = el.value.replace(/\D/g, "");
  });
  root.addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target.getAttribute("data-auth-form");
    if (form === "email") {
      state.email = document.getElementById("signin-email").value.trim();
      state.password = document.getElementById("signin-password").value;
      if (state.email && state.password) signInWithPassword();
    } else if (form === "password") {
      state.password = document.getElementById("new-password").value;
      if (state.password) setPassword();
    } else if (form === "code") {
      state.code = document.getElementById("signin-code").value.replace(/\D/g, "");
      if (state.code) verifyCode();
    }
  });
  // Signing in or out on another tab or page signs this one in or out too.
  window.addEventListener("storage", function (e) {
    if (e.key !== SESSION_KEY) return;
    var was = !!state.session;
    state.session = load(SESSION_KEY, null);
    if (state.session && !was) {
      state.sheet = null;
      render();
      emit("sign-in", { via: "other-tab" });
    } else if (!state.session && was) {
      render();
      emit("sign-out", { reason: "other-tab" });
    } else render();
  });

  function openSetPassword() {
    state.sheet = "password";
    state.message = null;
    state.password = "";
    state.accountOpen = false;
    render();
  }

  window.RecipeAuth = {
    getSession: function () {
      return state.session;
    },
    getAccessToken: getAccessToken,
    refresh: refreshNow,
    onChange: function (fn) {
      listeners.push(fn);
      if (initial) {
        var info = initial;
        setTimeout(function () {
          try {
            fn(state.session, info);
          } catch (e) {
            if (window.console) console.error(e);
          }
        }, 0);
      }
      return function () {
        listeners = listeners.filter(function (l) {
          return l !== fn;
        });
      };
    },
    openSignIn: function (copy) {
      openSheet(null, copy);
    },
    openSetPassword: openSetPassword,
    signOut: signOut,
    sessionExpired: expired,
    renderAccount: function (el, opts) {
      accounts = accounts.filter(function (a) {
        return a.el !== el;
      });
      accounts.push({ el: el, compact: !!(opts && opts.compact) });
      el.innerHTML = accountHtml(!!(opts && opts.compact));
    },
    setCopy: function (copy) {
      state.copy = { title: copy.title || state.copy.title, lede: copy.lede || state.copy.lede };
    },
  };

  readRedirect();
  render();
})();
