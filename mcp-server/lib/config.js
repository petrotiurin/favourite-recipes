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
  // EDITORS is the one editors list (SHOPPING_EDITORS is its old name, still read as a fallback).
  // Supabase service-role key: server only (rate-limit counters now, chats and the tray later). Never sent to the browser.
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  // The chat (docs/chatbot-design.md D3): OpenRouter's OpenAI-compatible API. The public key falls back to OPENROUTER_API_KEY
  // as a convenience for small setups; give it its own key with its own credit limit so photos and chat can't starve each other.
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  chatPublicKey: process.env.OPENROUTER_CHAT_PUBLIC_KEY || process.env.OPENROUTER_API_KEY,
  chatPublicModel: process.env.CHAT_PUBLIC_MODEL || "google/gemini-2.5-flash",
  chatPublicHourlyLimit: Number(process.env.CHAT_PUBLIC_HOURLY_LIMIT) || 20,
  chatPublicDailyLimit: Number(process.env.CHAT_PUBLIC_DAILY_LIMIT) || 100,
  // One cap across ALL visitors together, so many IPs can't add up to a drained public key.
  chatPublicTotalHourlyLimit: Number(process.env.CHAT_PUBLIC_TOTAL_HOURLY_LIMIT) || 300,
  // Failed or repeated sign-in checks per visitor per hour before /chat stops asking Supabase.
  authFailureHourlyLimit: Number(process.env.AUTH_FAILURE_HOURLY_LIMIT) || 20,
  // Longest model reply (tokens) per request.
  chatPublicMaxTokens: Number(process.env.CHAT_PUBLIC_MAX_TOKENS) || 1500,
  chatEditorMaxTokens: Number(process.env.CHAT_EDITOR_MAX_TOKENS) || 4000,
  // Salt for hashing visitor IPs (rate limits, traces). Falls back to the service key, so no raw IP is ever stored either way.
  ipHashSalt: process.env.IP_HASH_SALT,
  // Signed-in editors (phase 3): their own OpenRouter key (falls back to OPENROUTER_API_KEY), model and generous limits, keyed by user id.
  chatEditorKey: process.env.OPENROUTER_CHAT_EDITOR_KEY || process.env.OPENROUTER_API_KEY,
  chatEditorModel: process.env.CHAT_EDITOR_MODEL || "anthropic/claude-sonnet-4.5",
  chatEditorHourlyLimit: Number(process.env.CHAT_EDITOR_HOURLY_LIMIT) || 200,
  chatPanelHourlyLimit: Number(process.env.CHAT_PANEL_HOURLY_LIMIT) || 600, // the panel's plan / status requests per editor
  chatEditorDailyLimit: Number(process.env.CHAT_EDITOR_DAILY_LIMIT) || 1000,
  // Langfuse tracing: off unless all three are set.
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
  langfuseBaseUrl: (process.env.LANGFUSE_BASE_URL || "").replace(/\/$/, ""),
  shoppingEditors: (process.env.EDITORS || process.env.SHOPPING_EDITORS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
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
  const missing = ["GITHUB_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY", "EDITORS"].filter(
    (name, i) => ![config.githubToken, config.supabaseUrl, config.supabaseAnonKey, config.shoppingEditors.length][i]
  );
  if (missing.length) {
    throw new Error(`Stocktake saving is not set up: missing environment variables ${missing.join(", ")}`);
  }
}

export function assertChatConfigured() {
  const missing = [];
  if (!config.githubToken) missing.push("GITHUB_TOKEN");
  if (!config.chatPublicKey) missing.push("OPENROUTER_CHAT_PUBLIC_KEY");
  if (missing.length) throw new Error(`The chat is not set up: missing environment variables ${missing.join(", ")}`);
}

export const SHOPPING_LIST_PATH = "shopping-list.json";
export const COURSES = ["Breakfast", "Lunch", "Dinner", "Snack", "Drink"];
export const MAX_IMAGE_EDGE = 1600;
export const CARD_ASPECT = 4 / 3; // the index tiles crop to 4:3 (styles/style.css)

let keyWarning = false;
/** Warns once if the chat keys that are meant to be separate (and separately capped) are the same key. */
export function warnSharedKeys() {
  if (keyWarning) return;
  const pairs = [["public chat key", config.chatPublicKey], ["editor chat key", config.chatEditorKey], ["image key", config.openrouterKey]];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      if (pairs[i][1] && pairs[i][1] === pairs[j][1]) {
        keyWarning = true;
        console.warn(`The ${pairs[i][0]} and the ${pairs[j][0]} are the same OpenRouter key: public traffic can spend the other's budget. Give each its own key with its own credit limit.`);
      }
    }
  }
}
