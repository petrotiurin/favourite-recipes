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

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const count = (n, one, many) => `${NUMBER_WORDS[n] || n} ${n === 1 ? one : many}`;
const capitalise = (str) => str.charAt(0).toUpperCase() + str.slice(1);

/** The index's opening line: what's in this week's rotation, or the whole book when nothing is current. */
function lede(recipes) {
  const drafts = recipes.filter(isDraft).length;
  const regulars = recipes.filter((r) => isCurrent(r) && !isDraft(r)).length;
  const parts = [
    ...(drafts ? [count(drafts, "new thing to try", "new things to try")] : []),
    ...(regulars ? [count(regulars, "old friend", "old friends")] : []),
  ];
  return parts.length
    ? { kicker: "This week", headline: `${capitalise(parts.join(", "))}.` }
    : { kicker: "The family cookbook", headline: `${capitalise(count(recipes.length, "recipe", "recipes"))} we keep coming back to.` };
}

/** The small-caps line above a tile's name: its place in the rotation, else its course. */
function kicker(r) {
  if (isDraft(r)) return `<p class="kicker kicker-draft">To try</p>`;
  if (isCurrent(r)) return `<p class="kicker kicker-current">This week</p>`;
  return `<p class="kicker">${escapeHtml((r.course || []).join(" · "))}</p>`;
}

const ICON_SEARCH =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_CART =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>';

function renderIndex(recipes) {
  // Recipes arrive drafts first, then other current ones, then the rest; a divider
  // marks where the rest begins (hidden by the CSS while filtering or searching).
  const restStart = recipes.findIndex((r) => !isCurrent(r));
  const tiles = recipes
    .map((r, i) => {
      const divider = i === restStart && i > 0 ? `      <p class="tile-divider">The rest of the book</p>\n` : "";
      return `${divider}      <a class="tile ${courseClasses(r)}" href="recipes/${r.slug}.html">
        <img class="tile-image" src="${r.image.replace(/^\//, "")}" alt="" loading="lazy">
        ${kicker(r)}
        <h2 class="tile-title">${escapeHtml(r.title)}</h2>
        <p class="tile-meta">${r.total_mins} min &middot; ${r.calories} kcal</p>
      </a>`;
    })
    .join("\n");

  // The Current tab (drafts + current recipes) only appears when some regular recipe
  // is current, since otherwise it would be the same as the Drafts tab. Drafts likewise.
  const filters = COURSES.concat(recipes.some((r) => r.current === true && !isDraft(r)) ? ["Current"] : []).concat(
    recipes.some(isDraft) ? ["Drafts"] : []
  );
  const FILTER_NAMES = { Current: "This week", Drafts: "To try" };

  // Each input must sit directly before its label: the CSS highlights the
  // active filter with `.filter-input:checked + .filter-label`.
  const filterControls = [`      <input type="radio" name="course-filter" id="filter-all" class="filter-input" checked>
      <label for="filter-all" class="filter-label">All</label>`]
    .concat(
      filters.map((c) => {
        const id = `filter-${c.toLowerCase()}`;
        return `      <input type="radio" name="course-filter" id="${id}" class="filter-input">
      <label for="${id}" class="filter-label${c === "Drafts" ? " filter-label-draft" : c === "Current" ? " filter-label-current" : ""}">${FILTER_NAMES[c] || c}</label>`;
      })
    )
    .join("\n");

  const { kicker: ledeKicker, headline } = lede(recipes);
  const content = `  <header class="site-bar">
    <a class="brand" href="index.html">Our Favourite Recipes</a>
    <a class="bar-link" href="shopping-list.html">${ICON_CART}<span>Shopping list</span></a>
  </header>
  <main>
    <div class="lede">
      <p class="kicker">${ledeKicker}</p>
      <h1>${headline}</h1>
    </div>
    <label class="search">${ICON_SEARCH}<span class="sr-only">Search recipes</span><input type="search" id="recipe-search" class="search-input" placeholder="Search recipes" autocomplete="off"></label>
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
