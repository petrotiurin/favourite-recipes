// Shared pieces of the recipe lists (the home page and the Next week page).

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ICON_CART =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>';

/** Top bar: italic serif brand, the shopping list on the right. */
const siteBar = () => `  <header class="site-bar">
    <a class="brand" href="index.html">Our Favourite Recipes</a>
    <a class="bar-link" href="shopping-list.html">${ICON_CART}<span>Shopping list</span></a>
  </header>`;

/** One recipe tile; `kicker` is the small-caps line's HTML ({ cls, label }), `cls` extra classes on the tile. */
function tile(r, { kicker, cls = "" }) {
  return `      <a class="tile${cls ? ` ${cls}` : ""}" href="recipes/${r.slug}.html">
        <img class="tile-image" src="${r.image.replace(/^\//, "")}" alt="" loading="lazy">
        <p class="kicker${kicker.cls ? ` ${kicker.cls}` : ""}">${kicker.label}</p>
        <h2 class="tile-title">${escapeHtml(r.title)}</h2>
        <p class="tile-meta">${r.total_mins} min &middot; ${r.calories} kcal</p>
      </a>`;
}

const courseLabel = (r) => escapeHtml((r.course || []).join(" · "));

module.exports = { escapeHtml, siteBar, tile, courseLabel };
