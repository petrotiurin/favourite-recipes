const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { marked } = require("marked");
const { renderIndex } = require("./templates/index");
const { renderRecipe } = require("./templates/recipe");

const ROOT = __dirname;
const RECIPES_DIR = path.join(ROOT, "recipes");
const IMAGES_DIR = path.join(ROOT, "images");
const STYLES_FILE = path.join(ROOT, "styles", "style.css");
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
    if (!data.title || !data.slug || !data.image || !data.total_mins) {
      throw new Error(`Recipe ${file} is missing required frontmatter (title, slug, image, total_mins)`);
    }
    return { ...data, body: content };
  });
}

function build() {
  rimraf(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, "recipes"), { recursive: true });

  fs.copyFileSync(STYLES_FILE, path.join(DIST_DIR, "style.css"));
  if (fs.existsSync(IMAGES_DIR)) {
    copyDir(IMAGES_DIR, path.join(DIST_DIR, "images"));
  }

  const recipes = loadRecipes().sort((a, b) => a.title.localeCompare(b.title));

  fs.writeFileSync(path.join(DIST_DIR, "index.html"), renderIndex(recipes));

  for (const recipe of recipes) {
    const bodyHtml = marked.parse(recipe.body);
    const html = renderRecipe(recipe, bodyHtml);
    fs.writeFileSync(path.join(DIST_DIR, "recipes", `${recipe.slug}.html`), html);
  }

  console.log(`Built ${recipes.length} recipe(s) into dist/`);
}

build();
