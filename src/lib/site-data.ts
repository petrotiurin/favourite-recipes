// What the pages need from the repo's data files, moved here unchanged from the old build.js (step 1 of
// docs/typescript-migration.md): the recipes, the check of their ingredients against the catalogue, the shopping list and the
// stocktake sign-in values. The renderers in templates/ still turn these into HTML.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { UNITS, sectionErrors } from "../../templates/ingredients.js";
import { byStatusThenTitle } from "../../templates/status.js";

const ROOT = process.cwd();
const RECIPES_DIR = path.join(ROOT, "recipes");
const SHOPPING_LIST_FILE = path.join(ROOT, "shopping-list.json");
const CATALOGUE_FILE = path.join(ROOT, "data", "ingredients.json");

/** A recipe as the renderers read it: its frontmatter plus `body` (the Markdown) and `file`. */
export type Recipe = Record<string, any> & { slug: string; title: string; body: string; file: string };

function loadRecipes(): Recipe[] {
  const files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".md"));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(RECIPES_DIR, file), "utf8");
    const { data, content } = matter(raw);
    if (!data.title || !data.slug || !data.image || !data.total_mins || !data.serves || !data.calories) {
      throw new Error(`Recipe ${file} is missing required frontmatter (title, slug, image, total_mins, serves, calories)`);
    }
    return { ...data, body: content, file } as Recipe;
  });
}

/**
 * Every recipe's ingredients are data (docs/structured-ingredients.md): check each one has a known unit and points at an item in the ingredient
 * catalogue (data/ingredients.json), so a recipe added by hand with a typo fails the build instead of making a wrong shopping list. The MCP
 * server checks the rest (names, conversions) when it writes a recipe.
 */
function checkIngredients(recipes: Recipe[]) {
  const catalogue = fs.existsSync(CATALOGUE_FILE) ? JSON.parse(fs.readFileSync(CATALOGUE_FILE, "utf8")) : {};
  const errors: string[] = [];
  for (const r of recipes) {
    if (r.ingredients === undefined) {
      errors.push(`${r.file}: no \`ingredients\` in the frontmatter (use \`ingredients: []\` when they aren't recorded yet)`);
      continue;
    }
    if (!Array.isArray(r.ingredients)) {
      errors.push(`${r.file}: \`ingredients\` must be a list`);
      continue;
    }
    if (/^##\s+Ingredients\b/im.test(r.body)) errors.push(`${r.file}: the ingredients live in the frontmatter now; remove the "## Ingredients" section`);
    r.ingredients.forEach((ing: any, i: number) => {
      const where = `${r.file}: ingredients[${i}]${ing && ing.name ? ` (${ing.name})` : ""}`;
      if (!ing || typeof ing !== "object" || !String(ing.name || "").trim()) errors.push(`${where}: needs a name`);
      else if (!ing.item) errors.push(`${where}: no \`item\` (the catalogue id it's bought as)`);
      else if (!catalogue[ing.item]) errors.push(`${where}: item "${ing.item}" isn't in data/ingredients.json`);
      if (ing && ing.unit !== undefined && !UNITS.includes(ing.unit)) errors.push(`${where}: unit "${ing.unit}" isn't one of ${UNITS.join(", ")}`);
    });
    for (const e of sectionErrors(r.ingredients)) errors.push(`${r.file}: ${e}`);
  }
  if (errors.length) throw new Error(`Recipe ingredients don't check out:\n- ${errors.join("\n- ")}`);
}

let cached: Recipe[] | undefined;

/** All recipes, checked, this week first (drafts first), then the rest; alphabetical within each group. */
export function getRecipes(): Recipe[] {
  if (!cached) {
    cached = loadRecipes().sort(byStatusThenTitle);
    checkIngredients(cached);
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
  let list;
  try {
    list = JSON.parse(fs.readFileSync(SHOPPING_LIST_FILE, "utf8"));
  } catch (err) {
    console.warn(`Ignoring shopping-list.json: ${(err as Error).message}`);
    return null;
  }
  const sections = (Array.isArray(list.sections) ? list.sections : []).filter(
    (s: any) => s && s.name && Array.isArray(s.items) && s.items.length,
  );
  if (!sections.length) return null;
  const covered = new Set(Array.isArray(list.recipes) ? list.recipes : []);
  return { list: { ...list, sections }, recipes: allRecipes.filter((r) => covered.has(r.slug)) };
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
