import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { catalogueSchema } from "../catalogue.ts";
import { chatEventSchema, chatEventData } from "../chat-events.ts";
import { chatPageSchema, pageContextSchema } from "../page-context.ts";
import { ingredientProblems, ingredientSchema, recipeFrontmatterSchema } from "../recipe.ts";
import { shoppingListSchema } from "../shopping-list.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

describe("the repo's data files match their schemas", () => {
  const catalogue = catalogueSchema.parse(readJson("data/ingredients.json"));

  it("every recipe's frontmatter, with every ingredient item in the catalogue", () => {
    const dir = path.join(ROOT, "recipes");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const { data } = matter(fs.readFileSync(path.join(dir, f), "utf8"));
      const parsed = recipeFrontmatterSchema.safeParse(data);
      expect(parsed.success, `${f}: ${parsed.error?.message}`).toBe(true);
      for (const ing of parsed.data?.ingredients ?? []) expect(catalogue[ing.item], `${f}: ${ing.item}`).toBeDefined();
    }
  });

  it("shopping-list.json", () => {
    const parsed = shoppingListSchema.safeParse(readJson("shopping-list.json"));
    expect(parsed.success, parsed.error?.message).toBe(true);
  });
});

describe("recipe frontmatter", () => {
  const base = { title: "T", slug: "t", image: "/images/recipes/t.jpg", total_mins: 10, serves: 2, calories: 100, ingredients: [] };
  it("needs the required fields and an ingredients list", () => {
    expect(recipeFrontmatterSchema.safeParse(base).success).toBe(true);
    for (const key of ["title", "slug", "image", "total_mins", "serves", "calories", "ingredients"]) {
      const { [key]: _gone, ...rest } = base as Record<string, unknown>;
      expect(recipeFrontmatterSchema.safeParse(rest).success, key).toBe(false);
    }
  });
  it("refuses an unknown course, a section split in two, and an ingredient with no item", () => {
    expect(recipeFrontmatterSchema.safeParse({ ...base, course: ["Brunch"] }).success).toBe(false);
    const a = { amount: 1, name: "a", item: "a", section: "Sauce" };
    const split = recipeFrontmatterSchema.safeParse({ ...base, ingredients: [a, { amount: 1, name: "b", item: "b", section: "Dough" }, a] });
    expect(split.error?.issues.map((i) => i.message)).toEqual(['the "Sauce" lines must sit together; move it next to the others']);
    expect(recipeFrontmatterSchema.safeParse({ ...base, ingredients: [{ amount: 1, name: "a" }] }).success).toBe(false);
  });
});

describe("ingredient problems are the messages a write is refused with", () => {
  it("accepts a good line, a to-taste line and a pinch", () => {
    for (const ing of [{ amount: 200, unit: "g", name: "rice" }, { name: "salt", note: "to taste" }, { unit: "pinch", name: "salt", note: "to taste" }, { amount: [2, 3], unit: "tbsp", name: "paste" }]) {
      expect(ingredientProblems(ing, 0), JSON.stringify(ing)).toEqual([]);
      expect(ingredientSchema.safeParse(ing).success).toBe(true);
    }
  });
  it("says what is wrong and names the line", () => {
    expect(ingredientProblems({ amount: 2, unit: "oz", name: "milk" }, 2)).toEqual(["ingredients[2] (milk): unit \"oz\" isn't one of g, kg, ml, l, tsp, tbsp, cup, clove, can, slice, bunch, sprig, piece, sheet, stick, head, pinch, handful, juice, zest (none = a count). Convert it, e.g. oz -> g"]);
    expect(ingredientProblems({ amount: [3, 2], unit: "g", name: "capers" }, 4)).toEqual(["ingredients[4] (capers): a range is [min, max], both positive, min below max"]);
    expect(ingredientProblems({ amount: 0, name: "x" }, 0)).toEqual(["ingredients[0] (x): amount must be a positive number (decimals, e.g. 0.75), or a range [min, max]"]);
    expect(ingredientProblems({ name: "pepper" }, 1)).toEqual(['ingredients[1] (pepper): every ingredient needs an amount, or a note saying "to taste" / "to serve"']);
    expect(ingredientProblems({ unit: "g", name: "x", note: "to serve" }, 1)).toEqual(["ingredients[1] (x): a unit needs an amount"]);
    expect(ingredientProblems({ amount: 1, name: "**x**", note: "**y**" }, 0)).toEqual(["ingredients[0] (**x**): name must be plain text, the page adds the bold", "ingredients[0] (**x**): note must not contain bold"]);
    expect(ingredientProblems({ amount: 1, name: "  " }, 0)).toEqual(["ingredients[0] (  ): name is empty"]);
    expect(ingredientProblems({ amount: 1, name: "x", item: "Not An Id" }, 0)).toEqual(['ingredients[0] (x): item "Not An Id" isn\'t a catalogue id (kebab-case)']);
    expect(ingredientProblems("salt", 3)).toEqual(["ingredients[3]: must be an object"]);
  });
  it("lists every problem of a line at once, in the order the fields are checked", () => {
    const out = ingredientProblems({ amount: [3, 2], unit: "oz", name: "", note: "**x**", optional: "yes" }, 0);
    expect(out.map((m) => m.split(": ")[1].split(" ")[0])).toEqual(["name", "note", "unit", "a", "optional"]);
  });
});

