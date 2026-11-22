// The shopping page's build-time parts: the dates, the plan and the island's props (the list itself is drawn by src/islands/Shopping.tsx, which
// is also where what's left to buy at the planned servings is worked out: src/lib/shopping-state.ts).
import crypto from "node:crypto";
import { DEFAULT_SERVINGS, type Plan, type ShoppingList } from "../../shared/shopping-list.ts";
import type { ShoppingProps } from "./shopping-state.ts";
import type { RecipeFrontmatter } from "../../shared/recipe.ts";

type ListedRecipe = Pick<RecipeFrontmatter, "slug" | "title" | "image">;

/** "18 Oct 2026", or "" for a date that isn't one. */
export function formatDate(iso: unknown): string {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** slug -> planned servings for every recipe the list covers. */
export function planOf(list: ShoppingList): Plan {
  const plan: Plan = {};
  for (const slug of [...(Array.isArray(list.recipes) ? list.recipes : [])].sort()) {
    const n = list.servings?.[slug];
    plan[slug] = Number.isInteger(n) && (n as number) > 0 ? (n as number) : DEFAULT_SERVINGS;
  }
  return plan;
}

/**
 * The shopping island's props (src/islands/Shopping.tsx): the list, the planned servings per recipe, the recipes its items are for (title, photo, page;
 * `imageUrl` says where the photo is, by default the published original) and, when configured, where the editor saves a stocktake.
 */
export function shoppingProps(list: ShoppingList, recipes: readonly ListedRecipe[], stocktakeApi: string | null, plan: Plan, imageUrl: (recipe: ListedRecipe) => string = (r) => r.image.replace(/^\//, "")): ShoppingProps {
  // Identifies this list (not its stocktake), so local ticks and unsaved edits never carry over to a new one.
  const version = crypto
    .createHash("sha256")
    .update(JSON.stringify(list.sections.map((s) => s.items.map((i) => [i.name, i.quantity || ""]))))
    .digest("hex")
    .slice(0, 12);
  const byslug: ShoppingProps["recipes"] = {};
  for (const r of recipes) byslug[r.slug] = { title: r.title, image: imageUrl(r), href: `recipes/${r.slug}.html` };
  return { plan, version, stocktake: list.stocktake || null, sections: list.sections, recipes: byslug, stocktakeApi };
}
