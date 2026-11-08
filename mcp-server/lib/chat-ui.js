// The chat's UI tools (docs/chatbot-design.md 6, 6.1): show_recipes, offer_navigation and the action chips of suggest_replies.
// They never touch the repo; they only decide what the BROWSER shows. Everything the browser gets is built here from server data
// (our recipe files, the site's own URL pattern), never from model text, and every URL is on the site's origin by construction:
// the model can only name a slug or a page key, and anything unknown is dropped.
import { config } from "./config.js";
import { recipeSummaries } from "./recipes.js";

export const MAX_CARDS = 8;
const MAX_LABEL = 40;

/** The site pages the chat may send someone to. The key is what the model (and a chip's action) names. */
export const PAGES = {
  index: { path: "", label: "Open all recipes" },
  "next-week": { path: "next-week.html", label: "Open next week" },
  shopping: { path: "shopping-list.html", label: "Open the shopping list" },
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const clean = (s, max) => String(s ?? "").replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A URL on the site, from config.siteUrl and a path we wrote; throws if it would ever leave the site's origin. */
export function siteUrl(path = "") {
  const url = new URL(path ? `${config.siteUrl}/${path}` : `${config.siteUrl}/`);
  if (url.origin !== new URL(config.siteUrl).origin) throw new Error("not on the site's origin");
  return url.href;
}

/** The book as a Map(slug -> summary), loaded once per chat turn. An unreadable repo gives an empty book (nothing resolves). */
export async function loadBook() {
  try {
    return new Map((await recipeSummaries()).map((r) => [r.slug, r]));
  } catch (err) {
    console.error("Couldn't load the book for the chat's UI tools:", err.message);
    return new Map();
  }
}

/**
 * Resolves what the model named to a site URL, or null. `target` is a page key ("index", "next-week", "shopping"), a recipe slug
 * that exists in the book, or { slug } / { page } of the same. URLs, other schemes and unknown names all give null.
 */
export function resolveTarget(book, target) {
  const key = typeof target === "string" ? target : target && typeof target === "object" ? (typeof target.slug === "string" ? target.slug : target.page) : undefined;
  if (typeof key !== "string") return null;
  if (Object.hasOwn(PAGES, key)) return { kind: "page", key, url: siteUrl(PAGES[key].path), label: PAGES[key].label };
  if (!SLUG.test(key) || !book.has(key)) return null;
  const r = book.get(key);
  return { kind: "recipe", key, slug: key, url: siteUrl(`recipes/${key}.html`), label: `Open ${clean(r.title, MAX_LABEL - 5)}` };
}

// --- show_recipes ---------------------------------------------------------------------------------------------------

/** One card, from the recipe's own data. kicker.kind picks the colour (this: accent, next: teal, draft: purple, none: muted). */
export function cardFor(r) {
  const kicker = r.current ? { kind: "this", label: "This week" } : r.next ? { kind: "next", label: "Next week" } : r.draft ? { kind: "draft", label: "Draft" } : { kind: "", label: (r.course || []).join(" · ") };
  const meta = [Number.isFinite(r.total_mins) ? `${r.total_mins} min` : "", Number.isFinite(r.calories) ? `${r.calories} kcal` : ""].filter(Boolean).join(" · ");
  const image = typeof r.image === "string" && r.image.startsWith("/images/") ? new URL(`${config.siteUrl}${r.image}`).href : "";
  return { slug: r.slug, title: clean(r.title, 120), image, kicker, meta, url: siteUrl(`recipes/${r.slug}.html`) };
}

/** { cards, dropped }: unknown or malformed slugs are dropped, duplicates collapse, at most MAX_CARDS. */
export function buildCards(book, slugs) {
  const cards = [];
  const dropped = [];
  const seen = new Set();
  for (const slug of Array.isArray(slugs) ? slugs : []) {
    if (typeof slug !== "string" || seen.has(slug)) continue;
    seen.add(slug);
    if (!SLUG.test(slug) || !book.has(slug)) dropped.push(String(slug).slice(0, 80));
    else if (cards.length < MAX_CARDS) cards.push(cardFor(book.get(slug)));
  }
  return { cards, dropped };
}

// --- offer_navigation -----------------------------------------------------------------------------------------------

/** { label, url } for a button, or null when the target is unknown. The model's label is tidied; the default is "Open <title>". */
export function buildNavigation(book, { slug, page, label } = {}) {
  const target = resolveTarget(book, slug !== undefined ? { slug } : { page });
  if (!target) return null;
  return { label: clean(label, MAX_LABEL) || target.label, url: target.url };
}

// --- suggest_replies ------------------------------------------------------------------------------------------------

const MAX_REPLY_CHARS = 30;

/**
 * Cleans what the model passed to suggest_replies: short, single-line, no emoji, at most 4. A reply is a string (sent as the user's
 * next message) or { label, action: { navigate } }, which becomes { label, url }; an action that doesn't resolve drops the reply.
 */
export const PLAN_ACTIONS = new Set(["apply_plan", "finalise_plan"]);

export function cleanReplyList(replies, book, { editor = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(replies) ? replies : []) {
    const isAction = r && typeof r === "object";
    const text = clean(isAction ? r.label : r, MAX_REPLY_CHARS * 2);
    if (typeof (isAction ? r.label : r) !== "string" || !text || text.length > MAX_REPLY_CHARS || seen.has(text.toLowerCase())) continue;
    if (isAction && editor && typeof r.action === "string" && PLAN_ACTIONS.has(r.action)) {
      out.push({ label: text, action: r.action }); // a chip that presses the tray's own button (a human tap): Finalise list, Save to site
      seen.add(text.toLowerCase());
      if (out.length === 4) break;
      continue;
    }
    if (isAction) {
      const target = book && resolveTarget(book, r.action?.navigate);
      if (!target) continue;
      out.push({ label: text, url: target.url });
    } else out.push(text);
    seen.add(text.toLowerCase());
    if (out.length === 4) break;
  }
  return out;
}

// --- ask_user ------------------------------------------------------------------------------------------------------------

/** A question that needs an answer: { question, options (2-6 short, distinct), multi }, or null when it isn't usable. */
export function cleanQuestion(args) {
  const question = clean(args?.question, 240);
  const options = [];
  for (const o of Array.isArray(args?.options) ? args.options : []) {
    const text = clean(o, MAX_REPLY_CHARS * 2);
    if (typeof o === "string" && text && text.length <= MAX_REPLY_CHARS && !options.some((x) => x.toLowerCase() === text.toLowerCase())) options.push(text);
    if (options.length === 6) break;
  }
  return question && options.length >= 2 ? { question, options, multi: args?.multi === true } : null;
}
