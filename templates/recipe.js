const { layout } = require("./layout");
const { ingredientHtml, ingredientText, hasAmounts } = require("./ingredients");
const { isThisWeek, isNextWeek } = require("./status");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DEFAULT_SERVINGS = 4;

const ingredientsOf = (recipe) => (Array.isArray(recipe.ingredients) ? recipe.ingredients : []);

// The recipe as plain text for the "Cook with Claude" prompt (templates/cook-claude.js): the ingredient lines rendered
// from the data, then the Markdown body without bold, links or heading marks, so it reads cleanly in a chat.
function recipePlainText(recipe) {
  const facts = `Serves ${recipe.serves} · ${recipe.total_mins} min · ${recipe.calories} kcal per serving`;
  const ingredients = ingredientsOf(recipe);
  const list = `Ingredients\n\n${ingredients.length ? ingredients.map((i) => `- ${ingredientText(i)}`).join("\n") : "Not recorded yet."}`;
  const body = String(recipe.body || "")
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${facts}\n\n${list}\n\n${body}`;
}

// Data for cook-claude.js, as JSON in a script element: "<" and friends escaped so no value can close it.
function cookJson(recipe, scalable) {
  return JSON.stringify({
    title: recipe.title,
    slug: recipe.slug,
    serves: Number(recipe.serves),
    scalable,
    text: recipePlainText(recipe),
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderRecipe(recipe, bodyHtml) {
  // Small-caps line above the name: the week(s) it's planned for, then course and tags.
  // (A draft says so in the line under the title, not here.)
  const status = [
    ...(isThisWeek(recipe) ? [`<span class="kicker-current">This week</span>`] : []),
    ...(isNextWeek(recipe) ? [`<span class="kicker-next">Next week</span>`] : []),
  ];
  const kicker = [...status, ...[...(recipe.course || []), ...(recipe.tags || [])].map(escapeHtml)].join(" &middot; ");
  const meta = [
    `<span><b>${recipe.total_mins}</b> min</span>`,
    `<span class="serves-chip">Serves <b>${recipe.serves}</b></span>`,
    `<span><b>${recipe.calories}</b> kcal each</span>`,
  ].join("\n      ");

  // `scalable: false` in frontmatter opts a recipe out (e.g. its ingredient list already gives amounts per number of people).
  // Otherwise every amount is a `.qty` the servings selector rescales, written straight from the data.
  const ingredients = ingredientsOf(recipe);
  const scalable = recipe.scalable !== false && hasAmounts(ingredients);
  // Hidden until servings.js runs, so the page reads normally with JS disabled.
  // servings.js opens the page at the pressed option: 4 servings, like the shopping page.
  const servingOptions = [...new Set([1, 2, 4, Number(recipe.serves)])].sort((a, b) => a - b);
  const servingsPicker = scalable
    ? `
      <div class="servings-picker" data-base="${recipe.serves}" hidden>
        <span class="servings-label" id="servings-label">Serves</span>
        <div class="seg" role="group" aria-labelledby="servings-label">
          ${servingOptions
            .map((n) => `<button type="button" data-serves="${n}" aria-pressed="${n === DEFAULT_SERVINGS}">${n}</button>`)
            .join("\n          ")}
        </div>
      </div>`
    : "";
  // The ingredients (rendered from the data) beside the rest of the body, so wide screens can show them side by side: the ingredients as
  // a sticky pane with its own scroll, the instructions in the page's scroll (see `.recipe-body` in style.css). Narrow screens stack them.
  const list = ingredients.length
    ? `<ul>\n${ingredients.map((i) => `<li>${ingredientHtml(i, { scalable })}</li>`).join("\n")}\n</ul>`
    : "<p>Ingredients not yet recorded.</p>";
  const bodyHtmlOut = `<div class="recipe-body">
<section class="recipe-ingredients">
<h2>Ingredients</h2>
${list}
</section>
<div class="recipe-steps">
${bodyHtml}</div>
</div>
`;

  const content = `  <main>
    <a class="back-link" href="../index.html"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All recipes</a>
    <header class="recipe-head">
      <p class="kicker">${kicker}</p>
      <h1 class="recipe-title">${escapeHtml(recipe.title)}</h1>
${recipe.draft === true ? `      <p class="recipe-lede">A draft: we haven't tried it enough yet to call it a favourite.</p>\n` : ""}    </header>
    <img class="recipe-hero" src="../${recipe.image.replace(/^\//, "")}" alt="${escapeHtml(recipe.title)}">
    <div class="recipe-meta">
      ${meta}
    </div>
    <div class="cook-bar" hidden>${servingsPicker}
      <div class="cook-actions"></div>
    </div>
${bodyHtmlOut}
  </main>${scalable ? '\n  <script src="../servings.js" defer></script>' : ""}
  <script src="../wakelock.js" defer></script>
  <script type="application/json" id="cook-recipe">${cookJson(recipe, scalable)}</script>
  <script src="../cook-claude.js" defer></script>`;

  return layout({
    title: `${recipe.title} — Our Favourite Recipes`,
    bodyClass: "recipe-page",
    content,
    rootPrefix: "../",
    pageContext: { page: "recipe", slug: recipe.slug, title: recipe.title },
  });
}

module.exports = { renderRecipe, recipePlainText };
