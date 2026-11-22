import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_KEY, HAS_PASSWORD_KEY, LINK_PENDING_KEY, SESSION_KEY, createAuth, emailFromJwt, sessionFrom, type AuthInfo, type Session } from "./auth.ts";

const URL = "https://proj.supabase.test";
const CONFIG = { supabaseUrl: `${URL}/`, supabaseKey: "anon" };
const jwt = (email: string) => `h.${btoa(JSON.stringify({ email })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokens = (email: string, extra: object = {}) => ({ access_token: jwt(email), refresh_token: "refresh-1", expires_in: 3600, user: { email }, ...extra });
const stored = (): Session | null => JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
const flush = () => new Promise((r) => setTimeout(r, 0));

let fetchMock: ReturnType<typeof vi.fn>;
let store: ReturnType<typeof createAuth>;
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url).replace(URL, ""), init: init as RequestInit, body: init?.body ? JSON.parse(String(init.body)) : null }));

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/shopping-list.html");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  store = createAuth();
});
afterEach(() => {
  store.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the session helpers", () => {
  it("reads the email out of a token and survives one that isn't", () => {
    expect(emailFromJwt(jwt("ann@example.com"))).toBe("ann@example.com");
    expect(emailFromJwt(`h.${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ email: "zoë@example.com" }))))}.s`)).toBe("zoë@example.com");
    expect(emailFromJwt("nonsense")).toBe("");
    expect(emailFromJwt(undefined)).toBe("");
  });

  it("makes a session from what Supabase answers: expires_at wins, else now + expires_in, else an hour", () => {
    const now = 1_700_000_000_000;
    expect(sessionFrom({ access_token: jwt("a@b.c"), refresh_token: "r", expires_at: 1_700_005_000 }, now)).toEqual({ access_token: jwt("a@b.c"), refresh_token: "r", expires_at: 1_700_005_000, email: "a@b.c" });
    expect(sessionFrom({ access_token: "x", refresh_token: "r", expires_in: 60, user: { email: "u@x.y" } }, now)).toMatchObject({ expires_at: 1_700_000_060, email: "u@x.y" });
    expect(sessionFrom({ access_token: "x", refresh_token: "r" }, now).expires_at).toBe(1_700_003_600);
  });
});

describe("the store", () => {
  it("restores the session from the key the site has always used, so people stay signed in", () => {
    expect(SESSION_KEY).toBe("shopping-editor-session");
    expect(EMAIL_KEY).toBe("shopping-editor-email");
    expect(HAS_PASSWORD_KEY).toBe("shopping-editor-has-password");
    expect(LINK_PENDING_KEY).toBe("recipes-auth-link-pending");
    const old = { access_token: jwt("ed@example.com"), refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3000, email: "ed@example.com" };
    localStorage.setItem(SESSION_KEY, JSON.stringify(old));
    localStorage.setItem(EMAIL_KEY, JSON.stringify("ed@example.com"));
    expect(store.enabled).toBe(false);
    store.init(CONFIG);
    expect(store.enabled).toBe(true);
    expect(store.getSession()).toEqual(old);
    expect(store.email.value).toBe("ed@example.com");
  });

  it("starts signed out with nothing stored, or with storage that throws", () => {
    store.init(CONFIG);
    expect(store.getSession()).toBeNull();
    store.dispose();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    store.init(CONFIG);
    expect(store.getSession()).toBeNull();
    vi.restoreAllMocks();
  });

  it("signs in with email and password: the same call, the session stored, listeners told, the sheet shut", async () => {
    store.init(CONFIG);
    const events: [Session | null, AuthInfo][] = [];
    store.onChange((s, i) => events.push([s, i]));
    fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com")));
    store.openSignIn();
    expect(store.sheet.value).toBe("email");
    store.email.value = "ed@example.com";
    store.password.value = "secret";
    await store.signInWithPassword();
    const [call] = calls();
    expect(call.url).toBe("/auth/v1/token?grant_type=password");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({ apikey: "anon", "Content-Type": "application/json" });
    expect(call.body).toEqual({ email: "ed@example.com", password: "secret" });
    expect(store.getSession()?.email).toBe("ed@example.com");
    expect(stored()).toEqual(store.getSession());
    expect(localStorage.getItem(HAS_PASSWORD_KEY)).toBe("true");
    expect(localStorage.getItem(EMAIL_KEY)).toBe('"ed@example.com"');
    expect(store.sheet.value).toBeNull();
    expect(store.password.value).toBe("");
    expect(events.map(([, i]) => i.type)).toEqual(["sign-in"]);
    expect(store.busy.value).toBe(false);
  });

  it("says why a sign-in failed", async () => {
    store.init(CONFIG);
    store.openSignIn();
    fetchMock.mockResolvedValueOnce(json({ error_description: "Invalid login credentials" }, 400));
    await store.signInWithPassword();
    expect(store.message.value).toEqual({ text: "Wrong email or password. No password yet? Email yourself a code.", error: true });
    expect(store.getSession()).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ msg: "Too many requests" }, 429));
    await store.signInWithPassword();
    expect(store.message.value?.text).toBe("Couldn't sign in: Too many requests.");
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await store.signInWithPassword();
    expect(store.message.value).toEqual({ text: "Couldn't reach the server. Check your connection and try again.", error: true });
    expect(store.busy.value).toBe(false);
  });

  it("emails a code with a link back to this page, then signs in with it and offers a password", async () => {
    store.init(CONFIG);
    store.openSignIn();
    store.email.value = "ed@example.com";
    fetchMock.mockResolvedValueOnce(json({}));
    await store.sendCode();
    const send = calls()[0];
    expect(send.url).toBe(`/auth/v1/otp?redirect_to=${encodeURIComponent(`${location.origin}/shopping-list.html`)}`);
    expect(send.body).toEqual({ email: "ed@example.com", create_user: false });
    expect(store.sheet.value).toBe("code");
    expect(Number(localStorage.getItem(LINK_PENDING_KEY))).toBeGreaterThan(0);

    store.code.value = "123456";
    fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com")));
    await store.verifyCode();
    expect(calls()[1]).toMatchObject({ url: "/auth/v1/verify", body: { type: "email", email: "ed@example.com", token: "123456" } });
    expect(store.getSession()?.email).toBe("ed@example.com");
    expect(store.sheet.value).toBe("password"); // this browser has never used a password
  });

  it("doesn't offer a password again to a browser that already used one, and says when a code is wrong or the email can't sign in", async () => {
    store.init(CONFIG);
    localStorage.setItem(HAS_PASSWORD_KEY, "true");
    store.email.value = "ed@example.com";
    store.code.value = "123456";
    fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com")));
    await store.verifyCode();
    expect(store.sheet.value).toBeNull();
    fetchMock.mockResolvedValueOnce(json({}));
    store.signOut();
    store.openSignIn();
    fetchMock.mockResolvedValueOnce(json({ msg: "Signups not allowed for otp" }, 422));
    await store.sendCode();
    expect(store.message.value).toEqual({ text: "That email can't sign in here.", error: true });
    store.code.value = "000000";
    fetchMock.mockResolvedValueOnce(json({}, 400));
    await store.verifyCode();
    expect(store.message.value?.text).toBe("That code didn't work. Check it, or send a new one.");
  });

  it("sets a password for the signed-in user (PUT /user with their token)", async () => {
    store.init(CONFIG);
    fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com")));
    store.email.value = "ed@example.com";
    await store.signInWithPassword();
    const infos: AuthInfo[] = [];
    store.onChange((_s, i) => infos.push(i));
    store.openSetPassword();
    expect(store.sheet.value).toBe("password");
    store.password.value = "newpass";
    fetchMock.mockResolvedValueOnce(json({}));
    await store.setPassword();
    const put = calls()[1];
    expect(put).toMatchObject({ url: "/auth/v1/user", body: { password: "newpass" } });
    expect(put.init.method).toBe("PUT");
    expect((put.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${store.getSession()!.access_token}`);
    expect(store.sheet.value).toBeNull();
    expect(infos).toEqual([{ type: "password-saved", message: "Password saved. Next time, sign in with it." }]);
  });

  it("signs out: tells Supabase, forgets the session, tells listeners", async () => {
    store.init(CONFIG);
    fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com")));
    store.email.value = "ed@example.com";
    await store.signInWithPassword();
    const token = store.getSession()!.access_token;
    const infos: AuthInfo[] = [];
    store.onChange((_s, i) => infos.push(i));
    fetchMock.mockResolvedValueOnce(json({}));
    store.signOut();
    expect(calls()[1].url).toBe("/auth/v1/logout");
    expect((calls()[1].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(store.getSession()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(infos).toEqual([{ type: "sign-out", reason: "user" }]);
  });

  describe("the access token", () => {
    const seed = (expiresInSeconds: number) => {
      const s = { access_token: "old-token", refresh_token: "r-old", expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds, email: "ed@example.com" };
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      store.init(CONFIG);
      return s;
    };

    it("is the stored one while it has more than a minute left, and null when signed out", async () => {
      seed(3000);
      expect(await store.getAccessToken()).toBe("old-token");
      expect(fetchMock).not.toHaveBeenCalled();
      store.dispose();
      store.init(CONFIG);
      localStorage.clear();
      store.dispose();
      expect(await createAuth().getAccessToken()).toBeNull();
    });

    it("is refreshed when it's about to expire, once for callers that ask together, and the new session is kept", async () => {
      seed(30);
      const infos: AuthInfo[] = [];
      store.onChange((_s, i) => infos.push(i));
      fetchMock.mockResolvedValue(json(tokens("ed@example.com", { access_token: "new-token", refresh_token: "r-new" })));
      const [a, b] = await Promise.all([store.getAccessToken(), store.getAccessToken()]);
      expect([a, b]).toEqual(["new-token", "new-token"]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(calls()[0]).toMatchObject({ url: "/auth/v1/token?grant_type=refresh_token", body: { refresh_token: "r-old" } });
      expect(stored()).toMatchObject({ access_token: "new-token", refresh_token: "r-new", email: "ed@example.com" });
      expect(infos).toEqual([{ type: "refresh" }]);
    });

    it("is null when the session can't be renewed, and refresh() forces one", async () => {
      seed(30);
      fetchMock.mockResolvedValueOnce(json({ error: "invalid" }, 400));
      expect(await store.getAccessToken()).toBeNull();
      fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com", { access_token: "forced" })));
      expect(await store.refresh()).toBe("forced"); // the session was kept: only a refusal to renew gave null
      fetchMock.mockRejectedValueOnce(new Error("offline"));
      await expect(store.refresh()).rejects.toThrow("offline");
      fetchMock.mockResolvedValueOnce(json(tokens("ed@example.com", { access_token: "again" })));
      expect(await store.refresh()).toBe("again"); // a failed refresh doesn't leave the next one waiting
    });

    it("sessionExpired forgets the session and opens the sheet with the text as an error", () => {
      seed(3000);
      const infos: AuthInfo[] = [];
      store.onChange((_s, i) => infos.push(i));
      store.sessionExpired("Your sign-in has expired.");
      expect(store.getSession()).toBeNull();
      expect(store.sheet.value).toBe("email");
      expect(store.message.value).toEqual({ text: "Your sign-in has expired.", error: true });
      expect(infos).toEqual([{ type: "sign-out", reason: "expired" }]);
    });
  });

  it("gives the sheet this page's words, or one call's own, which are dropped when it closes", () => {
    store.init(CONFIG);
    store.openSignIn();
    expect(store.override.value).toBeNull();
    expect(store.copy.value).toEqual({ title: "Sign in", lede: "Family editors can sign in here." });
    store.setCopy({ title: "Update what's at home" });
    expect(store.copy.value).toEqual({ title: "Update what's at home", lede: "Family editors can sign in here." });
    store.openSignIn({ title: "Sign in to the chat" });
    expect(store.override.value).toEqual({ title: "Sign in to the chat", lede: "Family editors can sign in here." });
    store.closeSheet();
    expect(store.sheet.value).toBeNull();
    expect(store.override.value).toBeNull();
  });

  it("Escape shuts the sheet and the menu, and stops the chat's own Escape handler", () => {
    store.init(CONFIG);
    const chat = vi.fn();
    document.addEventListener("keydown", chat);
    store.openSignIn();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(store.sheet.value).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // nothing open: the chat gets it
    expect(chat).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", chat);
  });

  it("a click elsewhere puts the account menu away, a click in it doesn't", () => {
    store.init(CONFIG);
    document.body.innerHTML = '<div id="out"></div><button class="avatar"></button><div class="account-menu"><button id="in"></button></div>';
    store.toggleAccount();
    document.getElementById("in")!.click();
    expect(store.accountOpen.value).toBe(true);
    document.getElementById("out")!.click();
    expect(store.accountOpen.value).toBe(false);
  });

  it("signs in or out here when another tab does", () => {
    store.init(CONFIG);
    const infos: AuthInfo[] = [];
    store.onChange((_s, i) => infos.push(i));
    const session = { access_token: "t", refresh_token: "r", expires_at: 4_000_000_000, email: "ed@example.com" };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY }));
    expect(store.getSession()).toEqual(session);
    localStorage.removeItem(SESSION_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY }));
    expect(store.getSession()).toBeNull();
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(infos).toEqual([{ type: "sign-in", via: "other-tab" }, { type: "sign-out", reason: "other-tab" }]);
  });

  describe("coming back from the emailed link", () => {
    const fragment = (extra = "") => `#access_token=${jwt("link@example.com")}&refresh_token=rl&expires_in=3600&token_type=bearer${extra}`;

    it("takes the tokens from the address when this browser asked for a link, checks the email with Supabase, and cleans the address", async () => {
      localStorage.setItem(LINK_PENDING_KEY, String(Date.now() - 1000));
      history.replaceState(null, "", `/shopping-list.html?x=1${fragment()}`);
      fetchMock.mockResolvedValueOnce(json({ email: "verified@example.com" }));
      store.init(CONFIG);
      expect(store.getSession()?.refresh_token).toBe("rl");
      expect(location.hash).toBe("");
      expect(location.search).toBe("?x=1");
      expect(localStorage.getItem(LINK_PENDING_KEY)).toBeNull();
      expect(store.sheet.value).toBe("password");
      expect(calls()[0].url).toBe("/auth/v1/user");
      await flush();
      expect(store.getSession()?.email).toBe("verified@example.com"); // Supabase's, not the token's
      // Every listener that subscribes hears about it, a tick later.
      const heard: AuthInfo[] = [];
      store.onChange((_s, i) => heard.push(i));
      expect(heard).toEqual([]);
      await flush();
      expect(heard).toEqual([{ type: "sign-in", via: "link" }]);
    });

    it("ends the session if Supabase doesn't accept the token", async () => {
      localStorage.setItem(LINK_PENDING_KEY, String(Date.now()));
      history.replaceState(null, "", `/shopping-list.html${fragment()}`);
      fetchMock.mockResolvedValueOnce(json({}, 401));
      const infos: AuthInfo[] = [];
      store.onChange((_s, i) => infos.push(i));
      store.init(CONFIG);
      await flush();
      expect(store.getSession()).toBeNull();
      expect(localStorage.getItem(SESSION_KEY)).toBeNull();
      expect(infos).toContainEqual({ type: "sign-out" });
    });

    it("drops tokens in a link this browser never asked for (someone else's session), or one that took over an hour", () => {
      history.replaceState(null, "", `/shopping-list.html${fragment()}`);
      store.init(CONFIG);
      expect(store.getSession()).toBeNull();
      expect(location.hash).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
      store.dispose();
      localStorage.setItem(LINK_PENDING_KEY, String(Date.now() - 61 * 60 * 1000));
      history.replaceState(null, "", `/shopping-list.html${fragment()}`);
      store.init(CONFIG);
      expect(store.getSession()).toBeNull();
    });

    it("reports a link that failed", async () => {
      history.replaceState(null, "", "/shopping-list.html#error=access_denied&error_description=Email+link+is+invalid+or+has+expired");
      store.init(CONFIG);
      const heard: AuthInfo[] = [];
      store.onChange((_s, i) => heard.push(i));
      await flush();
      expect(heard).toEqual([{ type: "error", message: "Sign-in failed: Email link is invalid or has expired. Try again." }]);
      expect(location.hash).toBe("");
    });
  });

  it("init twice with the same values does nothing; with other values starts over", () => {
    store.init(CONFIG);
    store.openSignIn();
    store.init(CONFIG);
    expect(store.sheet.value).toBe("email");
    store.init({ supabaseUrl: "https://other.test", supabaseKey: "k2" });
    expect(store.sheet.value).toBeNull();
  });
});
