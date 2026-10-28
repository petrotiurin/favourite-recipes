const { layout } = require("./layout");
const { markScalableQuantities } = require("./quantities");
const { isDraft } = require("./status");

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DEFAULT_SERVINGS = 4;

function renderRecipe(recipe, bodyHtml) {
  // Small-caps line above the name: rotation status, then course and tags.
  const status = isDraft(recipe)
    ? [`<span class="kicker-draft">To try</span>`]
    : recipe.current === true
      ? [`<span class="kicker-current">This week</span>`]
      : [];
  const kicker = [...status, ...[...(recipe.course || []), ...(recipe.tags || [])].map(escapeHtml)].join(" &middot; ");
  const meta = [
    `<span><b>${recipe.total_mins}</b> min</span>`,
    `<span class="serves-chip">Serves <b>${recipe.serves}</b></span>`,
    `<span><b>${recipe.calories}</b> kcal each</span>`,
  ].join("\n      ");

  // `scalable: false` in frontmatter opts a recipe out (e.g. its ingredient list
  // already gives amounts per number of people).
  const { html: scaledBodyHtml, scalable } =
    recipe.scalable === false ? { html: bodyHtml, scalable: false } : markScalableQuantities(bodyHtml);
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
  const body = scaledBodyHtml;
  // Wrap the Ingredients section (up to the next h2) and what follows it, so wide
  // screens can show the ingredients and instructions as two independently scrolling panes
  // (see `.recipe-body` in style.css). Narrow screens stack them as before.
  const ingStart = body.search(/<h2[^>]*>\s*Ingredients\b/i);
  const ingLength = ingStart === -1 ? -1 : body.slice(ingStart + 1).search(/<h2[\s>]/i) + 1;
  const bodyHtmlOut =
    ingLength > 0
      ? `${body.slice(0, ingStart)}<div class="recipe-body">
<section class="recipe-ingredients">
${body.slice(ingStart, ingStart + ingLength)}</section>
<div class="recipe-steps">
${body.slice(ingStart + ingLength)}</div>
</div>
`
      : body;

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
    </div>
${bodyHtmlOut}
  </main>${scalable ? '\n  <script src="../servings.js" defer></script>' : ""}
  <script src="../wakelock.js" defer></script>`;

  return layout({
    title: `${recipe.title} — Our Favourite Recipes`,
    bodyClass: "recipe-page",
    content,
    rootPrefix: "../",
  });
}

module.exports = { renderRecipe };
