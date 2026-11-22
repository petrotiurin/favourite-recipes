// @vitest-environment node
// The static components through Astro's Container API: the HTML the build writes, which the browser scripts hook into. In the node environment: under happy-dom the .astro files compile for the browser and the container can't render them.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import IngredientList from "./IngredientList.astro";
import Layout from "./Layout.astro";
import { pageContextSchema } from "../../shared/page-context.ts";
import ShopItem from "./ShopItem.astro";
import Tile from "./Tile.astro";
import WeekHead from "./WeekHead.astro";

const render = async (component: Parameters<AstroContainer["renderToString"]>[0], options: Parameters<AstroContainer["renderToString"]>[1]) =>
  (await AstroContainer.create()).renderToString(component, options);
const dom = (html: string) => {
  const w = new Window();
  w.document.write(html);
  return w.document;
};

afterEach(() => vi.unstubAllEnvs());

describe("IngredientList", () => {
  const ingredients = [
    { amount: 200, unit: "g" as const, name: "jasmine rice", item: "jasmine-rice" },
    { amount: [2, 3] as [number, number], unit: "clove" as const, name: "garlic <b>", item: "garlic" },
    { name: "sesame seeds", note: "to serve", optional: true, item: "sesame-seeds" },
    { amount: 2, unit: "tbsp" as const, name: "soy sauce", section: "Sauce", item: "soy-sauce" },
  ];

  it("writes each number as a .qty with data-qty and the unit word as a .qty-unit, when scalable", async () => {
    const html = await render(IngredientList, { props: { ingredients, scalable: true } });
    expect(html).toContain('<li><span class="qty" data-qty="200">200</span>g <strong>jasmine rice</strong></li>');
    expect(html).toContain('<span class="qty" data-qty="2">2</span>–<span class="qty" data-qty="3">3</span> <span class="qty-unit" data-one="clove" data-many="cloves">cloves</span> <strong>garlic &lt;b&gt;</strong>');
    expect(html).toContain("<strong>sesame seeds</strong>, to serve, optional");
    expect(html).toContain('<h3 class="ingredient-section">Sauce</h3>');
    expect(dom(html).querySelectorAll(".qty").length).toBe(4);
  });

  it("is plain text without the hooks when not scalable", async () => {
    const html = await render(IngredientList, { props: { ingredients, scalable: false } });
    expect(html).not.toContain("data-qty");
    expect(html).toContain("<li>200g <strong>jasmine rice</strong></li>");
  });

  it("says when nothing is recorded", async () => {
    expect(await render(IngredientList, { props: { ingredients: [], scalable: true } })).toContain("<p>Ingredients not yet recorded.</p>");
  });
});

