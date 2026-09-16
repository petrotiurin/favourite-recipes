const { layout } = require("./layout");

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
    `<span>🍽️ Serves ${recipe.serves}</span>`,
  ].join("\n      ");

  const content = `  <main>
    <a class="back-link" href="../index.html">&larr; All recipes</a>
    <img class="recipe-hero" src="../${recipe.image.replace(/^\//, "")}" alt="${escapeHtml(recipe.title)}">
    <h1 class="recipe-title">${escapeHtml(recipe.title)}</h1>
    <div class="recipe-meta">
      ${metaChips}
    </div>
${bodyHtml}
  </main>`;

  return layout({
    title: `${recipe.title} — Our Favourite Recipes`,
    bodyClass: "recipe-page",
    content,
    rootPrefix: "../",
  });
}

module.exports = { renderRecipe };
