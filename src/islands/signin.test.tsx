// The sign-in parts in a fake DOM (happy-dom): the account button, the sheet, and the window.RecipeAuth shim the chat still uses until step 8.
import { act } from "preact/test-utils";
import { render, h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_KEY, createAuth, type Session } from "../lib/auth.ts";
import { installRecipeAuth } from "../lib/recipe-auth.ts";
import AccountButton, { SignInSheet } from "./SignIn.tsx";

const jwt = (email: string) => `h.${btoa(JSON.stringify({ email }))}.s`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const session = (email = "ed@example.com"): Session => ({ access_token: jwt(email), refresh_token: "r", expires_at: 4_000_000_000, email });

let store: ReturnType<typeof createAuth>;
let fetchMock: ReturnType<typeof vi.fn>;
let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById("root")!;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  store = createAuth();
  store.init({ supabaseUrl: "https://p.test", supabaseKey: "k" });
});
afterEach(() => {
  act(() => render(null, root));
  store.dispose();
  vi.unstubAllGlobals();
  delete window.RecipeAuth;
  document.body.className = "";
});
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const type = (el: Element | null, value: string) =>
  act(() => {
    (el as HTMLInputElement).value = value;
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
const flush = () => new Promise((r) => setTimeout(r, 0));
// A tap or a submit, and the fetches it starts (a few promise hops) settled.
const submit = (selector: string) => act(async () => {
  document.querySelector(selector)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
});

describe("AccountButton", () => {
  it("is a Sign in pill when signed out, and the icon alone in the chat's header", () => {
    act(() => render(<AccountButton store={store} />, root));
    const pill = root.querySelector("button.pill")!;
    expect(pill.getAttribute("data-auth")).toBe("signin");
    expect(pill.textContent).toBe("Sign in");
    expect(pill.querySelector("svg.icon")).not.toBeNull();
    act(() => render(<AccountButton store={store} compact />, root));
    expect(root.querySelector("button.pill")!.className).toBe("pill is-compact");
    expect(root.querySelector("button.pill")!.getAttribute("aria-label")).toBe("Sign in");
    expect(root.textContent).toBe("");
  });

  it("opens the sheet", () => {
    act(() => render(<AccountButton store={store} />, root));
    click(root.querySelector(".pill"));
    expect(store.sheet.value).toBe("email");
  });

  it("is the avatar and a menu when signed in, with Set a password and Sign out", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session("zed@example.com")));
    store.dispose();
    store.init({ supabaseUrl: "https://p.test", supabaseKey: "k" });
    act(() => render(<AccountButton store={store} />, root));
    const avatar = root.querySelector("button.avatar")!;
    expect(avatar.textContent).toBe("Z");
    expect(avatar.getAttribute("aria-label")).toBe("Signed in as zed@example.com");
    expect(avatar.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".account-menu")).toBeNull();
    click(avatar);
    expect(avatar.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(".account-menu p")!.textContent).toBe("Signed in as zed@example.com");
    click(root.querySelector('[data-auth="set-password"]'));
    expect(store.sheet.value).toBe("password");
    expect(root.querySelector(".account-menu")).toBeNull();
    click(avatar);
    fetchMock.mockResolvedValue(json({}));
    click(root.querySelector('[data-auth="signout"]'));
    expect(store.getSession()).toBeNull();
    expect(root.querySelector("button.pill")).not.toBeNull();
  });
});

