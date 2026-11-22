// Sign-in for the whole site (docs/chatbot-design.md 4.2): the Supabase Auth session and what the sign-in sheet shows, as a store with
// @preact/signals. The shopping page's stocktake (src/islands/Shopping.tsx) and the chat (templates/chat.cjs, through the window.RecipeAuth shim in
// src/lib/recipe-auth.ts, until step 8) use the same one. Plain fetch to Supabase's REST API, no client library. It exists only on builds that were
// given SUPABASE_URL and SUPABASE_ANON_KEY (public values; the layout writes them into `#auth-config`, src/lib/auth-boot.ts reads them): without
// them nothing here runs and pages stay read-only.
//
// Sign-in: email + password, or "No password? Email me a code" (6-digit code, and the same email carries a magic link that comes back to the
// page it was sent from); after a code or link sign-in the sheet offers "Set a password". The session lives in localStorage under one key, so
// signing in on one page (or tab) signs you in on all of them (and the key is the one the site has always used, so people stay signed in across
// deploys); the access token is refreshed shortly before it expires.
//
// This module is safe to import when the site is built (nothing touches the browser until `init`).
import { signal } from "@preact/signals";

export const SESSION_KEY = "shopping-editor-session"; // the shopping page's key, kept so existing sign-ins carry over
export const EMAIL_KEY = "shopping-editor-email";
export const HAS_PASSWORD_KEY = "shopping-editor-has-password"; // set once this browser has seen a password work
export const LINK_PENDING_KEY = "recipes-auth-link-pending"; // when this browser last asked for an emailed code / magic link
const LINK_PENDING_MS = 60 * 60 * 1000; // a link that comes back later than this isn't ours

export interface AuthConfig {
  supabaseUrl: string;
  supabaseKey: string;
}
export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email: string;
}
export type Sheet = "email" | "code" | "password" | null;
export interface Notice {
  text: string;
  error?: boolean;
}
export interface SheetCopy {
  title?: string;
  lede?: string;
}
/** What happened: "sign-in" / "sign-out" (`reason`: user, expired, other-tab; sign-in `via`: link, other-tab), "refresh", "password-saved" (`message`), "error" (a failed magic link: `message`). */
export interface AuthInfo {
  type: "sign-in" | "sign-out" | "refresh" | "password-saved" | "error";
  reason?: string;
  via?: string;
  message?: string;
}
export type AuthListener = (session: Session | null, info: AuthInfo) => void;

// -------------------------------------------------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------------------------------------------------

/** The email in a JWT's payload (unverified: the server is what trusts a token), or "". */
export function emailFromJwt(token: unknown): string {
  try {
    const payload = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return (JSON.parse(new TextDecoder().decode(bytes)) as { email?: string }).email || "";
  } catch {
    return "";
  }
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at?: unknown;
  expires_in?: unknown;
  user?: { email?: string };
}
/** A session from what Supabase answered (or the magic link's fragment): `expires_at` in seconds, taken from `expires_in` when it's not there. */
export function sessionFrom(tokens: Tokens, now: number = Date.now()): Session {
  const nowSec = Math.floor(now / 1000);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Number(tokens.expires_at) || nowSec + (Number(tokens.expires_in) || 3600),
    email: tokens.user?.email || emailFromJwt(tokens.access_token),
  };
}

// Storage can throw (private mode, blocked): everything still works without it, for this page view.
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the same page view still works */
  }
}

const DEFAULT_COPY = { title: "Sign in", lede: "Family editors can sign in here." };

// -------------------------------------------------------------------------------------------------------------------
// The store
// -------------------------------------------------------------------------------------------------------------------

