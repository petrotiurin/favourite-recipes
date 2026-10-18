const crypto = require("crypto");
const { layout } = require("./layout");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// The saved list is written for this many servings of every recipe; the picker rescales from it.
const BASE_SERVINGS = 2;

/** "400g" -> { amount: 400, unit: "g" }, "3" -> { amount: 3, unit: "" }; else null. Keep in sync with mcp-server/lib/shopping-list.js. */
function parseQuantity(quantity) {
  const m = String(quantity ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([^\d\s].*)?$/);
  return m ? { amount: parseFloat(m[1]), unit: (m[2] || "").trim() } : null;
}

const fmtAmount = (amount, unit) => `${Math.round(amount * 100) / 100}${!unit ? "" : /^(g|kg|ml|l)$/i.test(unit) ? unit : ` ${unit}`}`;

/** What's left to buy at the base servings: { status: "buy" | "partial" | "home", left }, `left` being the quantity text. */
function remaining(item) {
  const q = parseQuantity(item.quantity);
  if (item.have === true) return { status: "home", left: "" };
  if (typeof item.have !== "number" || !q) return { status: "buy", left: item.quantity || "" };
  const left = q.amount - item.have;
  return left > 0 ? { status: "partial", left: fmtAmount(left, q.unit) } : { status: "home", left: "" };
}

function renderItem(item, { status, left }) {
  const qty = left ? `<strong>${escapeHtml(left)}</strong> ` : "";
  const extra = item.note ? `<span class="shopping-note">, ${escapeHtml(item.note)}</span>` : "";
  const have = status === "partial" ? ` <span class="shopping-have">have ${escapeHtml(fmtAmount(item.have, parseQuantity(item.quantity).unit))} of ${escapeHtml(item.quantity)}</span>` : "";
  return `        <li><label class="shopping-item"><input type="checkbox"><span>${qty}${escapeHtml(item.name)}${extra}${have}</span></label></li>`;
}

/**
 * The page without JS: what's left to buy at 2 servings, then what's already at home.
 * templates/shopping.js re-renders #shopping-app from the embedded JSON (servings, the
 * "To buy" / "Full list" switch, ticks while shopping, and the signed-in stocktake).
 */
function renderStatic(list) {
  const home = [];
  const sections = list.sections
    .map((s) => {
      const items = s.items
        .map((item) => ({ item, r: remaining(item) }))
        .filter(({ item, r }) => (r.status === "home" ? (home.push(item), false) : true));
      if (!items.length) return "";
      return `    <section class="shopping-section">
      <h2>${escapeHtml(s.name)}</h2>
      <ul class="shopping-items">
${items.map(({ item, r }) => renderItem(item, r)).join("\n")}
      </ul>
    </section>`;
    })
    .filter(Boolean);
  if (!sections.length) sections.push(`    <p class="shopping-empty">Everything on the list is already at home.</p>`);
  if (home.length) {
    sections.push(`    <section class="shopping-section shopping-home">
      <h2>Already at home</h2>
      <ul class="shopping-items">
${home.map((item) => `        <li>${item.quantity ? `<strong>${escapeHtml(item.quantity)}</strong> ` : ""}${escapeHtml(item.name)}</li>`).join("\n")}
      </ul>
    </section>`);
  }
  return sections.join("\n");
}

/** Embedded for shopping.js: the list (with parsed amounts) and, when configured, how the editor signs in and saves. */
function pageData(list, auth) {
  const sections = list.sections.map((s) => ({
    name: s.name,
    items: s.items.map((item) => {
      const q = parseQuantity(item.quantity);
      return { ...item, ...(q ? { amount: q.amount, unit: q.unit } : {}) };
    }),
  }));
  // Identifies this list (not its stocktake), so local ticks and unsaved edits never carry over to a new one.
  const version = crypto
    .createHash("sha256")
    .update(JSON.stringify(list.sections.map((s) => s.items.map((i) => [i.name, i.quantity || ""]))))
    .digest("hex")
    .slice(0, 12);
  const data = { base: BASE_SERVINGS, version, stocktake: list.stocktake || null, sections, auth };
  // Safe inside <script>: no "</script>" or "<!--" can survive the escape.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * `list` is the agent-written shopping-list.json, or null when there is nothing
 * current to show. `recipes` are the recipes the list was built from (for the links).
 * `auth` ({ supabaseUrl, supabaseKey, api }) turns on the editor's stocktake, or null.
 */
function renderShoppingList(list, recipes, auth = null) {
  let body;
  if (!list) {
    body = `    <p class="shopping-empty">Nothing to buy right now. The list appears here once there are current recipes and a shopping list has been made for them.</p>`;
  } else {
    const links = recipes
      .map((r) => `<a${r.draft === true ? ' class="is-draft"' : ""} href="recipes/${r.slug}.html">${escapeHtml(r.title)}</a>`)
      .join("\n      ");
    const updated = formatDate(list.updated);
    const stocktake = list.stocktake ? formatDate(list.stocktake) : "";
    body = `    <p class="shopping-intro">Everything for the recipes below, ${BASE_SERVINGS} servings of each${updated ? ` &middot; updated ${updated}` : ""}${stocktake ? ` &middot; checked what's at home ${stocktake}` : ""}</p>
    <div class="shopping-recipes">
      ${links}
    </div>
    <div id="shopping-app">
${renderStatic(list)}
    </div>
    <script type="application/json" id="shopping-data">${pageData(list, auth)}</script>`;
  }

  const content = `  <main>
    <a class="back-link" href="index.html">&larr; All recipes</a>
    <h1 class="shopping-title">Shopping list</h1>
${body}
  </main>${list ? '\n  <script src="shopping.js" defer></script>' : ""}`;

  return layout({ title: "Shopping list — Our Favourite Recipes", bodyClass: "shopping-page", content, rootPrefix: "" });
}

module.exports = { renderShoppingList };
