// The static parts of the shopping page: what's left to buy at the planned servings, what's at home, and the data the page's script
// (templates/shopping.js) re-renders from. The script has its own copy of some of this until it becomes an island (migration step 7).
import crypto from "node:crypto";
import { BASE_SERVINGS, DEFAULT_SERVINGS, neededAmount, parseQuantity, type Plan, type ShoppingItem, type ShoppingList } from "../../shared/shopping-list.ts";
import type { RecipeFrontmatter } from "../../shared/recipe.ts";

type ListedRecipe = Pick<RecipeFrontmatter, "slug" | "title" | "image">;

/** "18 Oct 2026", or "" for a date that isn't one. */
export function formatDate(iso: unknown): string {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "2.5kg", "3", "2 heads": an amount and its unit written the way the list does (metric units attach to the number). */
export const fmtAmount = (amount: number, unit: string): string => `${Math.round(amount * 100) / 100}${!unit ? "" : /^(g|kg|ml|l)$/i.test(unit) ? unit : ` ${unit}`}`;

/** slug -> planned servings for every recipe the list covers. */
export function planOf(list: ShoppingList): Plan {
  const plan: Plan = {};
  for (const slug of [...(Array.isArray(list.recipes) ? list.recipes : [])].sort()) {
    const n = list.servings?.[slug];
    plan[slug] = Number.isInteger(n) && (n as number) > 0 ? (n as number) : DEFAULT_SERVINGS;
  }
  return plan;
}

/** The quantity text at the planned servings. */
export function needText(item: ShoppingItem, plan: Plan): string {
  const need = neededAmount(item, plan);
  const q = parseQuantity(item.quantity);
  return need === null || !q || Math.abs(need - q.amount) < 1e-9 ? item.quantity || "" : fmtAmount(need, q.unit);
}

/** What's left to buy of an item at the planned servings: `left` is the quantity text. */
export function remaining(item: ShoppingItem, plan: Plan): { status: "buy" | "partial" | "home"; left: string } {
  const need = neededAmount(item, plan);
  if (item.have === true) return { status: "home", left: "" };
  if (typeof item.have !== "number" || need === null) return { status: "buy", left: needText(item, plan) };
  const left = need - item.have;
  return left > 1e-9 ? { status: "partial", left: fmtAmount(left, parseQuantity(item.quantity)?.unit ?? "") } : { status: "home", left: "" };
}

/** The list split the way the page shows it: aisles with what's left to buy, and the items already at home. Aisles with nothing left are dropped. */
export function splitList(list: ShoppingList, plan: Plan) {
  const home: ShoppingItem[] = [];
  const sections: { name: string; items: { item: ShoppingItem; status: "buy" | "partial"; left: string }[] }[] = [];
  let partly = 0;
  for (const s of list.sections) {
    const items: { item: ShoppingItem; status: "buy" | "partial"; left: string }[] = [];
    for (const item of s.items) {
      const r = remaining(item, plan);
      if (r.status === "home") home.push(item);
      else {
        if (r.status === "partial") partly++;
        items.push({ item, status: r.status, left: r.left });
      }
    }
    if (items.length) sections.push({ name: s.name, items });
  }
  return { sections, home, partly };
}

/** A row shows at most this many recipe photos, then "+n". */
export const ROW_PHOTOS = 3;

/** The data for shopping.js: the list (with parsed amounts), the planned servings per recipe, the recipes its items are for (title, photo, page; `imageUrl` says where the photo is, by default the published original) and, when configured, how the editor signs in and saves. */
export function shoppingData(list: ShoppingList, recipes: readonly ListedRecipe[], auth: { supabaseUrl: string; supabaseKey: string; api: string } | null, plan: Plan, imageUrl: (recipe: ListedRecipe) => string = (r) => r.image.replace(/^\//, "")) {
  const sections = list.sections.map((s) => ({
    name: s.name,
    items: s.items.map((item) => {
      const q = parseQuantity(item.quantity);
      return { ...item, ...(q ? { amount: q.amount, unit: q.unit } : {}) };
    }),
  }));
  // Identifies this list (not its stocktake), so local ticks and unsaved edits never carry over to a new one.
  const version = crypto
    .createHash("sha256")
    .update(JSON.stringify(list.sections.map((s) => s.items.map((i) => [i.name, i.quantity || ""]))))
    .digest("hex")
    .slice(0, 12);
  const byslug: Record<string, { title: string; image: string; href: string }> = {};
  for (const r of recipes) byslug[r.slug] = { title: r.title, image: imageUrl(r), href: `recipes/${r.slug}.html` };
  return { base: BASE_SERVINGS, fallback: DEFAULT_SERVINGS, plan, version, stocktake: list.stocktake || null, sections, recipes: byslug, auth };
}
