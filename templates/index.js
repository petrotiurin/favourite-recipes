const { layout } = require("./layout");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COURSES = ["Breakfast", "Lunch", "Dinner", "Snack"];

function courseClasses(r) {
  return (r.course || [])
    .map((c) => `course-${String(c).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`)
    .join(" ");
}

function renderIndex(recipes) {
  const tiles = recipes
    .map((r) => {
      return `      <a class="tile ${courseClasses(r)}" href="recipes/${r.slug}.html">
        <img class="tile-image" src="${r.image.replace(/^\//, "")}" alt="${escapeHtml(r.title)}" loading="lazy">
        <div class="tile-body">
          <h2 class="tile-title">${escapeHtml(r.title)}</h2>
          <p class="tile-meta">🕒 ${r.total_mins} mins &middot; 🍽️ Serves ${r.serves}</p>
        </div>
      </a>`;
    })
    .join("\n");

  const filterInputs = [`      <input type="radio" name="course-filter" id="filter-all" class="filter-input" checked>`]
    .concat(
      COURSES.map((c) => {
        const id = `filter-${c.toLowerCase()}`;
        return `      <input type="radio" name="course-filter" id="${id}" class="filter-input">`;
      })
    )
    .join("\n");

  const filterLabels = [`      <label for="filter-all" class="filter-label">All</label>`]
    .concat(
      COURSES.map((c) => `      <label for="filter-${c.toLowerCase()}" class="filter-label">${c}</label>`)
    )
    .join("\n");

  const content = `  <header class="site-header">
    <h1>Our Favourite Recipes</h1>
    <p>A collection of the recipes we keep coming back to.</p>
  </header>
  <main>
    <div class="filter-bar">
${filterInputs}
${filterLabels}
    </div>
    <div class="tile-grid">
${tiles}
    </div>
  </main>`;

  return layout({ title: "Our Favourite Recipes", content, rootPrefix: "" });
}

module.exports = { renderIndex };
