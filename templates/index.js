const { layout } = require("./layout");
const { isDraft, isCurrent } = require("./status");

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
    .concat(isCurrent(r) ? ["is-current"] : [])
    .concat(isDraft(r) ? ["is-draft"] : [])
    .join(" ");
}

function renderIndex(recipes) {
  const tiles = recipes
    .map((r) => {
      return `      <a class="tile ${courseClasses(r)}" href="recipes/${r.slug}.html">
${isDraft(r) ? '        <span class="draft-badge">Draft</span>\n' : r.current === true ? '        <span class="current-badge">Current</span>\n' : ""}        <img class="tile-image" src="${r.image.replace(/^\//, "")}" alt="${escapeHtml(r.title)}" loading="lazy">
        <div class="tile-body">
          <h2 class="tile-title">${escapeHtml(r.title)}</h2>
          <p class="tile-meta">🕒 ${r.total_mins} mins &middot; 🍽️ Serves ${r.serves} &middot; 🔥 ${r.calories} kcal</p>
        </div>
      </a>`;
    })
    .join("\n");

  // The Current tab (drafts + current recipes) only appears when some regular recipe
  // is current, since otherwise it would be the same as the Drafts tab. Drafts likewise.
  const filters = COURSES.concat(recipes.some((r) => r.current === true && !isDraft(r)) ? ["Current"] : []).concat(
    recipes.some(isDraft) ? ["Drafts"] : []
  );

  // Each input must sit directly before its label: the CSS highlights the
  // active filter with `.filter-input:checked + .filter-label`.
  const filterControls = [`      <input type="radio" name="course-filter" id="filter-all" class="filter-input" checked>
      <label for="filter-all" class="filter-label">All</label>`]
    .concat(
      filters.map((c) => {
        const id = `filter-${c.toLowerCase()}`;
        return `      <input type="radio" name="course-filter" id="${id}" class="filter-input">
      <label for="${id}" class="filter-label${c === "Drafts" ? " filter-label-draft" : c === "Current" ? " filter-label-current" : ""}">${c}</label>`;
      })
    )
    .join("\n");

  const content = `  <header class="site-header">
    <h1>Our Favourite Recipes</h1>
    <p>A collection of the recipes we keep coming back to.</p>
    <a class="shopping-link" href="shopping-list.html">🛒 Shopping list</a>
  </header>
  <main>
    <input type="search" id="recipe-search" class="search-input" placeholder="Search recipes by name&hellip;" autocomplete="off">
    <div class="filter-bar">
${filterControls}
    </div>
    <div class="tile-grid">
${tiles}
    </div>
  </main>
  <script src="search.js" defer></script>`;

  return layout({ title: "Our Favourite Recipes", content, rootPrefix: "" });
}

module.exports = { renderIndex };
