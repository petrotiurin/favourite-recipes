// The shopping island in a fake DOM (happy-dom): as the build writes it (rendered to a string) and as the browser takes it over, acting as a
// shopper and as the signed-in editor. fetch is mocked: only /stocktake and Supabase Auth are ever called.
import { act } from "preact/test-utils";
import { hydrate, render } from "preact";
import { renderToString } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_KEY, auth, type Session } from "../lib/auth.ts";
import { keysFor, type ShoppingProps } from "../lib/shopping-state.ts";
import Shopping from "./Shopping.tsx";

const API = "https://api.test/stocktake";
const props = (over: Partial<ShoppingProps> = {}): ShoppingProps => ({
  plan: { a: 4, b: 2 },
  version: "v1",
  stocktake: null,
  sections: [
    { name: "Veg", items: [{ name: "Garlic", quantity: "4", recipes: ["a"] }, { name: "Spinach", quantity: "200g", note: "baby", recipes: ["a"], have: 100 }] },
    { name: "Pantry", items: [{ name: "Rice", quantity: "400g", recipes: ["a", "b"], amounts: { a: 200, b: 200 } }, { name: "Oil", quantity: "1", have: true }] },
  ],
  recipes: { a: { title: "Alpha", image: "a.webp", href: "recipes/a.html" }, b: { title: "Beta", image: "b.webp", href: "recipes/b.html" } },
  stocktakeApi: null,
  ...over,
});
const keys = keysFor("v1");
const session = (): Session => ({ access_token: "tok", refresh_token: "r", expires_at: 4_000_000_000, email: "ed@example.com" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise((r) => setTimeout(r, 0));

let root: HTMLElement;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById("root")!;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  auth.dispose();
});
afterEach(() => {
  act(() => render(null, root));
  auth.dispose();
  vi.unstubAllGlobals();
});

const mount = (p: ShoppingProps = props()) => act(() => render(<Shopping {...p} />, root));
const signIn = () => {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session()));
  auth.init({ supabaseUrl: "https://p.test", supabaseKey: "k" });
};
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const q = (sel: string) => root.querySelector(sel);
const qa = (sel: string) => [...root.querySelectorAll(sel)];
const text = (sel: string) => qa(sel).map((e) => e.textContent);
const rowNames = () => text(".shop-row .shop-name");
const qtys = () => text(".shop-row .shop-qty");
const pressed = () => qa(".seg button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-serves"));
const fold = (section: Element, open: boolean) =>
  act(() => {
    (section as HTMLDetailsElement).open = open;
    section.dispatchEvent(new Event("toggle"));
  });

describe("as the build writes it", () => {
  it("is the list at the planned servings with what's at home taken off, in the page's own markup", () => {
    const html = renderToString(<Shopping {...props()} />);
    root.innerHTML = html;
    expect(rowNames()).toEqual(["Garlic", "Spinachbaby", "Rice"]);
    expect(qtys()).toEqual(["8", "300g", "600g"]);
    expect(text(".shop-section h2")).toEqual(["Veg", "Pantry"]);
    expect(text(".section-count")).toEqual(["2", "1"]);
    expect(text(".shop-home summary")).toEqual(["Already at home (1)"]);
    expect(text(".shop-home li")).toEqual(["Oil1½"]); // no recipe of its own: the average of the plan, 3 people
    expect(root.querySelector("#shopping-app")).not.toBeNull();
    expect(qa("details.shop-section").every((d) => d.hasAttribute("open"))).toBe(true);
    expect(q(".tabs")).toBeNull(); // nobody is signed in until the browser has been asked
    expect(q('[data-act="update"]')).toBeNull(); // a read-only build
    // Same as the browser's first draw, so taking the page over changes nothing.
    const before = root.innerHTML;
    act(() => hydrate(<Shopping {...props()} />, root));
    expect(root.innerHTML).toBe(before);
  });

  it("says everything is at home when it is, and shows the saved stocktake's date", () => {
    const p = props({ sections: [{ name: "Veg", items: [{ name: "Garlic", quantity: "4", have: true }] }], stocktake: "2026-11-21T10:00:00Z" });
    root.innerHTML = renderToString(<Shopping {...p} />);
    expect(q(".shopping-empty")!.textContent).toBe("Everything on the list is already at home.");
    expect(q(".home-card strong")!.textContent).toBe("Home checked 21 Nov");
    expect(q(".home-card-text span")!.textContent).toBe("1 at home, 0 partly. Already taken off.");
  });
});

