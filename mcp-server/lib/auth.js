import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Accepts the shared secret as "Authorization: Bearer <token>" (Claude Code,
 * Cursor, etc.) or as "?key=<token>" in the URL (for clients like claude.ai
 * custom connectors that only take a URL).
 */
export function isAuthorized(request) {
  if (!config.authToken) return false;
  const header = request.headers.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = new URL(request.url).searchParams.get("key");
  return [bearer, key].some((t) => t && safeEqual(t, config.authToken));
}

// Upload links are capability URLs: an HMAC-signed {items, exp} so a person can
// open them on their phone without knowing the MCP secret. One link can cover
// several recipes; it can only ever write images/recipes/<slug>.jpg (plus that
// recipe's image frontmatter) for the slugs it lists.
function sign(payload) {
  return createHmac("sha256", `upload-link:${config.authToken}`).update(payload).digest("base64url");
}

/** items: [{ slug, label }], label being what the page shows (the recipe title). */
export function createUploadToken(items, ttlMinutes = 60) {
  const payload = Buffer.from(JSON.stringify({ items, exp: Date.now() + ttlMinutes * 60_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns { items: [{ slug, label }], exp } for a valid, unexpired token, else null. */
export function verifyUploadToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || !config.authToken || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!(Date.now() <= data.exp)) return null;
    // Links made before multi-recipe uploads carry a single { slug }.
    const items = Array.isArray(data.items) ? data.items : typeof data.slug === "string" ? [{ slug: data.slug, label: data.slug }] : [];
    const valid = items.filter((i) => typeof i?.slug === "string" && i.slug);
    return valid.length && valid.length === items.length ? { items: valid, exp: data.exp } : null;
  } catch {
    return null;
  }
}

/**
 * Who a Supabase Auth access token belongs to. Supabase checks the token itself (/auth/v1/user), so this works
 * whatever JWT signing keys the project uses. Returns { email, userId, isEditor } (isEditor: the email is in EDITORS,
 * or its old name SHOPPING_EDITORS), or { status, error } when the token is missing, bad or expired (401), or
 * Supabase can't be reached (503). A bad token is never treated as "no token".
 */
export async function verifyUser(request) {
  const token = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { status: 401, error: "Sign in first." };
  if (!config.supabaseUrl || !config.supabaseAnonKey) return { status: 401, error: "Sign-in isn't set up on this server." };
  let res;
  try {
    res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: 503, error: "Couldn't check your sign-in. Try again in a minute." };
  }
  if (!res.ok) return { status: 401, error: "Your sign-in has expired. Sign in again." };
  const user = await res.json();
  const email = String(user?.email || "").toLowerCase();
  return { email, userId: user?.id, isEditor: !!email && config.shoppingEditors.includes(email) };
}

/**
 * The shopping page's editor: a Supabase Auth access token (sign-in on the page) whose email is listed in EDITORS
 * (or its old name SHOPPING_EDITORS). Returns { email, userId }, or { status, error } when refused.
 */
export async function verifyEditor(request) {
  if (!(request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)) return { status: 401, error: "Sign in to save the stocktake." };
  const user = await verifyUser(request);
  if (user.error) return user;
  if (!user.isEditor) return { status: 403, error: `${user.email || "This account"} isn't allowed to edit the shopping list.` };
  return { email: user.email, userId: user.userId };
}

/**
 * The email of a Supabase user, by id, through the Auth admin API (service-role key, server only), lower-cased; null if there is no such
 * user or it can't be asked. The server's own follow-up turn uses it to check that a conversation's owner is still in EDITORS.
 */
export async function userEmail(userId) {
  if (!userId || !config.supabaseUrl || !config.supabaseServiceKey) return null;
  try {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: { apikey: config.supabaseServiceKey, Authorization: `Bearer ${config.supabaseServiceKey}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return String(user?.email || "").toLowerCase() || null;
  } catch {
    return null;
  }
}
