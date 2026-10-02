const { layout } = require("./layout");
const { markScalableQuantities } = require("./quantities");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRecipe(recipe, bodyHtml) {
  const metaChips = [
    ...(recipe.course || []).map((c) => `<span>${escapeHtml(c)}</span>`),
    ...(recipe.tags || []).map((t) => `<span>${escapeHtml(t)}</span>`),
    `<span>🕒 ${recipe.total_mins} mins</span>`,
    `<span class="serves-chip">🍽️ Serves ${recipe.serves}</span>`,
    `<span>🔥 ${recipe.calories} kcal per serving</span>`,
  ].join("\n      ");

  // `scalable: false` in frontmatter opts a recipe out (e.g. its ingredient list
  // already gives amounts per number of people).
  const { html: scaledBodyHtml, scalable } =
    recipe.scalable === false ? { html: bodyHtml, scalable: false } : markScalableQuantities(bodyHtml);
  // Hidden until servings.js runs, so the page reads normally with JS disabled.
  const servingOptions = [...new Set([1, 2, 4, Number(recipe.serves)])].sort((a, b) => a - b);
  const servingsPicker = scalable
    ? `<div class="servings-picker" data-base="${recipe.serves}" role="group" aria-label="Servings" hidden>
  <span class="servings-label">Servings</span>
  ${servingOptions
    .map((n) => `<button type="button" data-serves="${n}" aria-pressed="${n === Number(recipe.serves)}">${n}</button>`)
    .join("\n  ")}
</div>
`
    : "";
  const body = scaledBodyHtml.replace(/(<h2[^>]*>\s*Ingredients\b[^<]*<\/h2>\n?)/i, `$1${servingsPicker}`);

  const content = `  <main>
    <a class="back-link" href="../index.html">&larr; All recipes</a>
    <img class="recipe-hero" src="../${recipe.image.replace(/^\//, "")}" alt="${escapeHtml(recipe.title)}">
    <h1 class="recipe-title">${escapeHtml(recipe.title)}</h1>
    <div class="recipe-meta">
      ${metaChips}
    </div>
${body}
  </main>${scalable ? '\n  <script src="../servings.js" defer></script>' : ""}`;

  return layout({
    title: `${recipe.title} — Our Favourite Recipes`,
    bodyClass: "recipe-page",
    content,
    rootPrefix: "../",
  });
}

module.exports = { renderRecipe };
