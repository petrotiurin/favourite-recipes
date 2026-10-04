const { layout } = require("./layout");
const { markQuantityText } = require("./quantities");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// The saved list is written for this many servings of every recipe; the picker rescales from it.
const BASE_SERVINGS = 2;
const SERVING_OPTIONS = [1, 2, 4];

function renderItem({ quantity, name, note }) {
  const qty = quantity ? `<strong>${markQuantityText(escapeHtml(quantity))}</strong> ` : "";
  const extra = note ? `<span class="shopping-note">, ${escapeHtml(note)}</span>` : "";
  return `        <li><label class="shopping-item"><input type="checkbox"><span>${qty}${escapeHtml(name)}${extra}</span></label></li>`;
}

/**
 * `list` is the agent-written shopping-list.json, or null when there is nothing
 * current to show. `recipes` are the recipes the list was built from (for the links).
 */
function renderShoppingList(list, recipes) {
  let body;
  if (!list) {
    body = `    <p class="shopping-empty">Nothing to buy right now. The list appears here once there are current recipes and a shopping list has been made for them.</p>`;
  } else {
    const links = recipes
      .map((r) => `<a${r.draft === true ? ' class="is-draft"' : ""} href="recipes/${r.slug}.html">${escapeHtml(r.title)}</a>`)
      .join("\n      ");
    const updated = formatDate(list.updated);
    const sections = list.sections
      .map(
        (s) => `    <section class="shopping-section">
      <h2>${escapeHtml(s.name)}</h2>
      <ul class="shopping-items">
${s.items.map(renderItem).join("\n")}
      </ul>
    </section>`
      )
      .join("\n");
    // Hidden until servings.js runs, so the page reads normally (at 2 servings) with JS disabled.
    const picker = `    <div class="servings-picker" data-base="${BASE_SERVINGS}" role="group" aria-label="Servings per recipe" hidden>
      <span class="servings-label">Servings per recipe</span>
      ${SERVING_OPTIONS.map((n) => `<button type="button" data-serves="${n}" aria-pressed="${n === BASE_SERVINGS}">${n}</button>`).join("\n      ")}
    </div>`;
    body = `    <p class="shopping-intro">Everything for the recipes below, ${BASE_SERVINGS} servings of each${updated ? ` &middot; updated ${updated}` : ""}</p>
${picker}
    <div class="shopping-recipes">
      ${links}
    </div>
${sections}`;
  }

  const content = `  <main>
    <a class="back-link" href="index.html">&larr; All recipes</a>
    <h1 class="shopping-title">Shopping list</h1>
${body}
  </main>${list ? '\n  <script src="servings.js" defer></script>' : ""}`;

  return layout({ title: "Shopping list — Our Favourite Recipes", bodyClass: "shopping-page", content, rootPrefix: "" });
}

module.exports = { renderShoppingList };
