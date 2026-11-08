// Photos for staged recipes (docs/chatbot-design.md 7.1 "Photos are generated when a recipe is staged"): the source page's own photo when
// the model gave a link (og:image / JSON-LD image), else a generated one (OpenRouter, lib/image-generation.js). Both come out as the
// site's normalised JPEG (lib/images.js), ready to be committed as images/recipes/<slug>.jpg at Save.
//
// Fetching a URL the MODEL chose is an SSRF risk, so it is locked down: public http(s) only (ports 80/443), no credentials in the URL,
// no localhost or private, link-local, loopback or reserved addresses (checked on the name's DNS answers, and again on every redirect),
// short timeouts and hard size caps. The same guard is meant for the phase 5 `fetch_url` tool.
import dns from "node:dns/promises";
import net from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { CARD_ASPECT } from "./config.js";
import { normalizeImage } from "./images.js";
import { generateDishImage } from "./image-generation.js";

const MAX_HTML_BYTES = 1_500_000;
const MAX_SCANNED_HTML = 256 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const UA = "Mozilla/5.0 (compatible; favourite-recipes-chat)";

/** Replaceable in tests: how a hostname is resolved. Must resolve to [{ address }]. */
export const deps = {
  lookup: (host) => dns.lookup(host, { all: true, verbatim: true }),
  // How a checked URL is fetched: the default connects to the checked address itself (pinnedGet). Tests and the dev harness swap in the global fetch.
  get: (url, address, init) => pinnedGet(url, address, init),
};

export class UnsafeUrlError extends Error {}

/** The 16 bytes of an IPv6 address (`::` expanded, an embedded dotted IPv4 tail handled), or null if it doesn't parse. */
function ipv6Bytes(address) {
  let a = address.toLowerCase().split("%")[0];
  const tail = a.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) a = a.slice(0, tail.index) + (((+tail[1] << 8) | +tail[2]).toString(16)) + ":" + (((+tail[3] << 8) | +tail[4]).toString(16));
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

/** True for an address that isn't on the public internet (private, loopback, link-local, CGNAT, multicast, reserved, mapped, tunnelled). */
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
    const x = ipv6Bytes(address);
    if (!x) return true;
    const zeros = (n) => x.slice(0, n).every((v) => v === 0);
    if (zeros(12)) return true; // ::/96: unspecified, loopback and IPv4-compatible
    if (zeros(10) && x[10] === 255 && x[11] === 255) return isPrivateAddress(x.slice(12).join(".")); // ::ffff:a.b.c.d (mapped)
    if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b && x.slice(4, 12).every((v) => v === 0)) return true; // 64:ff9b::/96 (NAT64: embeds any IPv4)
    return (
      (x[0] & 0xfe) === 0xfc || // fc00::/7 unique local
      (x[0] === 0xfe && (x[1] & 0xc0) >= 0x80) || // fe80::/10 link-local and fec0::/10 site-local (fe80-febf, fec0-feff)
      x[0] === 0xff || // multicast
      (x[0] === 0x20 && x[1] === 0x02) || // 2002::/16 6to4
      (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0 && x[3] === 0) || // 2001::/32 Teredo
      (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) // 2001:db8::/32 documentation
    );
  }
  return true; // not an address at all
}

/**
 * Checks `url` is a public http(s) URL and returns { url (parsed), address (the one public address to connect to) }. Every address the name
 * resolves to must be public. The caller connects to `address` itself (see pinnedGet), so the name can't resolve differently a moment later.
 */
export async function resolvePublic(url) {
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
    return { url: u, address: host };
  }
  let answers;
  try {
    answers = await deps.lookup(host);
  } catch {
    throw new UnsafeUrlError("that host couldn't be found");
  }
  if (!answers?.length || answers.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("that address isn't public");
  return { url: u, address: answers[0].address };
}

/** Throws UnsafeUrlError unless `url` is a public http(s) URL. Returns the parsed URL. */
export async function assertPublicUrl(url) {
  return (await resolvePublic(url)).url;
}

/**
 * One GET that connects to `address` (already checked) whatever the name would resolve to now: the TLS name and Host header stay the URL's.
 * Resolves a Web Response (status, headers, streaming body). Aborts after timeoutMs, body included.
 */
export function pinnedGet(url, address, { headers, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const https = url.protocol === "https:";
    const req = (https ? httpsRequest : httpRequest)(
      url,
      { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs), lookup: (_host, _opts, cb) => (_opts?.all ? cb(null, [{ address, family: net.isIP(address) }]) : cb(null, address, net.isIP(address))) },
      (res) => {
        const nullBody = [101, 204, 205, 304].includes(res.statusCode) || (res.statusCode >= 300 && res.statusCode < 400);
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }));
      }
    );
    req.on("error", reject);
    req.end();
  });
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
  let target = await resolvePublic(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const current = target.url;
    const res = await deps.get(current, target.address, { headers: { "User-Agent": UA, Accept: accept }, timeoutMs: FETCH_TIMEOUT_MS });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel?.().catch(() => {});
      target = await resolvePublic(new URL(res.headers.get("location"), current).href); // each hop is checked and pinned again
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
  html = html.slice(0, MAX_SCANNED_HTML); // meta tags and JSON-LD live at the top; don't run regexes over a megabyte of body
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