export function createAuth() {
  let config: AuthConfig | null = null;
  let stopListening: (() => void) | null = null;
  let listeners: AuthListener[] = [];
  /** What happened while the page loaded (a magic link coming back), handed to every listener that subscribes. */
  let initial: AuthInfo | null = null;
  let refreshing: Promise<string | null> | null = null;

  /** The signed-in session, or null. Signals: a component that reads `.value` draws again when it changes. */
  const session = signal<Session | null>(null);
  const sheet = signal<Sheet>(null);
  const email = signal("");
  const password = signal("");
  const code = signal("");
  /** Shown in the sheet. */
  const message = signal<Notice | null>(null);
  const busy = signal(false);
  const accountOpen = signal(false);
  /** The default sheet title and line for this page. */
  const copy = signal<Required<SheetCopy>>({ ...DEFAULT_COPY });
  /** The copy given to one openSignIn call (the chat's own wording), dropped when the sheet closes. */
  const override = signal<Required<SheetCopy> | null>(null);

  function emit(type: AuthInfo["type"], extra?: Omit<AuthInfo, "type">): void {
    const info: AuthInfo = { type, ...extra };
    for (const fn of listeners.slice()) {
      try {
        fn(session.value, info);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function setSession(next: Session | null): void {
    session.value = next;
    save(SESSION_KEY, next ?? undefined);
  }

  function authFetch(path: string, body?: object, token?: string | null, method = "POST"): Promise<Response> {
    const headers: Record<string, string> = { apikey: config!.supabaseKey, "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${config!.supabaseUrl}/auth/v1/${path}`, { method, headers, body: JSON.stringify(body || {}) });
  }
  async function errorReason(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as { msg?: string; error_description?: string; message?: string };
      return j.msg || j.error_description || j.message || "";
    } catch {
      return "";
    }
  }

  /** Force a refresh now (a server said 401): a fresh token, or null when the session can't be renewed. */
  function refresh(): Promise<string | null> {
    const s = session.value;
    if (!s) return Promise.resolve(null);
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await authFetch("token?grant_type=refresh_token", { refresh_token: s.refresh_token });
        const tokens = res.ok ? ((await res.json()) as Tokens) : null;
        if (!tokens || !tokens.access_token) return null;
        setSession(sessionFrom(tokens));
        emit("refresh");
        return tokens.access_token;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  /** A token that is good for at least a minute (refreshed when needed), or null. */
  function getAccessToken(): Promise<string | null> {
    const s = session.value;
    if (!s) return Promise.resolve(null);
    if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return refresh();
  }

  // --- the sheet ---
  function openSheet(notice?: Notice | null, sheetCopy?: SheetCopy | null): void {
    sheet.value = "email";
    password.value = "";
    message.value = notice || null;
    accountOpen.value = false;
    override.value = sheetCopy ? { title: sheetCopy.title || copy.value.title, lede: sheetCopy.lede || copy.value.lede } : null;
  }
  function closeSheet(): void {
    sheet.value = null;
    override.value = null;
  }
  function openSetPassword(): void {
    sheet.value = "password";
    message.value = null;
    password.value = "";
    accountOpen.value = false;
  }
  /** Back to the email and password form (from the code step). */
  function showEmailSheet(): void {
    sheet.value = "email";
    message.value = null;
  }
  function toggleAccount(): void {
    accountOpen.value = !accountOpen.value;
  }

  function signedIn(next: Session, extra?: Omit<AuthInfo, "type">): void {
    setSession(next);
    sheet.value = null;
    override.value = null;
    message.value = null;
    code.value = "";
    password.value = "";
    accountOpen.value = false;
    emit("sign-in", extra);
  }
  /** The session is no good any more: forget it and open the sheet with `text` as an error ("Your sign-in has expired..."). */
  function sessionExpired(text: string): void {
    setSession(null);
    emit("sign-out", { reason: "expired" });
    openSheet({ text, error: true });
  }
  function signOut(): void {
    const token = session.value?.access_token;
    if (token) authFetch("logout", {}, token).catch(() => {});
    setSession(null);
    accountOpen.value = false;
    emit("sign-out", { reason: "user" });
  }

  async function busyThen(work: () => Promise<void>): Promise<void> {
    busy.value = true;
    try {
      await work();
    } catch {
      message.value = { text: "Couldn't reach the server. Check your connection and try again.", error: true };
    } finally {
      busy.value = false;
    }
  }

  /** Email the code and the magic link; on to the code step. */
  function sendCode(): Promise<void> {
    message.value = null;
    save(EMAIL_KEY, email.value);
    // The magic link comes back to the page the sheet was opened on.
    const redirect = location.origin + location.pathname;
    return busyThen(async () => {
      // The email carries both the code ({{ .Token }}) and the magic link ({{ .ConfirmationURL }}).
      const res = await authFetch(`otp?redirect_to=${encodeURIComponent(redirect)}`, { email: email.value, create_user: false });
      if (res.ok) {
        save(LINK_PENDING_KEY, Date.now());
        sheet.value = "code";
        code.value = "";
        return;
      }
      const reason = await errorReason(res);
      message.value = /signup|not.*found|not allowed/i.test(reason)
        ? { text: "That email can't sign in here.", error: true }
        : { text: `Couldn't send the code${reason ? `: ${reason}` : ""}.`, error: true };
    });
  }
  function verifyCode(): Promise<void> {
    message.value = null;
    return busyThen(async () => {
      const res = await authFetch("verify", { type: "email", email: email.value, token: code.value });
      if (!res.ok) {
        message.value = { text: "That code didn't work. Check it, or send a new one.", error: true };
        return;
      }
      signedIn(sessionFrom((await res.json()) as Tokens));
      // Offer a password so the next sign-in needs no email, unless this browser already used one.
      if (!load(HAS_PASSWORD_KEY, false)) sheet.value = "password";
    });
  }
  function signInWithPassword(): Promise<void> {
    message.value = null;
    save(EMAIL_KEY, email.value);
    return busyThen(async () => {
      const res = await authFetch("token?grant_type=password", { email: email.value, password: password.value });
      if (!res.ok) {
        const reason = await errorReason(res);
        message.value = /invalid login credentials/i.test(reason)
          ? { text: "Wrong email or password. No password yet? Email yourself a code.", error: true }
          : { text: `Couldn't sign in${reason ? `: ${reason}` : ""}.`, error: true };
        return;
      }
      const tokens = (await res.json()) as Tokens;
      save(HAS_PASSWORD_KEY, true);
      signedIn(sessionFrom(tokens));
    });
  }
  function setPassword(): Promise<void> {
    message.value = null;
    return busyThen(async () => {
      const token = await getAccessToken();
      if (!token) return sessionExpired("Your sign-in has expired. Sign in with a code, then set a password.");
      const res = await authFetch("user", { password: password.value }, token, "PUT");
      if (res.ok) {
        save(HAS_PASSWORD_KEY, true);
        sheet.value = null;
        password.value = "";
        emit("password-saved", { message: "Password saved. Next time, sign in with it." });
        return;
      }
      const reason = await errorReason(res);
      message.value = { text: `Couldn't save the password${reason ? `: ${reason}` : ""}.`, error: true };
    });
  }

  /** Coming back from the magic link: Supabase puts the tokens (or an error) in the URL fragment. */
  function readRedirect(): void {
    if (location.hash.length < 2) return;
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get("access_token")) {
      // Only take tokens from the URL if THIS browser asked for a link or code a moment ago: a crafted link carrying someone else's
      // tokens (session fixation) is dropped.
      const asked = Number(load(LINK_PENDING_KEY, 0));
      save(LINK_PENDING_KEY, undefined);
      if (!(asked && Date.now() - asked < LINK_PENDING_MS)) {
        history.replaceState(null, "", location.pathname + location.search);
        return;
      }
      const next = sessionFrom(Object.fromEntries(params) as unknown as Tokens);
      setSession(next);
      // The email shown comes from Supabase, not from the unverified token payload; a token Supabase doesn't accept ends the session.
      fetch(`${config!.supabaseUrl}/auth/v1/user`, { headers: { apikey: config!.supabaseKey, Authorization: `Bearer ${next.access_token}` } })
        .then((res) => (res.ok ? (res.json() as Promise<{ email?: string }>) : null))
        .then(
          (user) => {
            if (!session.value || session.value.access_token !== next.access_token) return;
            if (user && user.email) setSession({ ...session.value, email: user.email });
            else {
              setSession(null);
              emit("sign-out");
            }
          },
          () => {},
        );
      initial = { type: "sign-in", via: "link" };
      // Offer a password so the next sign-in needs no email, unless this browser already used one.
      if (!load(HAS_PASSWORD_KEY, false)) {
        sheet.value = "password";
        message.value = null;
      }
    } else if (params.get("error_description")) {
      initial = { type: "error", message: `Sign-in failed: ${params.get("error_description")!.replace(/\+/g, " ")}. Try again.` };
    } else {
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  /**
   * Start: the keys and the page's address are read, and the listeners that keep the pages in step are set up. Call once, in the browser, as
   * early as the page's scripts (the chat asks for the session as it loads). Calling it again with the same values does nothing.
   */
  function init(cfg: AuthConfig): void {
    const supabaseUrl = cfg.supabaseUrl.replace(/\/$/, "");
    if (config) {
      if (config.supabaseUrl === supabaseUrl && config.supabaseKey === cfg.supabaseKey) return;
      dispose();
    }
    config = { supabaseUrl, supabaseKey: cfg.supabaseKey };
    session.value = load<Session | null>(SESSION_KEY, null);
    email.value = load(EMAIL_KEY, "");

    const stop = new AbortController();
    stopListening = () => stop.abort();
    // A click anywhere else puts the account menu away.
    document.addEventListener(
      "click",
      (e) => {
        if (!accountOpen.value) return;
        const inAccount = e.composedPath().some((n) => n instanceof Element && n.matches(".avatar, .account-menu"));
        if (!inAccount) accountOpen.value = false;
      },
      { signal: stop.signal },
    );
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && (sheet.value || accountOpen.value)) {
          sheet.value = null;
          accountOpen.value = false;
          e.stopImmediatePropagation(); // the chat panel's own Escape handler must not also close the panel
        }
      },
      { capture: true, signal: stop.signal },
    );
    // Signing in or out on another tab or page signs this one in or out too.
    window.addEventListener(
      "storage",
      (e) => {
        if (e.key !== SESSION_KEY) return;
        const was = !!session.value;
        session.value = load<Session | null>(SESSION_KEY, null);
        if (session.value && !was) {
          sheet.value = null;
          emit("sign-in", { via: "other-tab" });
        } else if (!session.value && was) emit("sign-out", { reason: "other-tab" });
      },
      { signal: stop.signal },
    );
    readRedirect();
  }
  /** Stop listening and forget everything (for tests, and for a second `init` with other values). */
  function dispose(): void {
    stopListening?.();
    stopListening = null;
    config = null;
    listeners = [];
    initial = null;
    refreshing = null;
    session.value = null;
    sheet.value = null;
    email.value = "";
    password.value = "";
    code.value = "";
    message.value = null;
    busy.value = false;
    accountOpen.value = false;
    copy.value = { ...DEFAULT_COPY };
    override.value = null;
  }

  /** fn(session, info) on every change. Returns an unsubscribe function. A magic-link return that happened while the page was loading is delivered to each listener, a tick after it subscribes. */
  function onChange(fn: AuthListener): () => void {
    listeners.push(fn);
    if (initial) {
      const info = initial;
      setTimeout(() => {
        try {
          fn(session.value, info);
        } catch (e) {
          console.error(e);
        }
      }, 0);
    }
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  }

  return {
    session, sheet, email, password, code, message, busy, accountOpen, copy, override,
    /** Whether `init` has been called: the build had the Supabase values. */
    get enabled() {
      return config !== null;
    },
    init, dispose, onChange,
    getSession: () => session.value,
    getAccessToken, refresh,
    openSignIn: (sheetCopy?: SheetCopy | null) => openSheet(null, sheetCopy),
    openSetPassword, closeSheet, showEmailSheet, toggleAccount,
    signOut, sessionExpired,
    sendCode, verifyCode, signInWithPassword, setPassword,
    /** This page's default sheet title and line. */
    setCopy: (c: SheetCopy) => {
      copy.value = { title: c.title || copy.value.title, lede: c.lede || copy.value.lede };
    },
  };
}
export type Auth = ReturnType<typeof createAuth>;

/** The site's one sign-in. */
export const auth: Auth = createAuth();