describe("as a shopper", () => {
  it("takes over the page the build wrote and shows the same list", () => {
    root.innerHTML = renderToString(<Shopping {...props()} />);
    const written = qa("li.shop-row")[0];
    localStorage.setItem(keys.ticks, '["0-0"]');
    act(() => hydrate(<Shopping {...props()} />, root));
    expect(qa("li.shop-row")[0]).toBe(written); // the same elements, now alive
    expect((q("#tick-0-0") as HTMLInputElement).checked).toBe(true); // and what this browser kept is on them before it is painted
    expect(qtys()).toEqual(["8", "300g", "600g"]);
  });

  it("shows partly-at-home items by what's left, with the house half full and the amounts for screen readers", () => {
    mount();
    const spinach = qa(".shop-row")[1];
    expect(spinach.querySelector(".shop-qty")!.textContent).toBe("300g");
    expect(spinach.querySelector("svg.icon-some")).not.toBeNull();
    expect(spinach.querySelector(".sr-only")!.textContent).toBe("(have 100g of 400g at home)");
  });

  it("ticks items and keeps the ticks for this list; Start again clears them", () => {
    mount();
    expect(q('[data-act="clear-ticks"]')).toBeNull();
    click(q("#tick-0-0"));
    expect((q("#tick-0-0") as HTMLInputElement).checked).toBe(true);
    expect(localStorage.getItem(keys.ticks)).toBe('["0-0"]');
    click(qa(".shop-qty")[2]); // the quantity is a label for the same checkbox
    expect(localStorage.getItem(keys.ticks)).toBe('["0-0","1-0"]');
    // The next visit has them.
    act(() => void render(null, root));
    mount();
    expect((q("#tick-0-0") as HTMLInputElement).checked).toBe(true);
    expect((q("#tick-0-1") as HTMLInputElement).checked).toBe(false);
    click(q("#tick-0-0"));
    expect(localStorage.getItem(keys.ticks)).toBe('["1-0"]');
    click(q('[data-act="clear-ticks"]'));
    expect(localStorage.getItem(keys.ticks)).toBeNull();
    expect(qa(".tick").some((t) => (t as HTMLInputElement).checked)).toBe(false);
  });

  it("folds an aisle and remembers it, and keeps the 'Already at home' fold as it was while the list changes", () => {
    mount();
    const veg = q('details[data-section="Veg"]')!;
    fold(veg, false);
    expect(localStorage.getItem("shopping-collapsed")).toBe('["Veg"]');
    expect((q('details[data-section="Veg"]') as HTMLDetailsElement).open).toBe(false);
    expect((q('details[data-section="Pantry"]') as HTMLDetailsElement).open).toBe(true);
    fold(q(".shop-home")!, true);
    click(q("#tick-1-0"));
    expect((q(".shop-home") as HTMLDetailsElement).open).toBe(true);
    // Next visit: still folded.
    act(() => void render(null, root));
    mount();
    expect((q('details[data-section="Veg"]') as HTMLDetailsElement).open).toBe(false);
    fold(q('details[data-section="Veg"]')!, true);
    expect(localStorage.getItem("shopping-collapsed")).toBeNull();
  });

  it("names the recipes an item is for when its photos are tapped", () => {
    mount();
    const forBtn = qa(".row-for")[2];
    expect(forBtn.getAttribute("aria-label")).toBe("For Alpha, Beta");
    expect(forBtn.getAttribute("aria-expanded")).toBe("false");
    expect(forBtn.querySelectorAll("img").length).toBe(2);
    click(forBtn);
    expect(qa(".row-recipes a").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Alpha", "recipes/a.html"], ["Beta", "recipes/b.html"]]);
    click(qa(".row-for")[2]);
    expect(q(".row-recipes")).toBeNull();
  });

  it("shows a +n for more than three recipes", () => {
    const recipes = Object.fromEntries(["a", "b", "c", "d", "e"].map((s) => [s, { title: s, image: `${s}.webp`, href: `${s}.html` }]));
    mount(props({ recipes, plan: { a: 2, b: 2, c: 2, d: 2, e: 2 }, sections: [{ name: "Veg", items: [{ name: "Onion", quantity: "5", recipes: ["a", "b", "c", "d", "e"], amounts: { a: 1, b: 1, c: 1, d: 1, e: 1 } }] }] }));
    expect(qa(".row-for img").length).toBe(3);
    expect(q(".row-more")!.textContent).toBe("+2");
  });

  describe("servings", () => {
    it("opens on the plan, offers Plan when it isn't one number, and 1/2/4 sets every recipe", () => {
      mount();
      expect(text(".seg button")).toEqual(["Plan", "1", "2", "4"]);
      expect(pressed()).toEqual(["plan"]);
      expect(q(".per-recipe-summary")!.textContent).toBe(" · as planned");
      click(q('[data-serves="1"]'));
      expect(pressed()).toEqual(["1"]);
      expect(qtys()).toEqual(["2", "200g"]); // the spinach is now all at home (100g of 100g)
      expect(text(".shop-home summary")).toEqual(["Already at home (2)"]);
      expect(q(".per-recipe-summary")).toBeNull();
      click(q('[data-serves="plan"]'));
      expect(qtys()).toEqual(["8", "300g", "600g"]);
    });

    it("has no Plan button when the plan is one of 1/2/4 for everyone", () => {
      mount(props({ plan: { a: 2, b: 2 } }));
      expect(text(".seg button")).toEqual(["1", "2", "4"]);
      expect(pressed()).toEqual(["2"]);
    });

    it("changes single recipes under Per recipe, shows what's custom, and stops at 1 and 12", () => {
      mount();
      expect(q(".serves-list")).toBeNull();
      click(q(".per-recipe-toggle"));
      expect(q(".per-recipe-toggle")!.getAttribute("aria-expanded")).toBe("true");
      expect(text(".serves-name > span")).toEqual(["Alpha", "Beta"]);
      expect(text(".step-count")).toEqual(["4", "2"]);
      click(qa('[data-delta="1"]')[1]); // Beta to 3
      expect(text(".step-count")).toEqual(["4", "3"]);
      expect(text(".serves-name small")).toEqual(["custom"]);
      expect(q(".per-recipe-summary")!.textContent).toBe(" · your mix");
      expect(qtys()).toEqual(["8", "300g", "700g"]);
      expect(JSON.parse(localStorage.getItem(keys.plan)!)).toEqual({ plan: { a: 4, b: 2 }, servings: { a: 4, b: 3 } });
      click(qa('[data-delta="-1"]')[1]);
      expect(localStorage.getItem(keys.plan)).toBeNull(); // back on the plan: nothing kept
      for (let i = 0; i < 20; i++) click(qa('[data-delta="1"]')[0]);
      expect(text(".step-count")[0]).toBe("12");
      expect((qa('[data-delta="1"]')[0] as HTMLButtonElement).disabled).toBe(true);
      for (let i = 0; i < 20; i++) click(qa('[data-delta="-1"]')[0]);
      expect(text(".step-count")[0]).toBe("1");
      expect((qa('[data-delta="-1"]')[0] as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps the picks for the next visit, but not past a new plan", () => {
      mount();
      click(q('[data-serves="1"]'));
      act(() => void render(null, root));
      mount();
      expect(pressed()).toEqual(["1"]);
      expect(qtys()).toEqual(["2", "200g"]);
      act(() => void render(null, root));
      mount(props({ plan: { a: 4, b: 4 } }));
      expect(pressed()).toEqual(["4"]);
    });
  });

  describe("signed out, on a build that can save a stocktake", () => {
    it("offers Update, which opens the sign-in sheet with the page's words", () => {
      auth.init({ supabaseUrl: "https://p.test", supabaseKey: "k" });
      mount(props({ stocktakeApi: API }));
      expect(q(".home-card strong")!.textContent).toBe("Home not checked yet");
      expect(q(".home-card-text span")!.textContent).toBe("1 at home, 1 partly. Already taken off.");
      expect(q(".tabs")).toBeNull();
      click(q('[data-act="update"]'));
      expect(auth.sheet.value).toBe("email");
      expect(auth.copy.value).toEqual({ title: "Update what's at home", lede: "Sign in once and you can mark what you already have." });
    });

    it("has no Update and no 'not checked' card on a build without it", () => {
      mount();
      expect(q(".home-card")).toBeNull();
    });
  });
});

describe("as the signed-in editor", () => {
  beforeEach(signIn);
  const mountEditor = (over: Partial<ShoppingProps> = {}) => mount(props({ stocktakeApi: API, ...over }));
  const home = () => click(q('[data-tab="home"]'));
  const house = (n: number) => click(qa(".fill-house")[n]);

  it("has the two tabs with their counts, once the browser has been asked", () => {
    mountEditor();
    expect(qa(".tabs button").map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-selected")])).toEqual([["Shopping list, 3 to buy", "true"], ["At home, 1 items", "false"]]);
    expect(text(".tabs button span")).toEqual(["3", "1"]);
  });

  it("Update goes to the At home tab, where every item is a row with a house button", () => {
    mountEditor();
    click(q('[data-act="update"]'));
    expect(q('[data-tab="home"]')!.getAttribute("aria-selected")).toBe("true");
    expect(text(".fill-name")).toEqual(["Garlic", "Spinach", "Rice", "Oil"]);
    expect(qa(".fill-row").map((r) => r.getAttribute("data-level"))).toEqual(["none", "some", "none", "all"]);
    expect(text(".fill-amt")).toEqual(["8", "100 / 400g", "600g", "1½"]);
    expect(qa(".fill-range").map((r) => r.getAttribute("max"))).toEqual(["8", "400", "600", "1.5"]);
    expect(qa(".fill-range").map((r) => r.getAttribute("step"))).toEqual(["1", "50", "50", "0.5"]);
    expect(q(".save-bar .saved-state")!.textContent).toBe("Nothing saved yet");
  });

  it("tapping the house takes all of it off the list, and again puts it back; edits are kept until Save", () => {
    mountEditor();
    home();
    house(0);
    expect(qa(".fill-row")[0].getAttribute("data-level")).toBe("all");
    expect(qa(".fill-row")[0].classList.contains("is-changed")).toBe(true);
    expect(q(".save-count")!.textContent).toBe("1");
    expect(q('[data-act="save"]')!.getAttribute("aria-label")).toBe("Save 1 change");
    expect(q('[data-tab="home"]')!.getAttribute("aria-label")).toBe("At home, 2 items, unsaved changes");
    expect(JSON.parse(localStorage.getItem(keys.draft)!)).toEqual({ "0-0": true, "0-1": 100, "1-1": true });
    click(q('[data-tab="list"]'));
    expect(rowNames()).toEqual(["Spinachbaby", "Rice"]); // the editor sees their edits
    expect(q(".home-card-text span")!.textContent).toBe("2 at home, 1 partly. Already taken off. Not saved yet.");
    click(q('[data-tab="home"]'));
    house(0);
    expect(localStorage.getItem(keys.draft)).toBeNull(); // back to what's saved: nothing to keep
    expect(q(".save-bar .saved-state")).not.toBeNull();
  });

  it("undo drops the unsaved edits; the clear button empties every row", () => {
    mountEditor();
    home();
    house(2);
    click(q('[data-act="discard"]'));
    expect(localStorage.getItem(keys.draft)).toBeNull();
    expect(qa(".fill-row")[2].getAttribute("data-level")).toBe("none");
    click(q('[data-act="reset-home"]'));
    expect(qa(".fill-row").map((r) => r.getAttribute("data-level"))).toEqual(["none", "none", "none", "none"]);
    expect(q(".save-count")!.textContent).toBe("2"); // spinach and oil were at home
  });

  it("a slider (keyboard or screen reader) sets how much is at home; all of it is saved as 'have it all'", () => {
    mountEditor();
    home();
    const range = qa(".fill-range")[2] as HTMLInputElement;
    act(() => {
      range.value = "300";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(qa(".fill-row")[2].getAttribute("data-level")).toBe("some");
    expect(text(".fill-amt")[2]).toBe("300 / 600g");
    expect(qa(".fill-row")[2].getAttribute("style")).toContain("--fill: 50%");
    expect(JSON.parse(localStorage.getItem(keys.draft)!)["1-0"]).toBe(300);
    act(() => {
      range.value = "600";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem(keys.draft)!)["1-0"]).toBe(true);
    expect(qa(".fill-row")[2].getAttribute("data-level")).toBe("all");
  });

  it("slides across a row with the pointer, a tap on a half moves one step, a mostly vertical move is a scroll", () => {
    mountEditor();
    home();
    const row = qa(".fill-row")[2] as HTMLElement;
    row.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 40, right: 200, bottom: 40, x: 0, y: 0, toJSON() {} });
    const ev = (type: string, x: number, y = 20) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, pointerId: 1, button: 0 });
    const draft = () => JSON.parse(localStorage.getItem(keys.draft) ?? "{}")["1-0"];
    act(() => void row.dispatchEvent(ev("pointerdown", 20)));
    act(() => void row.dispatchEvent(ev("pointermove", 100)));
    expect(draft()).toBe(300); // halfway of 600g
    act(() => void row.dispatchEvent(ev("pointerup", 100)));
    // A tap on the right half adds a step (50g), on the left half takes one away.
    act(() => void row.dispatchEvent(ev("pointerdown", 150)));
    act(() => void row.dispatchEvent(ev("pointerup", 150)));
    expect(draft()).toBe(350);
    act(() => void row.dispatchEvent(ev("pointerdown", 20)));
    act(() => void row.dispatchEvent(ev("pointerup", 20)));
    expect(draft()).toBe(300);
    // Vertical: the page scrolls, nothing is set.
    act(() => void row.dispatchEvent(ev("pointerdown", 100)));
    act(() => void row.dispatchEvent(ev("pointermove", 105, 80)));
    act(() => void row.dispatchEvent(ev("pointerup", 105, 80)));
    expect(draft()).toBe(300);
    // To the end is all of it.
    act(() => void row.dispatchEvent(ev("pointerdown", 20)));
    act(() => void row.dispatchEvent(ev("pointermove", 199)));
    act(() => void row.dispatchEvent(ev("pointerup", 199)));
    expect(draft()).toBe(true);
  });

  describe("Save", () => {
    const edit = () => {
      home();
      house(0); // garlic at home
      click(qa(".fill-house")[3]); // oil no longer at home
    };
    const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body);

    it("sends the whole stocktake in one POST with the token, as /stocktake expects, then shows it saved", async () => {
      mountEditor();
      edit();
      fetchMock.mockResolvedValueOnce(json({ ok: true, stocktake: "2026-11-22T10:00:00.000Z" }));
      await act(async () => {
        click(q('[data-act="save"]'));
        await flush();
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(API);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json" });
      expect(bodyOf()).toEqual({
        items: [{ name: "Garlic", quantity: "4", have: true }, { name: "Spinach", quantity: "200g", have: 100 }, { name: "Rice", quantity: "400g" }, { name: "Oil", quantity: "1" }],
      });
      expect(q(".saved-state")!.textContent).toBe("Saved just now");
      expect(q('[data-act="save"]')).toBeNull();
      expect(localStorage.getItem(keys.draft)).toBeNull();
      expect(JSON.parse(localStorage.getItem(keys.pending)!)).toEqual({ saved: "2026-11-22T10:00:00.000Z", have: { "0-0": true, "0-1": 100 } });
      click(q('[data-tab="list"]'));
      expect(q(".home-card strong")!.textContent).toBe("Home checked 22 Nov");
      expect(rowNames()).toEqual(["Spinachbaby", "Rice", "Oil"]);
    });

    it("shows the saved stocktake on the next visit, before the site has redeployed", async () => {
      mountEditor();
      edit();
      fetchMock.mockResolvedValueOnce(json({ ok: true, stocktake: "2026-11-22T10:00:00.000Z" }));
      await act(async () => {
        click(q('[data-act="save"]'));
        await flush();
      });
      act(() => void render(null, root));
      mountEditor();
      expect(rowNames()).toEqual(["Spinachbaby", "Rice", "Oil"]);
      expect(q(".home-card strong")!.textContent).toBe("Home checked 22 Nov");
    });

    it("says the server's reason when it refuses (409: the list changed), and keeps the edits", async () => {
      mountEditor();
      edit();
      fetchMock.mockResolvedValueOnce(json({ error: "The list changed. Reload." }, 409));
      await act(async () => {
        click(q('[data-act="save"]'));
        await flush();
      });
      expect(q(".shopping-status.is-error")!.textContent).toBe("The list changed. Reload.");
      expect(q(".save-count")!.textContent).toBe("2");
      expect(localStorage.getItem(keys.pending)).toBeNull();
    });

    it("says it couldn't reach the server, and works again after", async () => {
      mountEditor();
      edit();
      fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      await act(async () => {
        click(q('[data-act="save"]'));
        await flush();
      });
      expect(q(".shopping-status.is-error")!.textContent).toBe("Couldn't reach the server. Check your connection and try again.");
      expect((q('[data-act="save"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it("on a 401 signs out and opens the sheet, keeping the edits", async () => {
      mountEditor();
      edit();
      fetchMock.mockResolvedValueOnce(json({ error: "Your sign-in is no good." }, 401));
      await act(async () => {
        click(q('[data-act="save"]'));
        await flush();
      });
      expect(auth.getSession()).toBeNull();
      expect(auth.sheet.value).toBe("email");
      expect(auth.message.value).toEqual({ text: "Your sign-in is no good.", error: true });
      expect(q(".tabs")).toBeNull(); // back to the plain list
      expect(localStorage.getItem(keys.draft)).not.toBeNull();
    });

    it("with no token (the sign-in expired and can't be renewed) opens the sheet and sends nothing", async () => {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session(), expires_at: 1 }));
      auth.dispose();
      auth.init({ supabaseUrl: "https://p.test", supabaseKey: "k" });
      mountEditor();
      edit();
      fetchMock.mockResolvedValueOnce(json({ error: "invalid" }, 400)); // the refresh
      await act(async () => {
        click(q('[data-act="save"]'));
        await flush();
      });
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://p.test/auth/v1/token?grant_type=refresh_token"]);
      expect(auth.message.value?.text).toBe("Your sign-in has expired. Sign in again to save; your changes are kept.");
    });
  });

  it("goes to the At home tab when the editor signs in, back to the list when they sign out, and shows messages from sign-in", () => {
    act(() => auth.dispose());
    localStorage.clear();
    auth.init({ supabaseUrl: "https://p.test", supabaseKey: "k" });
    mountEditor();
    expect(q(".tabs")).toBeNull();
    act(() => {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session()));
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_KEY })); // signed in on another tab
    });
    expect(q('[data-tab="home"]')!.getAttribute("aria-selected")).toBe("true");
    fetchMock.mockResolvedValue(json({}));
    act(() => auth.signOut());
    expect(q(".tabs")).toBeNull();
    expect(q(".fill-row")).toBeNull();
  });
});
