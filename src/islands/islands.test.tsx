// The islands in a fake DOM (happy-dom): the page's own markup (the ingredient lines, the tiles) is written into the document as the build writes it,
// the island is rendered next to it, and the tests act as a visitor would.
import { act } from "preact/test-utils";
import { hydrate, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingredientHtml, type Ingredient } from "../../shared/ingredient-line.ts";
import { formatQuantity } from "../../shared/quantity.ts";
import { cookLink } from "../lib/cook-prompt.ts";
import { servings } from "../lib/servings.ts";
import CookActions from "./CookActions.tsx";
import Search from "./Search.tsx";
import Servings from "./Servings.tsx";

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "";
  servings.value = null;
});
afterEach(() => {
  render(null, root);
  vi.unstubAllGlobals();
});

/** Page markup, then an island in its own container (as `<astro-island>` is next to the page's own elements). */
function mount(pageHtml: string, island: preact.VNode) {
  document.body.innerHTML = `${pageHtml}<div id="island"></div>`;
  root = document.getElementById("island")!;
  act(() => render(island, root));
}
const click = (el: Element) => act(() => (el as HTMLElement).click());
const amounts = () => [...document.querySelectorAll(".qty")].map((e) => e.textContent);
const units = () => [...document.querySelectorAll(".qty-unit")].map((e) => e.textContent);
const pressed = () => document.querySelector('.servings-picker [aria-pressed="true"]')!.getAttribute("data-serves");
const button = (n: number) => document.querySelector(`.servings-picker button[data-serves="${n}"]`)!;

const list = (ingredients: Ingredient[]) => `<ul>${ingredients.map((i) => `<li>${ingredientHtml(i, { scalable: true })}</li>`).join("")}</ul>`;

describe("Servings", () => {
  // A recipe written for 2.
  const lines: Ingredient[] = [
    { amount: 200, unit: "g", name: "rice" },
    { amount: 1, unit: "clove", name: "garlic" },
    { amount: [1, 2], unit: "tsp", name: "paprika" },
    { amount: 0.5, name: "lemon" },
    { amount: 1, name: "onion" },
    { amount: 3, unit: "tbsp", name: "oil" },
    { name: "salt", note: "to taste" },
  ];

  it("is written with the recipe's own number pressed, and opens at 4 once loaded, rescaling the amounts", () => {
    mount(list(lines), <Servings serves={2} />);
    expect(pressed()).toBe("4");
    expect(amounts()).toEqual(["400", "2", "2", "4", "1", "2", "6"]);
    expect(units()).toEqual(["cloves", "tsp", "tbsp"]);
  });

  it("offers 1, 2, 4 and the recipe's own number, once, in order", () => {
    mount("", <Servings serves={3} />);
    expect([...document.querySelectorAll(".servings-picker button")].map((b) => b.textContent)).toEqual(["1", "2", "3", "4"]);
    mount("", <Servings serves={4} />);
    expect([...document.querySelectorAll(".servings-picker button")].map((b) => b.textContent)).toEqual(["1", "2", "4"]);
  });

  it("rescales to 1 and back to the recipe's own number, which puts the page's own text back", () => {
    const page = list(lines);
    mount(page, <Servings serves={2} />);
    click(button(1));
    expect(pressed()).toBe("1");
    expect(amounts()).toEqual(["100", "½", "½", "1", "¼", "½", "1½"]);
    expect(units()).toEqual(["clove", "tsp", "tbsp"]);
    click(button(2));
    expect(amounts()).toEqual(["200", "1", "1", "2", "½", "1", "3"]);
    expect(amounts()).toEqual([...document.querySelectorAll(".qty")].map((e) => e.getAttribute("data-original")));
    expect(units()).toEqual(["clove", "tsp", "tbsp"]);
  });

  it("writes every amount the way formatQuantity does (the nearest ¼ ⅓ ½ ⅔ ¾, whole numbers from 10, ⅛ for a sliver)", () => {
    const sample = [0.05, 0.1, 0.3, 0.33, 0.7, 1.45, 2.9, 9.99, 10.4, 12.5, 37.5, 199.5];
    const page = `<ul>${sample.map((n) => `<li>${ingredientHtml({ amount: n, unit: "g", name: "x" }, { scalable: true })}</li>`).join("")}</ul>`;
    mount(page, <Servings serves={2} />);
    click(button(4));
    expect(amounts()).toEqual(sample.map((n) => formatQuantity(n * 2)));
    click(button(1));
    expect(amounts()).toEqual(sample.map((n) => formatQuantity(n / 2)));
    expect(amounts()).toContain("⅛");
  });

  it("makes the unit word follow the last number of its line, ranges included", () => {
    mount(list([{ amount: [1, 2], unit: "clove", name: "garlic" }, { amount: 2, unit: "slice", name: "bread" }]), <Servings serves={4} />);
    // 4 is the recipe's own number here, so nothing changes yet.
    expect(units()).toEqual(["cloves", "slices"]);
    click(button(1));
    expect(amounts()).toEqual(["¼", "½", "½"]);
    expect(units()).toEqual(["clove", "slice"]);
    click(button(2));
    expect(amounts()).toEqual(["½", "1", "1"]);
    expect(units()).toEqual(["clove", "slice"]);
  });

  it("shares the number picked through the store, and keeps the markup the chat reads", () => {
    mount(list(lines), <Servings serves={2} />);
    expect(servings.value).toBe(4);
    click(button(1));
    expect(servings.value).toBe(1);
    expect(document.querySelector(".servings-picker")!.getAttribute("data-base")).toBe("2");
    expect(document.querySelectorAll('.servings-picker [aria-pressed="true"]')).toHaveLength(1);
  });
});

