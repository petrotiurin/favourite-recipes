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

// The saved list is written for this many servings of every recipe; the page rescales from it.
const BASE_SERVINGS = 2;
// The list's `servings` plans each recipe (set by the agent); a recipe without a plan gets this.
// Keep both in sync with mcp-server/lib/shopping-list.js.
const DEFAULT_SERVINGS = 4;

/** "400g" -> { amount: 400, unit: "g" }, "3" -> { amount: 3, unit: "" }; else null. Keep in sync with mcp-server/lib/shopping-list.js. */
function parseQuantity(quantity) {
  const m = String(quantity ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*([^\d\s].*)?$/);
  return m ? { amount: parseFloat(m[1]), unit: (m[2] || "").trim() } : null;
}

const fmtAmount = (amount, unit) => `${Math.round(amount * 100) / 100}${!unit ? "" : /^(g|kg|ml|l)$/i.test(unit) ? unit : ` ${unit}`}`;

/** slug -> planned servings for every recipe the list covers. */
function planOf(list) {
  const plan = {};
  for (const slug of [...(Array.isArray(list.recipes) ? list.recipes : [])].sort()) {
    const n = list.servings && list.servings[slug];
    plan[slug] = Number.isInteger(n) && n > 0 ? n : DEFAULT_SERVINGS;
  }
  return plan;
}

/**
 * How much of an item the plan needs: each recipe's share of the 2-serving quantity (`amounts`, or
 * all of it for a one-recipe item) times its servings / BASE_SERVINGS; items without `amounts` (older
 * lists) scale by the average of their recipes' servings. null when the quantity has no amount.
 * Keep in sync with neededAmount in mcp-server/lib/shopping-list.js and need() in templates/shopping.js.
 */
function neededAmount(item, plan) {
  const q = parseQuantity(item.quantity);
  if (!q) return null;
  const servingsOf = (slug) => plan[slug] || DEFAULT_SERVINGS;
  if (item.amounts) return Object.entries(item.amounts).reduce((n, [slug, a]) => n + (a * servingsOf(slug)) / BASE_SERVINGS, 0);
  const slugs = item.recipes && item.recipes.length ? item.recipes : Object.keys(plan);
  const mean = slugs.length ? slugs.reduce((n, slug) => n + servingsOf(slug), 0) / slugs.length : DEFAULT_SERVINGS;
  return (q.amount * mean) / BASE_SERVINGS;
}

/** The quantity text at the planned servings. */
function needText(item, plan) {
  const need = neededAmount(item, plan);
  const q = parseQuantity(item.quantity);
  return need === null || Math.abs(need - q.amount) < 1e-9 ? item.quantity || "" : fmtAmount(need, q.unit);
}

