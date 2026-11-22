// What the chat keeps in the browser: the keys stay the ones it always used (chats and trays in progress survive the deploy), a new visit is a
// tab without the visit marker, and blocked storage never breaks anything.
import { beforeEach, describe, expect, it } from "vitest";
import {
  EDITOR_KEY, OFF_KEY, PENDING_KEY, SEEN_KEY, STORE_KEY, TRAY_FOLD_KEY, UI_KEY, VISIT_KEY, cleanPending, loadChat, loadTrayFold, loadUi, readJson, rememberOff,
  saveChat, saveTrayFold, saveUi, startVisit, storageOf, switchedOff, writeJson,
} from "./storage.ts";

const blocked = storageOf({ get localStorage(): Storage { throw new Error("SecurityError"); } } as unknown as Window, "localStorage");
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("keys", () => {
  it("are the ones the chat has always used", () => {
    expect([STORE_KEY, EDITOR_KEY, PENDING_KEY, SEEN_KEY, VISIT_KEY, UI_KEY, OFF_KEY, TRAY_FOLD_KEY]).toEqual([
      "recipes-chat", "recipes-chat-editor", "recipes-chat-signin", "recipes-chat-seen", "recipes-chat-visit", "recipes-chat-ui", "recipes-chat-off", "recipes-chat-tray-fold",
    ]);
  });
});

describe("a new visit", () => {
  it("is the first page of a tab; later pages of the tab are the same visit", () => {
    expect(startVisit(sessionStorage, localStorage)).toBe(true);
    expect(sessionStorage.getItem(VISIT_KEY)).toBe("1");
    expect(startVisit(sessionStorage, localStorage)).toBe(false);
  });
  it("isn't, when a sign-in from the chat was started less than 30 minutes ago (the magic link comes back in a new tab)", () => {
    const now = Date.now();
    writeJson(localStorage, PENDING_KEY, { t: now - 10 * 60 * 1000, open: true, draft: "" });
    expect(startVisit(sessionStorage, localStorage, now)).toBe(false);
    sessionStorage.clear();
    writeJson(localStorage, PENDING_KEY, { t: now - 31 * 60 * 1000, open: true, draft: "" });
    expect(startVisit(sessionStorage, localStorage, now)).toBe(true);
  });
  it("never happens when sessionStorage can't be used (the conversation is kept)", () => {
    expect(startVisit(blocked, localStorage)).toBe(false);
  });
});

describe("the visitor's chat", () => {
  it("is saved and loaded under recipes-chat, at most 40 messages, two weeks", () => {
    const messages = Array.from({ length: 45 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    saveChat(localStorage, { id: "c1", messages }, 1000);
    const raw = readJson(localStorage, STORE_KEY) as { id: string; updated: number; messages: unknown[] };
    expect(raw.id).toBe("c1");
    expect(raw.updated).toBe(1000);
    expect(raw.messages.length).toBe(40);
    expect(loadChat(localStorage, "https://site.test", 2000).messages.length).toBe(40);
    expect(loadChat(localStorage, "https://site.test", 1000 + 15 * 86400_000).messages).toEqual([]);
  });
  it("starts fresh on junk or blocked storage", () => {
    localStorage.setItem(STORE_KEY, "{nope");
    expect(loadChat(localStorage, "https://site.test")).toMatchObject({ messages: [] });
    expect(loadChat(blocked, "https://site.test").id).toMatch(/^c[a-z0-9]+$/);
    expect(() => saveChat(blocked, { id: "x", messages: [] })).not.toThrow();
  });
});

describe("the tab's panel state", () => {
  it("round-trips and ignores junk", () => {
    saveUi(sessionStorage, { open: true, id: "c1", draft: "hi", unread: false, pending: { conv: "a", turn: "b", t: 5 } });
    expect(loadUi(sessionStorage)).toEqual({ open: true, id: "c1", draft: "hi", unread: false, pending: { conv: "a", turn: "b", t: 5 } });
    sessionStorage.setItem(UI_KEY, "5");
    expect(loadUi(sessionStorage)).toEqual({});
    expect(loadUi(blocked)).toEqual({});
    expect(cleanPending({ conv: "a", turn: "b", t: "7" })).toEqual({ conv: "a", turn: "b", t: 7 });
    expect(cleanPending({ conv: "a", turn: 3, t: 7 })).toBeNull();
    expect(cleanPending(null)).toBeNull();
  });
  it("the tray's fold and the switched-off marker", () => {
    expect(loadTrayFold(sessionStorage)).toEqual({ folded: false, changed: false });
    saveTrayFold(sessionStorage, true, true);
    expect(JSON.parse(sessionStorage.getItem(TRAY_FOLD_KEY)!)).toEqual({ folded: true, changed: true });
    expect(loadTrayFold(sessionStorage)).toEqual({ folded: true, changed: true });
    saveTrayFold(sessionStorage, false, true);
    expect(sessionStorage.getItem(TRAY_FOLD_KEY)).toBeNull();
    expect(switchedOff(sessionStorage)).toBe(false);
    rememberOff(sessionStorage);
    expect(sessionStorage.getItem(OFF_KEY)).toBe("1");
    expect(switchedOff(sessionStorage)).toBe(true);
    expect(switchedOff(blocked)).toBe(false);
  });
  it("writeJson removes on null and never throws", () => {
    writeJson(localStorage, "k", { a: 1 });
    expect(readJson(localStorage, "k")).toEqual({ a: 1 });
    writeJson(localStorage, "k", null);
    expect(localStorage.getItem("k")).toBeNull();
    expect(() => writeJson(blocked, "k", 1)).not.toThrow();
    expect(readJson(blocked, "k")).toBeNull();
  });
});
