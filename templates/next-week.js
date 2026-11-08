const { layout } = require("./layout");
const { siteBar, tile } = require("./tiles");

const ICON_BACK =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

/**
 * next-week.html: the recipes being planned (`next: true`), each labelled "Next week" in teal.
 * Always written, so the home page's link never 404s; says so when nothing is planned yet.
 */
function renderNextWeek(recipes) {
  const n = recipes.length;
  const body = n
    ? `    <div class="tile-grid">
${recipes.map((r) => tile(r, { kicker: { cls: "kicker-next", label: "Next week" } })).join("\n")}
    </div>`
    : `    <p class="page-empty">Nothing planned for next week yet.</p>`;

  const content = `${siteBar()}
  <main>
    <a class="back-link" href="index.html">${ICON_BACK}This week</a>
    <header class="page-head">
      <p class="kicker kicker-next">Planning &middot; ${n} recipe${n === 1 ? "" : "s"}</p>
      <h1 class="page-title">Next week</h1>
    </header>
${body}
  </main>`;

  return layout({ title: "Next week — Our Favourite Recipes", content, rootPrefix: "", pageContext: { page: "next-week" } });
}

module.exports = { renderNextWeek };
