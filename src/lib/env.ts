// What the build reads from the environment: public values, passed in by the deploy workflow from the repo's Actions variables
// (.github/workflows/deploy.yml). Each feature appears only on builds that have its values.

/** The chat widget: only on builds that know where the chat API lives (CHAT_API_URL). `publicOff` is CHAT_PUBLIC=false: the bubble is only shown to signed-in visitors (the server's CHAT_PUBLIC_ENABLED is what enforces it). */
export function chatConfig(env: NodeJS.ProcessEnv = process.env): { api: string; publicOff: boolean } | null {
  const api = env.CHAT_API_URL;
  if (!api) return null;
  return { api: String(api), publicOff: /^(false|0|off|no)$/i.test(String(env.CHAT_PUBLIC ?? "true").trim()) };
}

/** Sign-in (templates/auth.cjs): on every page of a build that has the Supabase values, so the chat and the shopping page share one session. */
export function authConfig(env: NodeJS.ProcessEnv = process.env): { supabaseUrl: string; supabaseKey: string } | null {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return { supabaseUrl: SUPABASE_URL.replace(/\/$/, ""), supabaseKey: SUPABASE_ANON_KEY };
}

/**
 * The shopping page's stocktake editor: Supabase Auth (magic-link sign-in) plus the MCP server's /stocktake endpoint. All three are
 * public values; without them the page is read-only.
 */
export function stocktakeAuth(env: NodeJS.ProcessEnv = process.env): { supabaseUrl: string; supabaseKey: string; api: string } | null {
  const auth = authConfig(env);
  if (!auth || !env.STOCKTAKE_API_URL) return null;
  return { ...auth, api: env.STOCKTAKE_API_URL };
}
