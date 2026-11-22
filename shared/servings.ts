// The two servings numbers the site and the backend share. Their own file, with no imports, so a browser script (the recipe page's servings
// selector) can take them without pulling in zod, which shopping-list.ts needs for its schemas.

// Every quantity on the shopping list is written for BASE_SERVINGS of each recipe; the page and the backend rescale from it. The list's `servings`
// plans each recipe (set by the agent), and a recipe without a plan gets DEFAULT_SERVINGS (which is also where the recipe page's selector opens).
export const BASE_SERVINGS = 2;
export const DEFAULT_SERVINGS = 4;
