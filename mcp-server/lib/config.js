// All configuration comes from Vercel environment variables.
export const config = {
  githubToken: process.env.GITHUB_TOKEN,
  repo: process.env.GITHUB_REPO || "petrotiurin/favourite-recipes",
  branch: process.env.GITHUB_BRANCH || "main",
  authToken: process.env.MCP_AUTH_TOKEN,
  siteUrl: (process.env.PUBLIC_SITE_URL || "https://petrotiurin.github.io/favourite-recipes").replace(/\/$/, ""),
};

export function assertConfigured() {
  const missing = [];
  if (!config.githubToken) missing.push("GITHUB_TOKEN");
  if (!config.authToken) missing.push("MCP_AUTH_TOKEN");
  if (missing.length) {
    throw new Error(`Server is missing environment variables: ${missing.join(", ")}`);
  }
}

export const SHOPPING_LIST_PATH = "shopping-list.json";
export const COURSES = ["Breakfast", "Lunch", "Dinner", "Snack", "Drink"];
export const MAX_IMAGE_EDGE = 1600;
