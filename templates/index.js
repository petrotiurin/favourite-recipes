const { layout } = require("./layout");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderIndex(recipes) {
  const tiles = recipes
    .map((r) => {
      return `      <a class="tile" href="recipes/${r.slug}.html">
        <img class="tile-image" src="${r.image.replace(/^\//, "")}" alt="${escapeHtml(r.title)}" loading="lazy">
        <div class="tile-body">
          <h2 class="tile-title">${escapeHtml(r.title)}</h2>
          <p class="tile-meta">🕒 ${r.total_mins} mins</p>
        </div>
      </a>`;
    })
    .join("\n");

  const content = `  <header class="site-header">
    <h1>Our Favourite Recipes</h1>
    <p>A collection of the recipes we keep coming back to.</p>
  </header>
  <main>
    <div class="tile-grid">
${tiles}
    </div>
  </main>`;

  return layout({ title: "Our Favourite Recipes", content, rootPrefix: "" });
}

module.exports = { renderIndex };