/** What's left to buy at the planned servings: { status: "buy" | "partial" | "home", left }, `left` being the quantity text. */
function remaining(item, plan) {
  const need = neededAmount(item, plan);
  if (item.have === true) return { status: "home", left: "" };
  if (typeof item.have !== "number" || need === null) return { status: "buy", left: needText(item, plan) };
  const left = need - item.have;
  return left > 1e-9 ? { status: "partial", left: fmtAmount(left, parseQuantity(item.quantity).unit) } : { status: "home", left: "" };
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

// A row shows at most this many recipe photos, then "+n".
const ROW_PHOTOS = 3;

/** The photos of the recipes an item is for (its `recipes` slugs); shopping.js turns them into a button that names them. */
function rowBubbles(item, bySlug) {
  const rs = (item.recipes || []).map((slug) => bySlug.get(slug)).filter(Boolean);
  if (!rs.length) return "";
  const imgs = rs.slice(0, ROW_PHOTOS).map((r) => `<img src="${escapeHtml(r.image.replace(/^\//, ""))}" alt="" loading="lazy">`).join("");
  const more = rs.length > ROW_PHOTOS ? `<span class="row-more">+${rs.length - ROW_PHOTOS}</span>` : "";
  return `<span class="row-bubbles" aria-hidden="true">${imgs}${more}</span><span class="sr-only">(for ${escapeHtml(rs.map((r) => r.title).join(", "))})</span>`;
}

function renderItem(item, { status, left }, bySlug, plan) {
  const partial =
    status === "partial"
      ? `${iconSome("icon icon-some")}<span class="sr-only">(have ${escapeHtml(fmtAmount(item.have, parseQuantity(item.quantity).unit))} of ${escapeHtml(needText(item, plan))} at home)</span>`
      : "";
  return `        <li><label class="shop-item"><input type="checkbox" class="tick"><span class="shop-name">${escapeHtml(item.name)}${noteHtml(item)}</span>${partial}${rowBubbles(item, bySlug)}<span class="shop-qty">${escapeHtml(left)}</span></label></li>`;
}

/** "Home checked 18 Oct: 3 at home, 2 partly", when the editor has saved a stocktake. */
function homeCard(list, plan) {
  if (!list.stocktake) return "";
  let home = 0;
  let partly = 0;
  list.sections.forEach((s) =>
    s.items.forEach((item) => {
      const { status } = remaining(item, plan);
      if (status === "home") home++;
      else if (status === "partial") partly++;
    })
  );
  return `    <div class="home-card">${iconSome()}<span class="home-card-text"><strong>Home checked ${escapeHtml(formatDate(list.stocktake))}</strong><span>${home} at home, ${partly} partly. Already taken off.</span></span></div>`;
}

/**
 * The page without JS: what's left to buy at the planned servings, then what's already at home.
 * templates/shopping.js re-renders #shopping-app from the embedded JSON (servings, ticks
 * while shopping, and for the signed-in editor the "At home" tab and sign-in).
 */
function renderStatic(list, bySlug, plan) {
  const home = [];
  const sections = list.sections
    .map((s) => {
      const items = s.items
        .map((item) => ({ item, r: remaining(item, plan) }))
        .filter(({ item, r }) => (r.status === "home" ? (home.push(item), false) : true));
      if (!items.length) return "";
      return `    <details class="shop-section" data-section="${escapeHtml(s.name)}" open>
      <summary><h2>${escapeHtml(s.name)}</h2><span class="section-count">${items.length}</span>${CHEVRON}</summary>
      <ul class="shop-list">
${items.map(({ item, r }) => renderItem(item, r, bySlug, plan)).join("\n")}
      </ul>
    </details>`;
    })
    .filter(Boolean);
  if (!sections.length) sections.push(`    <p class="shopping-empty">Everything on the list is already at home.</p>`);
  if (home.length) {
    sections.push(`    <details class="shop-home">
      <summary>Already at home (${home.length})</summary>
      <ul>
${home.map((item) => `        <li><span>${escapeHtml(item.name)}</span><span>${escapeHtml(needText(item, plan))}</span></li>`).join("\n")}
      </ul>
    </details>`);
  }
  return [homeCard(list, plan), ...sections].filter(Boolean).join("\n");
}

/**
 * Embedded for shopping.js: the list (with parsed amounts), the planned servings per recipe, the
 * recipes its items are for (title, photo, page) and, when configured, how the editor signs in and saves.
 */
function pageData(list, bySlug, auth, plan) {
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
  const recipes = {};
  bySlug.forEach((r, slug) => {
    recipes[slug] = { title: r.title, image: r.image.replace(/^\//, ""), href: `recipes/${slug}.html` };
  });
  const data = { base: BASE_SERVINGS, fallback: DEFAULT_SERVINGS, plan, version, stocktake: list.stocktake || null, sections, recipes, auth };
  // Safe inside <script>: no "</script>" or "<!--" can survive the escape.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * `list` is the agent-written shopping-list.json (made for next week's recipes),
 * or null when there is none. `recipes` are the recipes the list was built from (for the links).
 * `auth` ({ supabaseUrl, supabaseKey, api }) turns on the editor's stocktake, or null.
 */
function renderShoppingList(list, recipes, auth = null) {
  let body;
  if (!list) {
    body = `    <p class="shopping-empty">Nothing to buy right now. The list appears here once next week's recipes are planned and a shopping list has been made for them.</p>`;
  } else {
    const bySlug = new Map(recipes.map((r) => [r.slug, r]));
    const plan = planOf(list);
    const photo = (r) => `<img src="${escapeHtml(r.image.replace(/^\//, ""))}" alt="" loading="lazy">`;
    const links = recipes
      .map(
        (r) =>
          `<a href="recipes/${r.slug}.html">${photo(r)}<span>${escapeHtml(r.title)}</span>` +
          `<small class="planned">for ${plan[r.slug] || DEFAULT_SERVINGS}</small></a>`
      )
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
${renderStatic(list, bySlug, plan)}
    </div>
    <script type="application/json" id="shopping-data">${pageData(list, bySlug, auth, plan)}</script>`;
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
