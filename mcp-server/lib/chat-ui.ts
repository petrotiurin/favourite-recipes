// The chat's UI tools (docs/chatbot-design.md 6, 6.1): show_recipes, offer_navigation and the action chips of suggest_replies.
// They never touch the repo; they only decide what the BROWSER shows. Everything the browser gets is built here from server data
// (our recipe files, the site's own URL pattern), never from model text, and every URL is on the site's origin by construction:
// the model can only name a slug or a page key, and anything unknown is dropped.
import { config } from "./config.ts";
import { recipeSummaries } from "./recipes.ts";
import { errorMessage } from "./errors.ts";
import type { RecipeSummary } from "./types/recipe.ts";
import type { RecipeCard, Suggestion } from "./types/chat.ts";

/** An object whose keys are looked at one by one (what JSON.parse and the model give us is `unknown` until it is). */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `name` of whatever was thrown (an AbortError, a TimeoutError), or undefined. */
export const errorName = (err: unknown): unknown => (typeof err === "object" && err !== null && "name" in err ? err.name : undefined);

/** The book as the chat's UI tools see it. */
export type Book = Map<string, RecipeSummary>;

/** A button's target: one of the site's pages, or one recipe of the book. */
export type Target = { kind: "page"; key: string; url: string; label: string } | { kind: "recipe"; key: string; slug: string; url: string; label: string };

export const MAX_CARDS = 8;
const MAX_LABEL = 40;