describe("Search", () => {
  const tiles = ["Tuna Melt", "Chicken Salad", "Tuna Pasta Bake", "Banana Bread"]
    .map((t) => `<a class="tile"><p class="tile-title">${t}</p></a>`)
    .join("");
  const page = `<main><div class="tile-grid">${tiles}</div></main>`;
  const type = (value: string) => {
    const input = document.getElementById("recipe-search") as HTMLInputElement;
    input.value = value;
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const shown = () => [...document.querySelectorAll<HTMLElement>(".tile")].filter((t) => t.style.display !== "none").map((t) => t.textContent);
  const grid = () => document.querySelector(".tile-grid")!;

  it("is the same box the page had, with the id the chat reads", () => {
    mount(page, <Search />);
    const input = document.getElementById("recipe-search")!;
    expect(input.getAttribute("type")).toBe("search");
    expect(input.className).toBe("search-input");
    expect(input.closest("label")!.className).toBe("search");
    expect(input.closest("label")!.querySelector("svg.icon")).not.toBeNull();
  });

  it("shows only the tiles whose title has every word typed, in any case and order", () => {
    mount(page, <Search />);
    expect(shown()).toHaveLength(4);
    type("tuna");
    expect(shown()).toEqual(["Tuna Melt", "Tuna Pasta Bake"]);
    expect(grid().classList.contains("is-searching")).toBe(true);
    type("  PASTA   tuna ");
    expect(shown()).toEqual(["Tuna Pasta Bake"]);
    type("tuna salad");
    expect(shown()).toEqual([]);
    type("bre");
    expect(shown()).toEqual(["Banana Bread"]);
  });

  it("shows everything again when the box is emptied or holds only spaces", () => {
    mount(page, <Search />);
    type("tuna");
    type("   ");
    expect(shown()).toHaveLength(4);
    expect(grid().classList.contains("is-searching")).toBe(false);
    type("tuna");
    type("");
    expect(shown()).toHaveLength(4);
  });

  it("filters on what the box already holds when it loads (typed early, or put back by the browser)", () => {
    document.body.innerHTML = `${page}<div id="island"><label class="search"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="sr-only">Search recipes</span><input type="search" id="recipe-search" class="search-input" placeholder="Search recipes" autocomplete="off"></label></div>`;
    root = document.getElementById("island")!;
    // As the browser does with the page's own markup: the island takes it over, and the box keeps what was typed (or restored) before.
    (document.getElementById("recipe-search") as HTMLInputElement).value = "banana";
    act(() => hydrate(<Search />, root));
    expect(shown()).toEqual(["Banana Bread"]);
  });
});

describe("Keep screen on", () => {
  const recipe = { title: "Rice", slug: "rice", serves: 2, text: "Rice text", scalable: true, pageUrl: "https://example.test/rice.html" };
  const toggle = () => document.querySelector<HTMLButtonElement>("button.wakelock-toggle");
  const sentinel = () => {
    const listeners: Record<string, () => void> = {};
    return { release: vi.fn(() => Promise.resolve()), addEventListener: (n: string, f: () => void) => (listeners[n] = f), listeners };
  };
  const flush = () => act(async () => { await Promise.resolve(); });

  it("takes the screen lock when pressed and lets it go when pressed again", async () => {
    const s = sentinel();
    const request = vi.fn(() => Promise.resolve(s));
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount("", <CookActions {...recipe} />);
    expect(toggle()!.textContent).toBe("Keep screen on");
    expect(toggle()!.getAttribute("aria-pressed")).toBe("false");
    click(toggle()!);
    await flush();
    expect(request).toHaveBeenCalledWith("screen");
    expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
    expect(toggle()!.textContent).toBe("Screen stays on");
    click(toggle()!);
    expect(s.release).toHaveBeenCalledOnce();
    expect(toggle()!.getAttribute("aria-pressed")).toBe("false");
    expect(toggle()!.textContent).toBe("Keep screen on");
  });

  it("takes the lock back when the tab comes back after the browser dropped it, but not when it isn't wanted", async () => {
    const first = sentinel();
    const second = sentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.stubGlobal("navigator", { wakeLock: { request } });
    mount("", <CookActions {...recipe} />);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).not.toHaveBeenCalled();
    click(toggle()!);
    await flush();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(1); // still held
    first.listeners.release(); // the browser dropped it
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("goes back to off when the browser refuses the lock", async () => {
    vi.stubGlobal("navigator", { wakeLock: { request: vi.fn(() => Promise.reject(new Error("denied"))) } });
    mount("", <CookActions {...recipe} />);
    click(toggle()!);
    await flush();
    expect(toggle()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("has no button in a browser without the API, and the Cook with Claude link stays", () => {
    vi.stubGlobal("navigator", {});
    mount("", <CookActions {...recipe} />);
    expect(toggle()).toBeNull();
    expect(document.querySelector("a.cook-claude")).not.toBeNull();
  });
});

describe("Cook with Claude", () => {
  const recipe = { title: "Rice & Peas", slug: "rice-peas", serves: 2, text: "Ingredients\n\n- 200g rice\n\nInstructions\n\n1. Cook.", pageUrl: "https://example.test/recipes/rice-peas.html" };
  const link = () => document.querySelector<HTMLAnchorElement>("a.cook-claude")!;
  const prompt = () => new URL(link().href).searchParams.get("q")!;

  beforeEach(() => vi.stubGlobal("navigator", {}));

  it("is a plain link to a new Claude chat that opens elsewhere", () => {
    mount("", <CookActions {...recipe} scalable />);
    expect(link().href.startsWith("https://claude.ai/new?q=")).toBe(true);
    expect(link().target).toBe("_blank");
    expect(link().rel).toBe("noopener");
    expect(link().getAttribute("aria-label")).toBe("Cook with Claude (opens Claude)");
    expect(link().textContent).toBe("Cook with Claude");
    expect(link().querySelector("svg.icon")).not.toBeNull();
  });

  it("holds the whole recipe at the servings the picker has, and follows it", () => {
    document.body.innerHTML = "";
    const picker = document.createElement("div");
    document.body.append(picker);
    act(() => render(<Servings serves={2} />, picker));
    const bar = document.createElement("div");
    document.body.append(bar);
    act(() => render(<CookActions {...recipe} scalable />, bar));
    root = bar;
    // The picker opens at 4: the prompt asks for scaling from 2 to 4.
    expect(prompt()).toContain('We\'re cooking "Rice & Peas" for 4 people. The full recipe is below; work from it and scale every amount from 2 servings to 4.');
    expect(prompt()).toContain("take the amounts from the ingredient list, scaled to 4.");
    expect(link().getAttribute("href")).toBe(cookLink(recipe, 4, location.href.split("#")[0]));
    click(picker.querySelector('button[data-serves="1"]')!);
    expect(prompt()).toContain("for 1 person.");
    expect(prompt()).toContain("scale every amount from 2 servings to 1.");
    click(picker.querySelector('button[data-serves="2"]')!);
    expect(prompt()).toContain("(its amounts are already for 2).");
    expect(prompt()).not.toContain("scaled to");
    expect(prompt()).toContain("get_recipe (slug: rice-peas)");
    expect(prompt()).toContain("--- Recipe: Rice & Peas ---\nIngredients");
    render(null, picker);
  });

  it("uses the recipe's own number until the picker has loaded", () => {
    mount("", <CookActions {...recipe} scalable />);
    expect(prompt()).toContain("for 2 people");
    expect(prompt()).toContain("(its amounts are already for 2)");
  });

  it("asks how many are eating on a recipe with no picker, whatever the store holds", () => {
    servings.value = 4;
    mount("", <CookActions {...recipe} scalable={false} />);
    expect(prompt()).toContain('We\'re cooking "Rice & Peas". The full recipe is below; work from it. Ask me how many people I\'m cooking for first');
    expect(prompt()).not.toContain("scale every amount");
  });

  it("names the page it is on once loaded (the build's address until then)", () => {
    mount("", <CookActions {...recipe} scalable />);
    expect(prompt()).toContain(`Its page: ${location.href.split("#")[0]}`);
    expect(prompt()).not.toContain("example.test");
  });
});
