// Photos for staged recipes (docs/chatbot-design.md 7.1 "Photos are generated when a recipe is staged"): the source page's own photo when
// the model gave a link (og:image / JSON-LD image), else a generated one (OpenRouter, lib/image-generation.js). Both come out as the
// site's normalised JPEG (lib/images.js), ready to be committed as images/recipes/<slug>.jpg at Save.
//
// Fetching a URL the MODEL chose is an SSRF risk, so it is locked down: public http(s) only (ports 80/443), no credentials in the URL,
// no localhost or private, link-local, loopback or reserved addresses (checked on the name's DNS answers, and again on every redirect),
// short timeouts and hard size caps. The same guard is meant for the phase 5 `fetch_url` tool.
import dns from "node:dns/promises";
import net from "node:net";
import { CARD_ASPECT } from "./config.js";
import { normalizeImage } from "./images.js";
import { generateDishImage } from "./image-generation.js";

const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const UA = "Mozilla/5.0 (compatible; favourite-recipes-chat)";

/** Replaceable in tests: how a hostname is resolved. Must resolve to [{ address }]. */
export const deps = { lookup: (host) => dns.lookup(host, { all: true, verbatim: true }) };

export class UnsafeUrlError extends Error {}

/** True for an address that isn't on the public internet (private, loopback, link-local, CGNAT, multicast, reserved, mapped). */
export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const a = address.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = a.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("2001:db8");
  }
  return true; // not an address at all
}

/** Throws UnsafeUrlError unless `url` is a public http(s) URL. Returns the parsed URL. */
export async function assertPublicUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new UnsafeUrlError("that isn't a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeUrlError("only http(s) links can be fetched");
  if (u.username || u.password) throw new UnsafeUrlError("links with a username or password aren't fetched");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("only the standard web ports are fetched");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal|localdomain|lan|home|corp)$/.test(host)) throw new UnsafeUrlError("that address isn't public");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("that address isn't public");
    return u;
  }
  let answers;
  try {
    answers = await deps.lookup(host);
  } catch {
    throw new UnsafeUrlError("that host couldn't be found");
  }
  if (!answers?.length || answers.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("that address isn't public");
  return u;
}

async function readLimited(res, max) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > max) throw new Error("the file is too large");
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > max) throw new Error("the file is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** GETs a public URL, following at most MAX_REDIRECTS redirects (each one checked), with a time and size limit. Returns { buffer, type, url }. */
export async function fetchPublic(url, { accept = "*/*", maxBytes }) {
  let current = await assertPublicUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel?.().catch(() => {});
      current = await assertPublicUrl(new URL(res.headers.get("location"), current).href);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { buffer: await readLimited(res, maxBytes), type: (res.headers.get("content-type") || "").toLowerCase(), url: current.href };
  }
  throw new Error("too many redirects");
}

const decodeEntities = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** The dish photo URL a recipe page advertises: og:image / twitter:image, else the image of its JSON-LD Recipe. Resolved against the page URL. */
export function pageImageUrl(html, pageUrl) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const content = (tag) => decodeEntities(tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find((x) => x !== undefined) || "");
  const prop = (tag) => (tag.match(/\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.slice(1).find((x) => x !== undefined) || "").toLowerCase();
  const candidates = [];
  for (const wanted of ["og:image:secure_url", "og:image", "twitter:image"]) {
    for (const tag of metas) if (prop(tag) === wanted && content(tag)) candidates.push(content(tag));
  }
  const fromLd = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const types = [].concat(node["@type"] || []).map(String);
      if (types.includes("Recipe")) {
        const img = [].concat(node.image || []).flatMap((i) => (typeof i === "string" ? [i] : i && typeof i.url === "string" ? [i.url] : []));
        fromLd.push(...img);
      }
      if (node["@graph"]) walk(node["@graph"]);
    };
    walk(data);
  }
  for (const c of [...candidates, ...fromLd]) {
    try {
      const u = new URL(c, pageUrl);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * The model gave a link: either straight to a photo, or to the recipe's page (then its og:image / JSON-LD image is used). Returns the
 * normalised JPEG, or throws with a short reason (the caller then generates one instead).
 */
export async function photoFromLink(link) {
  const first = await fetchPublic(link, { accept: "text/html,image/*;q=0.9,*/*;q=0.5", maxBytes: MAX_IMAGE_BYTES });
  let bytes = first.buffer;
  if (!first.type.startsWith("image/")) {
    if (!/html|xml/.test(first.type) && first.type) throw new Error(`the link is ${first.type}, not a page or a photo`);
    const imageUrl = pageImageUrl(first.buffer.subarray(0, MAX_HTML_BYTES).toString("utf8"), first.url);
    if (!imageUrl) throw new Error("the page has no photo (og:image or recipe image)");
    const img = await fetchPublic(imageUrl, { accept: "image/*", maxBytes: MAX_IMAGE_BYTES });
    if (img.type && !img.type.startsWith("image/") && !img.type.startsWith("application/octet-stream")) throw new Error("the page's photo link isn't an image");
    bytes = img.buffer;
  }
  return (await normalizeImage(bytes, { aspect: CARD_ASPECT })).buffer;
}

/**
 * The photo for a staged recipe. With `imageUrl`: the source's own photo; if that fails (or there is none), a generated one. Without: generated.
 * Resolves { buffer, source: "link" | "generated", note? }; rejects only when generation fails too.
 */
export async function makePhoto({ title, ingredients = [], description, imageUrl, regenerate = false }) {
  let note;
  if (imageUrl && !regenerate) {
    try {
      return { buffer: await photoFromLink(imageUrl), source: "link" };
    } catch (err) {
      note = `couldn't use the link's photo (${err instanceof UnsafeUrlError ? err.message : err.message})`;
    }
  }
  const generated = await generateDishImage({ title, ingredients, description });
  return { buffer: (await normalizeImage(generated, { aspect: CARD_ASPECT })).buffer, source: "generated", ...(note ? { note } : {}) };
}