/** The site pages the chat may send someone to. The key is what the model (and a chip's action) names. */
export const PAGES: Record<string, { path: string; label: string; }> = {
  index: { path: "", label: "Open all recipes" },
  "next-week": { path: "next-week.html", label: "Open next week" },
  shopping: { path: "shopping-list.html", label: "Open the shopping list" },
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const clean = (s: unknown, max: number): string => String(s ?? "").replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A URL on the site, from config.siteUrl and a path we wrote; throws if it would ever leave the site's origin. */
export function siteUrl(path = "") {
  const url = new URL(path ? `${config.siteUrl}/${path}` : `${config.siteUrl}/`);
  if (url.origin !== new URL(config.siteUrl).origin) throw new Error("not on the site's origin");
  return url.href;
}

/** The book as a Map(slug -> summary), loaded once per chat turn. An unreadable repo gives an empty book (nothing resolves). */
export async function loadBook(): Promise<Book> {
  try {
    return new Map((await recipeSummaries()).map((r) => [r.slug, r]));
  } catch (err) {
    console.error("Couldn't load the book for the chat's UI tools:", errorMessage(err));
    return new Map();
  }
}

/**
 * Resolves what the model named to a site URL, or null. `target` is a page key ("index", "next-week", "shopping"), a recipe slug
 * that exists in the book, or { slug } / { page } of the same. URLs, other schemes and unknown names all give null.
 */
export function resolveTarget(book: Book, target: unknown): Target | null {
  const key = typeof target === "string" ? target : isRecord(target) ? (typeof target.slug === "string" ? target.slug : target.page) : undefined;
  if (typeof key !== "string") return null;
  if (Object.hasOwn(PAGES, key)) return { kind: "page", key, url: siteUrl(PAGES[key].path), label: PAGES[key].label };
  const r = book.get(key);
  if (!SLUG.test(key) || !r) return null;
  return { kind: "recipe", key, slug: key, url: siteUrl(`recipes/${key}.html`), label: `Open ${clean(r.title, MAX_LABEL - 5)}` };
}

// --- show_recipes ---------------------------------------------------------------------------------------------------

/** One card, from the recipe's own data. kicker.kind picks the colour (this: accent, next: teal, draft: purple, none: muted). */
export function cardFor(r: Pick<RecipeSummary, "slug" | "title" | "image" | "course" | "total_mins" | "calories" | "current" | "next" | "draft">): RecipeCard {
  const kicker: RecipeCard["kicker"] = r.current ? { kind: "this", label: "This week" } : r.next ? { kind: "next", label: "Next week" } : r.draft ? { kind: "draft", label: "Draft" } : { kind: "", label: (r.course || []).join(" · ") };
  const meta = [Number.isFinite(r.total_mins) ? `${r.total_mins} min` : "", Number.isFinite(r.calories) ? `${r.calories} kcal` : ""].filter(Boolean).join(" · ");
  const image = typeof r.image === "string" && r.image.startsWith("/images/") ? new URL(`${config.siteUrl}${r.image}`).href : "";
  return { slug: r.slug, title: clean(r.title, 120), image, kicker, meta, url: siteUrl(`recipes/${r.slug}.html`) };
}

/** { cards, dropped }: unknown or malformed slugs are dropped, duplicates collapse, at most MAX_CARDS. */
export function buildCards(book: Book, slugs: unknown): { cards: RecipeCard[]; dropped: string[] } {
  const cards: RecipeCard[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  const list: unknown[] = Array.isArray(slugs) ? slugs : [];
  for (const slug of list) {
    if (typeof slug !== "string" || seen.has(slug)) continue;
    seen.add(slug);
    const recipe = book.get(slug);
    if (!SLUG.test(slug) || !recipe) dropped.push(slug.slice(0, 80));
    else if (cards.length < MAX_CARDS) cards.push(cardFor(recipe));
  }
  return { cards, dropped };
}

// --- offer_navigation -----------------------------------------------------------------------------------------------

/** { label, url } for a button, or null when the target is unknown. The model's label is tidied; the default is "Open <title>". */
export function buildNavigation(book: Book, { slug, page, label }: { slug?: unknown; page?: unknown; label?: unknown } = {}): { label: string; url: string } | null {
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
export const PLAN_ACTIONS = new Set<string>(["apply_plan", "finalise_plan"]);
type PlanAction = "apply_plan" | "finalise_plan";
const isPlanAction = (a: unknown): a is PlanAction => typeof a === "string" && PLAN_ACTIONS.has(a);
// Chips that press a button which commits or starts work never carry the model's words: the label is fixed here (the panel draws its own
// text too), so an injected or confused model can't dress "Save to site" up as something harmless.
export const PLAN_ACTION_LABELS: Record<PlanAction, string> = { apply_plan: "Save to site", finalise_plan: "Finalise list" };

export function cleanReplyList(replies: unknown, book: Book | null | undefined, { editor = false }: { editor?: boolean } = {}): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const list: unknown[] = Array.isArray(replies) ? replies : [];
  for (const r of list) {
    if (editor && isRecord(r) && isPlanAction(r.action)) {
      const action = r.action;
      if (!out.some((x) => typeof x === "object" && "action" in x && x.action === action)) out.push({ label: PLAN_ACTION_LABELS[action], action });
      if (out.length === 4) break;
      continue;
    }
    const label = isRecord(r) ? r.label : r;
    const text = clean(label, MAX_REPLY_CHARS * 2);
    if (typeof label !== "string" || !text || text.length > MAX_REPLY_CHARS || seen.has(text.toLowerCase())) continue;
    if (isRecord(r)) {
      const target = book && resolveTarget(book, isRecord(r.action) ? r.action.navigate : undefined);
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
export function cleanQuestion(args: unknown): { question: string; options: string[]; multi: boolean } | null {
  const a: Record<string, unknown> = isRecord(args) ? args : {};
  const question = clean(a.question, 240);
  const options: string[] = [];
  const given: unknown[] = Array.isArray(a.options) ? a.options : [];
  for (const o of given) {
    const text = clean(o, MAX_REPLY_CHARS * 2);
    if (typeof o === "string" && text && text.length <= MAX_REPLY_CHARS && !options.some((x) => x.toLowerCase() === text.toLowerCase())) options.push(text);
    if (options.length === 6) break;
  }
  return question && options.length >= 2 ? { question, options, multi: a.multi === true } : null;
}
