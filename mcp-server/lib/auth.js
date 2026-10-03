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
