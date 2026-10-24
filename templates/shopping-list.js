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

// House icons, the page's one icon language (design.md). Duplicated in templates/shopping.js.
const HOUSE_PATH = '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>';
const iconSome = (cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HOUSE_PATH}<rect x="5" y="14" width="14" height="6" fill="currentColor"/></svg>`;

const CHEVRON =
  '<svg class="icon chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function noteHtml(item) {
  return item.note ? `<span class="shop-note">${escapeHtml(item.note)}</span>` : "";
}

function renderItem(item, { status, left }) {
  const partial =
    status === "partial"
      ? `${iconSome("icon icon-some")}<span class="sr-only">(have ${escapeHtml(fmtAmount(item.have, parseQuantity(item.quantity).unit))} of ${escapeHtml(item.quantity)} at home)</span>`
      : "";
  return `        <li><label class="shop-item"><input type="checkbox" class="tick"><span class="shop-name">${escapeHtml(item.name)}${noteHtml(item)}</span>${partial}<span class="shop-qty">${escapeHtml(left)}</span></label></li>`;
}

/** "Home checked 18 Oct: 3 at home, 2 partly", when the editor has saved a stocktake. */
function homeCard(list) {
  if (!list.stocktake) return "";
  let home = 0;
  let partly = 0;
  list.sections.forEach((s) =>
    s.items.forEach((item) => {
      const { status } = remaining(item);
      if (status === "home") home++;
      else if (status === "partial") partly++;
    })
  );
  return `    <div class="home-card">${iconSome()}<span class="home-card-text"><strong>Home checked ${escapeHtml(formatDate(list.stocktake))}</strong><span>${home} at home, ${partly} partly. Already taken off.</span></span></div>`;
}

/**
 * The page without JS: what's left to buy at 2 servings, then what's already at home.
 * templates/shopping.js re-renders #shopping-app from the embedded JSON (servings, ticks
 * while shopping, and for the signed-in editor the "At home" tab and sign-in).
 */
function renderStatic(list) {
  const home = [];
  const sections = list.sections
    .map((s) => {
      const items = s.items
        .map((item) => ({ item, r: remaining(item) }))
        .filter(({ item, r }) => (r.status === "home" ? (home.push(item), false) : true));
      if (!items.length) return "";
      return `    <details class="shop-section" data-section="${escapeHtml(s.name)}" open>
      <summary><h2>${escapeHtml(s.name)}</h2><span class="section-count">${items.length}</span>${CHEVRON}</summary>
      <ul class="shop-list">
${items.map(({ item, r }) => renderItem(item, r)).join("\n")}
      </ul>
    </details>`;
    })
    .filter(Boolean);
  if (!sections.length) sections.push(`    <p class="shopping-empty">Everything on the list is already at home.</p>`);
  if (home.length) {
    sections.push(`    <details class="shop-home">
      <summary>Already at home (${home.length})</summary>
      <ul>
${home.map((item) => `        <li><span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.quantity || "")}</span></li>`).join("\n")}
      </ul>
    </details>`);
  }
  return [homeCard(list), ...sections].filter(Boolean).join("\n");
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
    const photo = (r) => `<img src="${escapeHtml(r.image.replace(/^\//, ""))}" alt="" loading="lazy">`;
    const links = recipes
      .map((r) => `<a${r.draft === true ? ' class="is-draft"' : ""} href="recipes/${r.slug}.html">${photo(r)}<span>${escapeHtml(r.title)}</span></a>`)
      .join("\n        ");
    const updated = formatDate(list.updated);
    const count = `${recipes.length} recipe${recipes.length === 1 ? "" : "s"}`;
    // The recipes' photos as overlapping bubbles; opening the summary lists them by name.
    const bubbles = recipes.length ? `<span class="bubbles">${recipes.map(photo).join("")}</span>` : "";
    body = `    <details class="shop-for">
      <summary>${bubbles}<span>For ${count}${updated ? ` &middot; list made ${updated}` : ""}</span></summary>
      <div class="shopping-recipes">
        ${links}
      </div>
    </details>
    <div id="shopping-app">
${renderStatic(list)}
    </div>
    <script type="application/json" id="shopping-data">${pageData(list, auth)}</script>`;
  }

  const content = `  <main>
    <div class="shop-top">
      <a class="back-link" href="index.html"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All recipes</a>
      <div class="shop-account" id="shopping-account"></div>
    </div>
    <h1 class="shopping-title">Shopping list</h1>
${body}
  </main>${list ? '\n  <script src="shopping.js" defer></script>' : ""}`;

  return layout({ title: "Shopping list — Our Favourite Recipes", bodyClass: "shopping-page", content, rootPrefix: "" });
}

module.exports = { renderShoppingList };
