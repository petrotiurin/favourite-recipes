// All configuration comes from Vercel environment variables.
export const config = {
  githubToken: process.env.GITHUB_TOKEN,
  repo: process.env.GITHUB_REPO || "petrotiurin/favourite-recipes",
  branch: process.env.GITHUB_BRANCH || "main",
  authToken: process.env.MCP_AUTH_TOKEN,
  openrouterKey: process.env.OPENROUTER_API_KEY, // only needed for image: { generate: true }
  imageModel: process.env.OPENROUTER_IMAGE_MODEL || "meta/muse-image",
  siteUrl: (process.env.PUBLIC_SITE_URL || "https://petrotiurin.github.io/favourite-recipes").replace(/\/$/, ""),
  // Stocktake saves from the shopping page: the editor signs in with Supabase Auth, and only these emails may save.
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  shoppingEditors: (process.env.SHOPPING_EDITORS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
};

export function assertConfigured() {
  const missing = [];
  if (!config.githubToken) missing.push("GITHUB_TOKEN");
  if (!config.authToken) missing.push("MCP_AUTH_TOKEN");
  if (missing.length) {
    throw new Error(`Server is missing environment variables: ${missing.join(", ")}`);
  }
}

export function assertStocktakeConfigured() {
  const missing = ["GITHUB_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SHOPPING_EDITORS"].filter(
    (name, i) => ![config.githubToken, config.supabaseUrl, config.supabaseAnonKey, config.shoppingEditors.length][i]
  );
  if (missing.length) {
    throw new Error(`Stocktake saving is not set up: missing environment variables ${missing.join(", ")}`);
  }
}

export const SHOPPING_LIST_PATH = "shopping-list.json";
export const COURSES = ["Breakfast", "Lunch", "Dinner", "Snack", "Drink"];
export const MAX_IMAGE_EDGE = 1600;
export const CARD_ASPECT = 4 / 3; // the index tiles crop to 4:3 (styles/style.css)
