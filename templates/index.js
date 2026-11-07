const { layout } = require("./layout");
const { isThisWeek, isNextWeek, isHiddenUntilNextWeek } = require("./status");
const { siteBar, tile, courseLabel } = require("./tiles");

const COURSES = ["Breakfast", "Lunch", "Dinner", "Snack"];

const ICON_SEARCH =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_ARROW =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

const courseClasses = (r) => (r.course || []).map((c) => `course-${String(c).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);

/**
 * The week heading above the grid: "This week" on the left (when this week has recipes) and, on the right,
 * a teal link to next-week.html with next week's count, or a quiet "not planned" when next week is empty.
 */
function weekHead(thisWeekCount, nextWeekCount) {
  if (!thisWeekCount && !nextWeekCount) return "";
  const label = thisWeekCount ? `<h2 class="week-label">This week</h2>` : "<span></span>";
  const next = nextWeekCount
    ? `<a class="week-link" href="next-week.html">Next week &middot; ${nextWeekCount}${ICON_ARROW}</a>`
    : `<span class="week-empty">Next week: not planned</span>`;
  return `    <div class="week-head">
      ${label}
      ${next}
    </div>\n`;
}

function renderIndex(recipes) {
  // Drafts planned only for next week aren't on the home page at all (search can't find them either)
  // until the switch: they live on the Next week page. Recipes arrive with this week first (drafts first),
  // then the rest; a divider marks where the rest begins (hidden while filtering or searching). Next week's
  // other recipes sit in the rest, unmarked.
  const shown = recipes.filter((r) => !isHiddenUntilNextWeek(r));
  const restStart = shown.findIndex((r) => !isThisWeek(r));
  const tiles = shown
    .map((r, i) => {
      const divider = i === restStart && i > 0 ? `      <p class="tile-divider">The rest of the book</p>\n` : "";
      const kicker = isThisWeek(r) ? { cls: "kicker-current", label: "This week" } : { label: courseLabel(r) };
      return divider + tile(r, { kicker, cls: courseClasses(r).concat(isThisWeek(r) ? ["is-current"] : []).join(" ") });
    })
    .join("\n");

  // Each input must sit directly before its label: the CSS highlights the
  // active filter with `.filter-input:checked + .filter-label`.
  const filterControls = ["All", ...COURSES]
    .map((c) => {
      const id = `filter-${c.toLowerCase()}`;
      return `      <input type="radio" name="course-filter" id="${id}" class="filter-input"${c === "All" ? " checked" : ""}>
      <label for="${id}" class="filter-label">${c}</label>`;
    })
    .join("\n");

  const content = `${siteBar()}
  <main>
    <h1 class="sr-only">Our Favourite Recipes</h1>
    <label class="search">${ICON_SEARCH}<span class="sr-only">Search recipes</span><input type="search" id="recipe-search" class="search-input" placeholder="Search recipes" autocomplete="off"></label>
    <div class="filter-bar">
${filterControls}
    </div>
${weekHead(recipes.filter(isThisWeek).length, recipes.filter(isNextWeek).length)}    <div class="tile-grid">
${tiles}
    </div>
  </main>
  <script src="search.js" defer></script>`;

  return layout({ title: "Our Favourite Recipes", content, rootPrefix: "", pageContext: { page: "index" } });
}

module.exports = { renderIndex };
