// "Cook with Claude" on recipe pages: the prompt of a link that opens a new Claude chat (claude.ai/new?q=...), holding the whole recipe scaled to
// the servings picked and asking Claude to guide the cook through the ingredients and then the steps, one at a time. It's a plain link the
// user taps, never a fetch: the site makes no call to Claude. The recipe text comes from the build (`cookRecipe` in recipe-text.ts), so it works
// for anyone with a Claude account; with the Favourite recipes connector Claude can re-read it.

export interface CookRecipe {
  title: string;
  slug: string;
  /** How many the recipe's own amounts are for. */
  serves: number;
  /** The recipe as plain text (`recipePlainText`). */
  text: string;
}

/** The prompt for `n` people, or for no number picked (a recipe with no picker): Claude asks first. `pageUrl` is the recipe's page. */
export function cookPrompt(recipe: CookRecipe, n: number | null, pageUrl: string): string {
  const lines: string[] = [];
  if (n) {
    lines.push(
      `We're cooking "${recipe.title}" for ${n}${n === 1 ? " person" : " people"}. ` +
        "The full recipe is below; work from it" +
        (n === recipe.serves ? ` (its amounts are already for ${n}).` : ` and scale every amount from ${recipe.serves} servings to ${n}.`),
    );
  } else {
    lines.push(
      `We're cooking "${recipe.title}". The full recipe is below; work from it. ` +
        "Ask me how many people I'm cooking for first if the amounts depend on it.",
    );
  }
  lines.push(
    '1. Ingredients first: go through them one at a time so I can get each one out. Wait for me to say "got it" before the next. ' +
      'Only with the first one, tell me to say "got it" when I have it; after that just name each ingredient, without repeating that.\n' +
      "2. Then the method, one step at a time. Tell me when a step needs a timer and how long, and wait for me before moving on.\n" +
      "3. In every step, say how much of each ingredient it uses, even when the step itself doesn't: take the amounts from the ingredient list" +
      (n && n !== recipe.serves ? `, scaled to ${n}` : "") +
      '. For example, if the step says "mix the soy sauce with the ginger paste" and the list has 2 tsp soy sauce and 2 tbsp ginger paste, ' +
      'say "mix 2 tsp soy sauce with 2 tbsp ginger paste". If an ingredient is split across steps, say how much goes in this one (or "the rest").',
  );
  lines.push("Keep every reply short and easy to follow by voice. I'm cooking, so my hands are busy.");
  lines.push(
    `If you have the Favourite recipes connector and need to check the recipe again, read it with get_recipe (slug: ${recipe.slug}). ` +
      `Otherwise the text below is all you need. Its page: ${pageUrl}`,
  );
  lines.push(`--- Recipe: ${recipe.title} ---\n${recipe.text}`);
  return lines.join("\n\n");
}

/** The link that opens it in a new Claude chat. */
export const cookLink = (recipe: CookRecipe, n: number | null, pageUrl: string): string =>
  `https://claude.ai/new?q=${encodeURIComponent(cookPrompt(recipe, n, pageUrl))}`;
