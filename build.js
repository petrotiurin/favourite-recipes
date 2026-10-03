const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { marked } = require("marked");
const { renderIndex } = require("./templates/index");
const { renderRecipe } = require("./templates/recipe");
const { renderShoppingList } = require("./templates/shopping-list");

const ROOT = __dirname;
const RECIPES_DIR = path.join(ROOT, "recipes");
const IMAGES_DIR = path.join(ROOT, "images");
const STYLES_FILE = path.join(ROOT, "styles", "style.css");
const SEARCH_SCRIPT_FILE = path.join(ROOT, "templates", "search.js");
const SERVINGS_SCRIPT_FILE = path.join(ROOT, "templates", "servings.js");
const SHOPPING_LIST_FILE = path.join(ROOT, "shopping-list.json");
const DIST_DIR = path.join(ROOT, "dist");

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
 * update_shopping_list tool) and records which draft recipes it was built from.
 * It is only shown while that set still matches the current drafts: promoting,
 * removing or adding a draft makes it stale, so the page goes blank until the
 * agent refreshes it.
 */
function loadShoppingList(drafts) {
  if (!fs.existsSync(SHOPPING_LIST_FILE)) return null;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(SHOPPING_LIST_FILE, "utf8"));
  } catch (err) {
    console.warn(`Ignoring shopping-list.json: ${err.message}`);
    return null;
  }
  const covered = Array.isArray(list.recipes) ? [...list.recipes].sort() : [];
  const current = drafts.map((r) => r.slug).sort();
  const sections = (Array.isArray(list.sections) ? list.sections : []).filter(
    (s) => s && s.name && Array.isArray(s.items) && s.items.length
  );
  if (!sections.length || !current.length || covered.join("\n") !== current.join("\n")) return null;
  return { ...list, sections };
}

function build() {
  rimraf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, "recipes"), { recursive: true });

  fs.copyFileSync(STYLES_FILE, path.join(DIST_DIR, "style.css"));
  fs.copyFileSync(SEARCH_SCRIPT_FILE, path.join(DIST_DIR, "search.js"));
  fs.copyFileSync(SERVINGS_SCRIPT_FILE, path.join(DIST_DIR, "servings.js"));
  if (fs.existsSync(IMAGES_DIR)) {
    copyDir(IMAGES_DIR, path.join(DIST_DIR, "images"));
  }

  // Drafts (`draft: true`) always come first, then alphabetical within each group.
  const recipes = loadRecipes().sort((a, b) => (b.draft === true) - (a.draft === true) || a.title.localeCompare(b.title));

  fs.writeFileSync(path.join(DIST_DIR, "index.html"), renderIndex(recipes));

  for (const recipe of recipes) {
    const bodyHtml = marked.parse(recipe.body);
    const html = renderRecipe(recipe, bodyHtml);
    fs.writeFileSync(path.join(DIST_DIR, "recipes", `${recipe.slug}.html`), html);
  }

  const drafts = recipes.filter((r) => r.draft === true);
  const shoppingList = loadShoppingList(drafts);
  fs.writeFileSync(path.join(DIST_DIR, "shopping-list.html"), renderShoppingList(shoppingList, drafts));

  console.log(`Built ${recipes.length} recipe(s) into dist/`);
}

build();
