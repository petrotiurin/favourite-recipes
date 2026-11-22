// The reload-once guard (docs/typescript-migration.md 4.11): a script gone after a deploy reloads the page, once a minute at most, and never over unsent chat text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadOnStaleScript } from "./reload-guard.ts";

function setup({ storage = true }: { storage?: boolean } = {}) {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const win = new EventTarget() as unknown as Window;
  Object.assign(win, {
    document,
    location: { pathname: "/favourite-recipes/recipes/rice.html", reload },
    sessionStorage: storage
      ? { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
      : { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } },
  });
  reloadOnStaleScript(win);
  const fire = (name: string) => win.dispatchEvent(new Event(name));
  return { reload, fire, store };
}
const chatBox = (text: string) => {
  document.body.innerHTML = `<textarea class="chat-input"></textarea>`;
  document.querySelector<HTMLTextAreaElement>(".chat-input")!.value = text;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
  document.body.innerHTML = "";
});
afterEach(() => vi.useRealTimers());

describe("reloadOnStaleScript", () => {
  it("reloads when a script's parts fail to load (Vite) or an island's script does (Astro)", () => {
    for (const name of ["vite:preloadError", "astro:hydration-error"]) {
      const { reload, fire } = setup();
      fire(name);
      expect(reload, name).toHaveBeenCalledOnce();
    }
  });

  it("reloads once, and not again within a minute, however many scripts fail", () => {
    const { reload, fire } = setup();
    fire("astro:hydration-error");
    fire("astro:hydration-error");
    fire("vite:preloadError");
    expect(reload).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(59_000);
    fire("astro:hydration-error");
    expect(reload).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    fire("astro:hydration-error");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("remembers per page: another page's reload doesn't count", () => {
    const { reload, fire, store } = setup();
    store.set("reloaded-for-stale-script:/favourite-recipes/index.html", String(Date.now()));
    fire("astro:hydration-error");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("doesn't reload while the chat's message box holds text, but does once it is empty or blank", () => {
    chatBox("what can I make with leftover rice");
    const { reload, fire, store } = setup();
    fire("astro:hydration-error");
    expect(reload).not.toHaveBeenCalled();
    expect(store.size).toBe(0); // and doesn't use up its one reload
    chatBox("  \n ");
    fire("astro:hydration-error");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("doesn't reload when it can't remember that it did (no session storage), which could loop", () => {
    const { reload, fire } = setup({ storage: false });
    fire("astro:hydration-error");
    expect(reload).not.toHaveBeenCalled();
  });
});