describe("the page context", () => {
  // What the layout embeds (src/components/components.test.ts renders the layout and reads it back through this schema).
  it("is the page, and for a recipe its slug and title", () => {
    for (const ctx of [{ page: "index" }, { page: "next-week" }, { page: "shopping" }, { page: "recipe", slug: "pancakes", title: "Pancakes <b>&</b>" }]) {
      expect(pageContextSchema.parse(ctx)).toEqual(ctx);
    }
    expect(pageContextSchema.safeParse({ page: "recipe", slug: "pancakes" }).success).toBe(false);
    expect(pageContextSchema.safeParse({}).success).toBe(false);
  });
  it("and the chat's page adds what the visitor did on it", () => {
    for (const page of [{ page: "recipe", slug: "pancakes", servings: 4 }, { page: "index", search: "soup", filter: "Dinner" }, { page: "shopping" }, { page: "recipe", dismissed: true }]) {
      expect(chatPageSchema.safeParse(page).success, JSON.stringify(page)).toBe(true);
    }
    expect(chatPageSchema.safeParse({ page: "index", filter: "Brunch" }).success).toBe(false);
  });
});

describe("the /chat events", () => {
  const samples: Record<keyof typeof chatEventData, object> = {
    meta: { conversation_id: "c", turn_id: "t" },
    text: { delta: "Hi" },
    status: { text: "Looking…" },
    suggestions: { replies: ["Yes", { label: "Open", url: "https://x/y" }, { label: "Save to site", action: "apply_plan" }] },
    question: { question: "Which?", options: ["a", "b"], multi: false },
    review: { drafts: [{ slug: "a", title: "A", image: "", url: "u", meta: "10 min", also_next: false, answer: "liked" }] },
    optional: { items: [{ item: "lime", name: "Limes", quantity: "2", recipes: [{ slug: "a", title: "A", image: "" }] }] },
    tray: { added: ["1"], label: "A" },
    cards: { cards: [{ slug: "a", title: "A", image: "", kicker: { kind: "this", label: "This week" }, meta: "10 min", url: "u" }] },
    navigation: { label: "Open A", url: "u" },
    title: { conversation_id: "c", title: "T" },
    photos: { numbers: [1, 2] },
    done: { suggestions: true },
    error: { message: "No" },
  };
  it("each event's data, and the union the server emits", () => {
    for (const [name, data] of Object.entries(samples)) {
      expect(chatEventData[name as keyof typeof chatEventData].safeParse(data).success, name).toBe(true);
      expect(chatEventSchema.safeParse({ type: name, ...data }).success, name).toBe(true);
    }
    expect(chatEventSchema.safeParse({ type: "text" }).success).toBe(false);
    expect(chatEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });
});
