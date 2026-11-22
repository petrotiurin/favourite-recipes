// What the recipe page hands to the "Cook with Claude" island (src/islands/CookClaude.tsx, prompt in cook-prompt.ts) as props: the recipe as plain text.
import { ingredientGroups, ingredientText, type Ingredient } from "../../shared/ingredient-line.ts";
import type { RecipeFrontmatter } from "../../shared/recipe.ts";

type Cookable = Pick<RecipeFrontmatter, "title" | "slug" | "serves" | "total_mins" | "calories"> & { ingredients: readonly Ingredient[]; body?: string };

/**
 * The recipe as plain text for the "Cook with Claude" prompt: the ingredient lines rendered from the data, then the Markdown body
 * without bold, links or heading marks, so it reads cleanly in a chat.
 */
export function recipePlainText(recipe: Cookable): string {
  const facts = `Serves ${recipe.serves} · ${recipe.total_mins} min · ${recipe.calories} kcal per serving`;
  const ingredients = recipe.ingredients ?? [];
  const lines = ingredientGroups(ingredients)
    .map((g) => `${g.section ? `${g.section}:\n` : ""}${g.items.map((i) => `- ${ingredientText(i)}`).join("\n")}`)
    .join("\n\n");
  const list = `Ingredients\n\n${ingredients.length ? lines : "Not recorded yet."}`;
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

/** The island's props: the page's title and slug, how many it serves, whether the servings selector is on, and the text. */
export function cookRecipe(recipe: Cookable, scalable: boolean) {
  return { title: recipe.title, slug: recipe.slug, serves: Number(recipe.serves), scalable, text: recipePlainText(recipe) };
}
