const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { marked } = require("marked");
const { renderIndex } = require("./templates/index");
const { renderRecipe } = require("./templates/recipe");
const { renderShoppingList } = require("./templates/shopping-list");
const { renderNextWeek } = require("./templates/next-week");
const { byStatusThenTitle, isNextWeek } = require("./templates/status");

const ROOT = __dirname;
const RECIPES_DIR = path.join(ROOT, "recipes");
const IMAGES_DIR = path.join(ROOT, "images");
const STYLES_FILE = path.join(ROOT, "styles", "style.css");
const SEARCH_SCRIPT_FILE = path.join(ROOT, "templates", "search.js");
const SERVINGS_SCRIPT_FILE = path.join(ROOT, "templates", "servings.js");
const WAKELOCK_SCRIPT_FILE = path.join(ROOT, "templates", "wakelock.js");
const SHOPPING_SCRIPT_FILE = path.join(ROOT, "templates", "shopping.js");
const AUTH_SCRIPT_FILE = path.join(ROOT, "templates", "auth.js");
const CHAT_SCRIPT_FILE = path.join(ROOT, "templates", "chat.js");
const SHOPPING_LIST_FILE = path.join(ROOT, "shopping-list.json");
// BUILD_OUT_DIR lets tests and one-off builds write somewhere else, so a running dev site in dist/ is left alone.
const DIST_DIR = process.env.BUILD_OUT_DIR ? path.resolve(process.env.BUILD_OUT_DIR) : path.join(ROOT, "dist");

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function loadRecipes() {
  const files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".md"));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(RECIPES_DIR, file), "utf8");
    const { data, content } = matter(raw);
    if (!data.title || !data.slug || !data.image || !data.total_mins || !data.serves || !data.calories) {
      throw new Error(`Recipe ${file} is missing required frontmatter (title, slug, image, total_mins, serves, calories)`);
    }
    return { ...data, body: content };
  });
}

/**
 * The shopping list is written by the agent (via the MCP server's
 * update_shopping_list tool) for next week's recipes, and shown as-is until the
 * agent writes a new one: switching weeks doesn't touch it, so after the switch
 * it still shows the list made for what is now this week. It is blank only when
 * there is no list. The recipes it links to are the ones it was built from that
 * still exist.
 */
function loadShoppingList(allRecipes) {
  if (!fs.existsSync(SHOPPING_LIST_FILE)) return null;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(SHOPPING_LIST_FILE, "utf8"));
  } catch (err) {
    console.warn(`Ignoring shopping-list.json: ${err.message}`);
    return null;
  }
  const sections = (Array.isArray(list.sections) ? list.sections : []).filter(
    (s) => s && s.name && Array.isArray(s.items) && s.items.length
  );
  if (!sections.length) return null;
  const covered = new Set(Array.isArray(list.recipes) ? list.recipes : []);
  return { list: { ...list, sections }, recipes: allRecipes.filter((r) => covered.has(r.slug)) };
}

/**
 * The shopping page's stocktake editor: Supabase Auth (magic-link sign-in) plus the MCP server's
 * /stocktake endpoint. All three are public values, passed in by the deploy workflow from the
 * repo's Actions variables; without them the page is read-only (ticks stay local to the browser).
 */
function stocktakeAuth() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, STOCKTAKE_API_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !STOCKTAKE_API_URL) return null;
  return { supabaseUrl: SUPABASE_URL.replace(/\/$/, ""), supabaseKey: SUPABASE_ANON_KEY, api: STOCKTAKE_API_URL };
}

function build() {
  rimraf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, "recipes"), { recursive: true });

  fs.copyFileSync(STYLES_FILE, path.join(DIST_DIR, "style.css"));
  fs.copyFileSync(SEARCH_SCRIPT_FILE, path.join(DIST_DIR, "search.js"));
  fs.copyFileSync(SERVINGS_SCRIPT_FILE, path.join(DIST_DIR, "servings.js"));
  fs.copyFileSync(WAKELOCK_SCRIPT_FILE, path.join(DIST_DIR, "wakelock.js"));
  fs.copyFileSync(SHOPPING_SCRIPT_FILE, path.join(DIST_DIR, "shopping.js"));
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) fs.copyFileSync(AUTH_SCRIPT_FILE, path.join(DIST_DIR, "auth.js"));
  if (process.env.CHAT_API_URL) fs.copyFileSync(CHAT_SCRIPT_FILE, path.join(DIST_DIR, "chat.js"));
  if (fs.existsSync(IMAGES_DIR)) {
    copyDir(IMAGES_DIR, path.join(DIST_DIR, "images"));
  }

  // This week first (drafts first), then the rest; alphabetical within each group.
  const recipes = loadRecipes().sort(byStatusThenTitle);

  fs.writeFileSync(path.join(DIST_DIR, "index.html"), renderIndex(recipes));
  const nextWeek = recipes.filter(isNextWeek).sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(path.join(DIST_DIR, "next-week.html"), renderNextWeek(nextWeek));

  for (const recipe of recipes) {
    const bodyHtml = marked.parse(recipe.body);
    const html = renderRecipe(recipe, bodyHtml);
    fs.writeFileSync(path.join(DIST_DIR, "recipes", `${recipe.slug}.html`), html);
  }

  const shopping = loadShoppingList(recipes);
  fs.writeFileSync(path.join(DIST_DIR, "shopping-list.html"), renderShoppingList(shopping?.list ?? null, shopping?.recipes ?? [], stocktakeAuth()));

  console.log(`Built ${recipes.length} recipe(s) into dist/`);
}

build();
