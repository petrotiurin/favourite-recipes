const { layout } = require("./layout");

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

function renderItem({ quantity, name, note }) {
  const qty = quantity ? `<strong>${escapeHtml(quantity)}</strong> ` : "";
  const extra = note ? `<span class="shopping-note">, ${escapeHtml(note)}</span>` : "";
  return `        <li><label class="shopping-item"><input type="checkbox"><span>${qty}${escapeHtml(name)}${extra}</span></label></li>`;
}

/**
 * `list` is the agent-written shopping-list.json, or null when there is nothing
 * current to show. `drafts` are the draft recipes the list covers (for the links).
 */
function renderShoppingList(list, drafts) {
  let body;
  if (!list) {
    body = `    <p class="shopping-empty">Nothing to buy right now. The list appears here once there are draft recipes to shop for, and clears itself when they are promoted or removed.</p>`;
  } else {
    const links = drafts
      .map((r) => `<a href="recipes/${r.slug}.html">${escapeHtml(r.title)}</a>`)
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
    body = `    <p class="shopping-intro">Everything for the draft recipes below${updated ? ` &middot; updated ${updated}` : ""}</p>
    <div class="shopping-recipes">
      ${links}
    </div>
${sections}`;
  }

  const content = `  <main>
    <a class="back-link" href="index.html">&larr; All recipes</a>
    <h1 class="shopping-title">Shopping list</h1>
${body}
  </main>`;

  return layout({ title: "Shopping list — Our Favourite Recipes", bodyClass: "shopping-page", content, rootPrefix: "" });
}

module.exports = { renderShoppingList };