describe("Layout", () => {
  const page = (props: Record<string, unknown>) => render(Layout, { props: { title: "T", ...props }, slots: { default: "<main>hi</main>" } });

  it("embeds the page context as JSON that can't close the script element, and reads back as written", async () => {
    const pageContext = { page: "recipe", slug: "a-b", title: `</script><script>alert(1)</script> & "q" <!--` };
    const html = await page({ pageContext, rootPrefix: "../" });
    const doc = dom(html);
    const block = doc.getElementById("page-context")!;
    expect(block.getAttribute("type")).toBe("application/json");
    expect(pageContextSchema.parse(JSON.parse(block.textContent))).toEqual(pageContext);
    expect(html.match(/<script/g)?.length).toBe(2); // the page context and the reload guard
    expect(html).not.toMatch(/id="page-context">[^]*?[<>&][^]*?<\/script>/);
  });

  it("writes the reload guard first in the head, as a script that works on its own", async () => {
    const html = await page({ pageContext: { page: "index" } });
    const head = dom(html).head;
    const first = head.querySelector("script")!;
    expect(head.querySelector("title")!.compareDocumentPosition(first) & 2).toBeTruthy(); // before the title
    expect(first.getAttribute("type")).toBeNull();
    const listeners: Record<string, () => void> = {};
    const reload = vi.fn();
    const win = {
      document: { querySelector: () => null },
      location: { pathname: "/x.html", reload },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: (name: string, f: () => void) => (listeners[name] = f),
    };
    new Function("window", first.textContent!)(win);
    expect(Object.keys(listeners).sort()).toEqual(["astro:hydration-error", "vite:preloadError"]);
    listeners["astro:hydration-error"]();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("refuses a page with no page context", async () => {
    await expect(page({ pageContext: {} })).rejects.toThrow();
  });

  it("adds the sign-in and the chat only on builds that have their variables", async () => {
    const plain = await page({ pageContext: { page: "index" } });
    expect(plain).not.toMatch(/auth\.js|chat\.js/);
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co/");
    vi.stubEnv("SUPABASE_ANON_KEY", "key");
    vi.stubEnv("CHAT_API_URL", 'https://api.test/chat?a=1&b="2"');
    vi.stubEnv("CHAT_PUBLIC", "false");
    const doc = dom(await page({ pageContext: { page: "index" } }));
    const auth = doc.querySelector('script[src="auth.js"]')!;
    expect(auth.getAttribute("data-supabase-url")).toBe("https://x.supabase.co");
    expect(auth.getAttribute("data-supabase-key")).toBe("key");
    expect(auth.hasAttribute("defer")).toBe(true);
    const chat = doc.querySelector('script[src="chat.js"]')!;
    expect(chat.getAttribute("data-api")).toBe('https://api.test/chat?a=1&b="2"');
    expect(chat.getAttribute("data-public")).toBe("false");
  });
});

describe("Tile, WeekHead and ShopItem", () => {
  it("a recipe whose photo isn't in images/recipes/ fails the build", async () => {
    const recipe = { slug: "no-photo", title: "X", image: "/images/recipes/no-photo.jpg", total_mins: 1, calories: 1 };
    await expect(render(Tile, { props: { recipe, kicker: { label: "Dinner" } } })).rejects.toThrow(/no-photo: its photo \/images\/recipes\/no-photo\.jpg isn't in images\/recipes/);
  });

  it("a tile links to its recipe page with the photo, the kicker and the meta", async () => {
    const recipe = { slug: "avocado-toast", title: "Tom & Jerry's", image: "/images/recipes/avocado-toast.jpg", total_mins: 15, calories: 200 };
    const doc = dom(await render(Tile, { props: { recipe, kicker: { label: "Dinner", cls: "kicker-current" }, cls: "course-dinner is-current" } }));
    const a = doc.querySelector("a")!;
    expect(a.getAttribute("class")).toBe("tile course-dinner is-current");
    expect(a.getAttribute("href")).toBe("recipes/avocado-toast.html");
    // The photo is a sized WebP copy with a srcset, width and height set (so the page doesn't jump) and lazy loading, as the original was.
    const img = a.querySelector("img")!;
    expect(img.getAttribute("class")).toBe("tile-image");
    expect(img.getAttribute("src")).toMatch(/avocado-toast/); // a built site has /_astro/<name>.<hash>.webp; the test renderer serves /_image?...
    expect(img.getAttribute("src")).toMatch(/webp/);
    expect(img.getAttribute("srcset")!.split(",")).toHaveLength(3);
    expect(img.getAttribute("sizes")).toBeTruthy();
    expect(img.getAttribute("width")).toBe(img.getAttribute("height"));
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(a.querySelector("p")!.getAttribute("class")).toBe("kicker kicker-current");
    expect(a.querySelector("h2")!.textContent).toBe("Tom & Jerry's");
    expect(a.querySelector(".tile-meta")!.textContent).toBe("15 min · 200 kcal");
  });

  it("the week heading links to next week with its count, says it's not planned, or is left out", async () => {
    const heads = async (thisWeek: number, nextWeek: number) => dom(await render(WeekHead, { props: { thisWeek, nextWeek } }));
    const both = await heads(2, 3);
    expect(both.querySelector(".week-label")!.textContent).toBe("This week");
    expect(both.querySelector("a.week-link")!.getAttribute("href")).toBe("next-week.html");
    expect(both.querySelector("a.week-link")!.textContent).toBe("Next week · 3");
    const onlyThis = await heads(2, 0);
    expect(onlyThis.querySelector(".week-empty")!.textContent).toBe("Next week: not planned");
    const onlyNext = await heads(0, 1);
    expect(onlyNext.querySelector(".week-label")).toBeNull();
    expect((await heads(0, 0)).querySelector(".week-head")).toBeNull();
  });

  it("a shopping row for a partly-at-home item names what's at home and the recipes it's for", async () => {
    const photos = ["avocado-toast", "tuna-melt", "avocado-toast", "almond-croissant-oats"]; // real files in images/recipes/ (a missing one fails)
    const bySlug = new Map(["a", "b", "c", "d"].map((s, i) => [s, { title: s.toUpperCase(), image: `/images/recipes/${photos[i]}.jpg` }]));
    const item = { name: "Spinach", note: "baby", quantity: "200g", recipes: ["a", "b", "c", "d"], have: 100 };
    const doc = dom(await render(ShopItem, { props: { item, status: "partial", left: "100g", plan: { a: 2, b: 2, c: 2, d: 2 }, bySlug } }));
    expect(doc.querySelector(".shop-name")!.textContent).toBe("Spinachbaby");
    expect(doc.querySelectorAll(".row-bubbles img").length).toBe(3);
    expect(doc.querySelector(".row-more")!.textContent).toBe("+1");
    expect(doc.querySelector(".shop-qty")!.textContent).toBe("100g");
    expect(doc.body.textContent).toContain("(have 100g of 200g at home)");
    expect(doc.body.textContent).toContain("(for A, B, C, D)");
  });
});
