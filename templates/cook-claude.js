// "Cook with Claude" on recipe pages: a link that opens a new Claude chat (claude.ai/new?q=...) with a prompt
// holding the whole recipe, scaled to the servings picked in the cook bar, and asking Claude to guide the cook
// through the ingredients and then the steps, one at a time. It's a plain link the user taps, never a fetch:
// the site makes no call to Claude. The recipe text comes from the build (#cook-recipe, see templates/recipe.js),
// so it works for anyone with a Claude account; with the Favourite recipes connector Claude can re-read it.
(function () {
  var bar = document.querySelector(".cook-bar");
  var data = document.getElementById("cook-recipe");
  if (!bar || !data) return;
  var recipe;
  try {
    recipe = JSON.parse(data.textContent);
  } catch (e) {
    return;
  }

  var picker = bar.querySelector(".servings-picker");

  function servings() {
    if (!picker || picker.hidden) return null;
    var pressed = picker.querySelector('button[aria-pressed="true"]');
    var n = pressed ? Number(pressed.getAttribute("data-serves")) : NaN;
    return n > 0 ? n : null;
  }

  function prompt(n) {
    var lines = [];
    if (n) {
      lines.push(
        'We\'re cooking "' + recipe.title + '" for ' + n + (n === 1 ? " person" : " people") + ". " +
          "The full recipe is below; work from it" +
          (n === recipe.serves
            ? " (its amounts are already for " + n + ")."
            : " and scale every amount from " + recipe.serves + " servings to " + n + ".")
      );
    } else {
      lines.push(
        'We\'re cooking "' + recipe.title + '". The full recipe is below; work from it. ' +
          "Ask me how many people I'm cooking for first if the amounts depend on it."
      );
    }
    lines.push(
      "1. Ingredients first: go through them one at a time so I can get each one out. Wait for me to say \"got it\" before the next.\n" +
        "2. Then the method, one step at a time. Tell me when a step needs a timer and how long, and wait for me before moving on."
    );
    lines.push("Keep every reply short and easy to follow by voice. I'm cooking, so my hands are busy.");
    lines.push(
      "If you have the Favourite recipes connector and need to check the recipe again, read it with get_recipe (slug: " +
        recipe.slug + "). Otherwise the text below is all you need. Its page: " + location.href.split("#")[0]
    );
    lines.push("--- Recipe: " + recipe.title + " ---\n" + recipe.text);
    return lines.join("\n\n");
  }

  var ARROW =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

  var link = document.createElement("a");
  link.className = "pill cook-claude";
  link.target = "_blank";
  link.rel = "noopener";
  link.innerHTML = ARROW + "Cook with Claude";
  link.setAttribute("aria-label", "Cook with Claude (opens Claude)");

  function update() {
    link.href = "https://claude.ai/new?q=" + encodeURIComponent(prompt(servings()));
  }

  update();
  // Follow the servings picker (servings.js sets aria-pressed on click; read it after that handler has run),
  // and refresh once more on the tap itself, before the browser follows the link.
  if (picker) picker.addEventListener("click", function () { setTimeout(update, 0); });
  link.addEventListener("click", update);

  (bar.querySelector(".cook-actions") || bar).appendChild(link);
  bar.hidden = false;
})();