describe("SignInSheet", () => {
  const mount = () => act(() => render(<SignInSheet store={store} />, root));

  it("is nothing until it is opened, and then a dialog with the email and password form, that keeps the page still and takes focus", () => {
    mount();
    expect(root.innerHTML).toBe("");
    act(() => store.openSignIn());
    expect(root.querySelector('.sheet[role="dialog"]')).not.toBeNull();
    expect(root.querySelector("#sheet-title")!.textContent).toBe("Sign in");
    expect(document.body.classList.contains("sheet-open")).toBe(true);
    expect(document.activeElement!.id).toBe("signin-email");
    act(() => store.closeSheet());
    expect(document.body.classList.contains("sheet-open")).toBe(false);
  });

  it("uses the page's words, or the call's", () => {
    mount();
    store.setCopy({ title: "Update what's at home", lede: "Sign in once." });
    act(() => store.openSignIn());
    expect(root.querySelector("h2")!.textContent).toBe("Update what's at home");
    expect(root.querySelector(".sheet-head p")!.textContent).toBe("Sign in once.");
    act(() => store.openSignIn({ title: "Sign in to the chat" }));
    expect(root.querySelector("h2")!.textContent).toBe("Sign in to the chat");
  });

  it("signs in with the typed email and password", async () => {
    mount();
    act(() => store.openSignIn());
    fetchMock.mockResolvedValueOnce(json({ access_token: jwt("ed@example.com"), refresh_token: "r", expires_in: 3600 }));
    type(root.querySelector("#signin-email"), "ed@example.com");
    type(root.querySelector("#signin-password"), "pw");
    await submit('form[data-auth-form="email"]');
    expect(fetchMock.mock.calls[0][0]).toBe("https://p.test/auth/v1/token?grant_type=password");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: "ed@example.com", password: "pw" });
    expect(store.getSession()?.email).toBe("ed@example.com");
    expect(root.innerHTML).toBe("");
  });

  it("shows why it failed, in the sheet", async () => {
    mount();
    act(() => store.openSignIn());
    fetchMock.mockResolvedValueOnce(json({ error_description: "Invalid login credentials" }, 400));
    type(root.querySelector("#signin-email"), "ed@example.com");
    type(root.querySelector("#signin-password"), "bad");
    await submit("form");
    const status = root.querySelector(".shopping-status.is-error")!;
    expect(status.textContent).toBe("Wrong email or password. No password yet? Email yourself a code.");
    expect(status.getAttribute("role")).toBe("status");
  });

  it("takes the emailed code: send it, then type it, then offers a password", async () => {
    mount();
    act(() => store.openSignIn());
    fetchMock.mockResolvedValueOnce(json({}));
    type(root.querySelector("#signin-email"), "ed@example.com");
    await act(async () => {
      (root.querySelector('[data-auth="send-code"]') as HTMLElement).click();
      await flush();
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/auth/v1/otp?redirect_to=");
    expect(root.querySelector(".sheet-head p")!.textContent).toBe("We sent a code to ed@example.com. It works on any device.");
    expect(document.activeElement!.id).toBe("signin-code");
    fetchMock.mockResolvedValueOnce(json({ access_token: jwt("ed@example.com"), refresh_token: "r", expires_in: 3600 }));
    type(root.querySelector("#signin-code"), "123456");
    await submit('form[data-auth-form="code"]');
    expect(store.getSession()?.email).toBe("ed@example.com");
    expect(root.querySelector("#sheet-title")!.textContent).toBe("Set a password");
    expect(root.querySelector("#new-password")).not.toBeNull();
    click(root.querySelector('[data-auth="sheet-close"].text-button'));
    expect(root.innerHTML).toBe("");
  });

  it("closes on the close button, on a tap outside the sheet and not on a tap inside it", () => {
    mount();
    act(() => store.openSignIn());
    click(root.querySelector(".sheet"));
    expect(store.sheet.value).toBe("email");
    click(root.querySelector(".sheet-backdrop"));
    expect(store.sheet.value).toBeNull();
    act(() => store.openSignIn());
    click(root.querySelector('[data-auth="sheet-close"]'));
    expect(store.sheet.value).toBeNull();
  });
});

describe("window.RecipeAuth, for the chat until step 8", () => {
  it("has the methods the chat calls, and nothing else", () => {
    const api = installRecipeAuth(store);
    expect(window.RecipeAuth).toBe(api);
    expect(Object.keys(api).sort()).toEqual(["getAccessToken", "getSession", "onChange", "openSetPassword", "openSignIn", "refresh", "renderAccount", "sessionExpired", "setCopy", "signOut"]);
  });

  it("is the store: the session, the token, listeners, the sheet", async () => {
    const api = installRecipeAuth(store);
    expect(api.getSession()).toBeNull();
    expect(await api.getAccessToken()).toBeNull();
    const heard: string[] = [];
    const off = api.onChange((_s, info) => heard.push(info.type));
    fetchMock.mockResolvedValueOnce(json({ access_token: jwt("ed@example.com"), refresh_token: "r", expires_in: 3600 }));
    store.email.value = "ed@example.com";
    store.password.value = "x";
    await store.signInWithPassword();
    expect(api.getSession()?.email).toBe("ed@example.com");
    expect(await api.getAccessToken()).toBe(jwt("ed@example.com"));
    off();
    api.sessionExpired("Your sign-in has expired.");
    expect(heard).toEqual(["sign-in"]); // unsubscribed before the expiry
    expect(store.sheet.value).toBe("email");
    expect(store.message.value?.text).toBe("Your sign-in has expired.");
    api.openSetPassword();
    expect(store.sheet.value).toBe("password");
    api.setCopy({ title: "T" });
    api.openSignIn({ lede: "L" });
    expect(store.override.value).toEqual({ title: "T", lede: "L" });
  });

  it("draws the account button into the chat's own element, compact, and follows sign-in", () => {
    const api = installRecipeAuth(store);
    const host = document.createElement("div");
    document.body.appendChild(host);
    api.renderAccount(host, { compact: true });
    expect(host.querySelector("button.pill.is-compact")).not.toBeNull();
    // The chat catches the click first (capture) to give the sheet its own wording, and keeps the button's own handler from also opening it.
    const open = vi.fn();
    host.addEventListener("click", (e) => { if ((e.target as Element).closest('[data-auth="signin"]')) { e.stopPropagation(); open(); api.openSignIn({ title: "Sign in to the chat" }); } }, true);
    click(host.querySelector('[data-auth="signin"]'));
    expect(open).toHaveBeenCalledOnce();
    expect(store.override.value?.title).toBe("Sign in to the chat");
    act(() => { store.sheet.value = null; store.override.value = null; });
    host.remove();
  });

  it("renderAccount again on the same element replaces, it doesn't stack", () => {
    const api = installRecipeAuth(store);
    const host = document.createElement("div");
    api.renderAccount(host);
    api.renderAccount(host, { compact: true });
    expect(host.querySelectorAll("button").length).toBe(1);
    expect(host.querySelector("button")!.className).toBe("pill is-compact");
    act(() => void render(h("i", {}), host));
  });
});
