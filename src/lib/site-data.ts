// What the pages need from the repo's data files: the recipes (from the collection, checked by its schema) and the shopping list.
import fs from "node:fs";
import path from "node:path";
import { getCollection, type CollectionEntry } from "astro:content";
import type { RecipeFrontmatter } from "../../shared/recipe.ts";
import { loadShoppingList, type ShoppingList } from "../../shared/shopping-list.ts";
import { byStatusThenTitle } from "./status.ts";

const ROOT = process.cwd();
const SHOPPING_LIST_FILE = path.join(ROOT, "shopping-list.json");

/** A recipe as the pages read it: its frontmatter (validated by the recipes collection, src/content.config.ts) plus `body` (the Markdown), `file` and the collection `entry` (what Astro renders the Markdown from). */
export type Recipe = RecipeFrontmatter & { body: string; file: string; entry: CollectionEntry<"recipes"> };

let cached: Recipe[] | undefined;

/**
 * All recipes, this week first (drafts first), then the rest; alphabetical within each group. Their frontmatter was checked by the
 * collection's schema and the catalogue when it loaded (a recipe that breaks either fails the build); the body is checked here: the
 * ingredients live in the frontmatter, so no "## Ingredients" section may be left in it.
 */
export async function getRecipes(): Promise<Recipe[]> {
  if (!cached) {
    const entries = await getCollection("recipes");
    const errors: string[] = [];
    const recipes = entries.map((entry) => {
      const file = path.basename(entry.filePath ?? `${entry.id}.md`);
      const body = entry.body ?? "";
      if (/^##\s+Ingredients\b/im.test(body)) errors.push(`${file}: the ingredients live in the frontmatter now; remove the "## Ingredients" section`);
      return { ...entry.data, body, file, entry } as Recipe;
    });
    if (errors.length) throw new Error(`Recipe bodies don't check out:\n- ${errors.join("\n- ")}`);
    cached = recipes.sort(byStatusThenTitle);
  }
  return cached;
}

/**
 * The shopping list is written by the agent (via the MCP server's update_shopping_list tool) for next week's recipes, and shown as-is
 * until the agent writes a new one: switching weeks doesn't touch it, so after the switch it still shows the list made for what is now
 * this week. It is blank only when there is no list. The recipes it links to are the ones it was built from that still exist.
 */
export function getShoppingList(allRecipes: Recipe[]): { list: ShoppingList; recipes: Recipe[] } | null {
  if (!fs.existsSync(SHOPPING_LIST_FILE)) return null;
  const list = loadShoppingList(fs.readFileSync(SHOPPING_LIST_FILE, "utf8"), (message) => console.warn(message));
  if (!list) return null;
  const covered = new Set(Array.isArray(list.recipes) ? list.recipes : []);
  return { list, recipes: allRecipes.filter((r) => covered.has(r.slug)) };
}
