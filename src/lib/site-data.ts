// What the pages need from the repo's data files (from the old build.js, step 1 of docs/typescript-migration.md): the recipes (from the
// collection, checked by its schema), the shopping list and the stocktake sign-in values. The renderers in templates/ still turn these into HTML.
import fs from "node:fs";
import path from "node:path";
import { getCollection } from "astro:content";
import type { RecipeFrontmatter } from "../../shared/recipe.ts";
import { loadShoppingList } from "../../shared/shopping-list.ts";
import { byStatusThenTitle } from "../../templates/status.js";

const ROOT = process.cwd();
const SHOPPING_LIST_FILE = path.join(ROOT, "shopping-list.json");

/** A recipe as the renderers read it: its frontmatter (validated by the recipes collection, src/content.config.ts) plus `body` (the Markdown) and `file`. */
export type Recipe = RecipeFrontmatter & { body: string; file: string };

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
      return { ...entry.data, body, file } as Recipe;
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
export function getShoppingList(allRecipes: Recipe[]): { list: any; recipes: Recipe[] } | null {
  if (!fs.existsSync(SHOPPING_LIST_FILE)) return null;
  const list = loadShoppingList(fs.readFileSync(SHOPPING_LIST_FILE, "utf8"), (message) => console.warn(message));
  if (!list) return null;
  const covered = new Set(Array.isArray(list.recipes) ? list.recipes : []);
  return { list, recipes: allRecipes.filter((r) => covered.has(r.slug)) };
}

/**
 * The shopping page's stocktake editor: Supabase Auth (magic-link sign-in) plus the MCP server's /stocktake endpoint. All three are
 * public values, passed in by the deploy workflow from the repo's Actions variables; without them the page is read-only.
 */
export function stocktakeAuth() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, STOCKTAKE_API_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !STOCKTAKE_API_URL) return null;
  return { supabaseUrl: SUPABASE_URL.replace(/\/$/, ""), supabaseKey: SUPABASE_ANON_KEY, api: STOCKTAKE_API_URL };
}
