// What the chat keeps of anything it is sent (the /chat stream, the editor's stored chats, the visitor's history in localStorage): plain values,
// strings cut to size, links and photos only on this site's origin (staged photos only from Supabase's signed-URL path). The panel draws only
// these, never what came over the wire. The wire's shapes are the zod schemas in shared/chat-events.ts (types only here: no zod in the browser).
import type { Suggestion } from "../../../shared/chat-events.ts";
import { safeHref } from "./render.ts";

export type PlanAction = "apply_plan" | "finalise_plan";
/** A chip under an answer: sent as the next message, a link to a page on this site, or a button that presses one of the tray's own. */
export type Reply = string | { label: string; url: string } | { label: string; action: PlanAction };
export type KickerKind = "this" | "next" | "draft" | "";
export interface Card {
  slug: string;
  publishing: boolean;
  title: string;
  url: string;
  image: string;
  kicker: { kind: KickerKind; label: string };
  meta: string;
}
export interface Nav {
  label: string;
  url: string;
}
export interface Question {
  question: string;
  options: string[];
  multi: boolean;
}
export type ReviewAnswer = "liked" | "remove";
export interface ReviewDraft {
  slug: string;
  title: string;
  url: string;
  image: string;
  meta: string;
  alsoNext: boolean;
  /** Kept on the message, so a redraw keeps the thumbs. */
  answer: ReviewAnswer | "";
}
export interface Review {
  drafts: ReviewDraft[];
}
export interface OptionalItem {
  item: string;
  name: string;
  quantity: string;
  recipes: { slug: string; title: string; image: string }[];
  answer: "drop" | "";
}
export interface OptionalCard {
  items: OptionalItem[];
}
export interface Feedback {
  value: 0 | 1;
  reasons: string[];
  note: string;
}
/** A message as the panel keeps it. `event` is a note from the site (a status line). */
export interface Message {
  role: "user" | "assistant" | "event";
  content: string;
  replies?: Reply[];
  cards?: Card[];
  nav?: Nav | null;
  question?: Question | null;
  review?: Review | null;
  optional?: OptionalCard | null;
  /** An editor's photos (signed URLs, or the local previews of the ones just sent) and their numbers in the chat (photo-7 is 7). */
  images?: string[];
  numbers?: number[];
  turn_id?: string;
  feedback?: Feedback | null;
}

export const PLAN_LABELS: Record<PlanAction, string> = { apply_plan: "Save to site", finalise_plan: "Finalise list" };
const PLAN_ACTIONS: Record<string, boolean> = { apply_plan: true, finalise_plan: true }; // chips that press the tray's own button (a human tap)
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

export const KICKER_CLASSES: Record<KickerKind, string> = { this: "kicker-current", next: "kicker-next", draft: "kicker-draft", "": "" };

/** Suggested replies: a string, { label, url } on this site, or { label, action } for the tray's two buttons (with fixed labels). At most 4. */
export function cleanReplyItems(list: unknown, origin?: string): Reply[] {
  const out: Reply[] = [];
  (Array.isArray(list) ? (list as Suggestion[] | unknown[]) : []).forEach((r) => {
    if (out.length >= 4) return;
    if (typeof r === "string") {
      if (r) out.push(r);
    } else if (isObj(r) && typeof r.action === "string" && PLAN_ACTIONS[r.action] === true) {
      const action = r.action as PlanAction;
      out.push({ label: PLAN_LABELS[action], action }); // fixed text: the model's words never label a button that commits
    } else if (isObj(r) && typeof r.label === "string" && r.label) {
      const href = origin && typeof r.url === "string" ? safeHref(r.url, origin) : null;
      if (href) out.push({ label: r.label.slice(0, 60), url: href });
    }
  });
  return out;
}

/** Recipe cards from the server: strings only, links and photos only on this site's origin, at most 8. */
export function cleanCards(list: unknown, origin: string): Card[] {
  const out: Card[] = [];
  (Array.isArray(list) ? list : []).forEach((c: unknown) => {
    if (out.length >= 8 || !isObj(c) || typeof c.title !== "string" || !c.title) return;
    const url = safeHref(c.url, origin);
    if (!url) return;
    const kicker = isObj(c.kicker) ? c.kicker : null;
    const kind = (kicker && typeof kicker.kind === "string" && own(KICKER_CLASSES, kicker.kind) ? kicker.kind : "") as KickerKind;
    out.push({
      slug: typeof c.slug === "string" && SLUG_RE.test(c.slug) ? c.slug : "",
      publishing: c.publishing === true,
      title: c.title.slice(0, 120),
      url,
      image: typeof c.image === "string" && c.image ? safeHref(c.image, origin) || "" : "",
      kicker: { kind, label: kicker && typeof kicker.label === "string" ? kicker.label.slice(0, 40) : "" },
      meta: typeof c.meta === "string" ? c.meta.slice(0, 40) : "",
    });
  });
  return out;
}

/** A question from ask_user: { question, options (2-6 short strings), multi }, or null. */
export function cleanQuestion(q: unknown): Question | null {
  if (!isObj(q) || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options)) return null;
  const options: string[] = [];
  q.options.forEach((o: unknown) => {
    if (typeof o === "string" && o.trim() && options.length < 6 && options.indexOf(o.trim().slice(0, 40)) === -1) options.push(o.trim().slice(0, 40));
  });
  return options.length >= 2 ? { question: q.question.trim().slice(0, 240), options, multi: q.multi === true } : null;
}

const REVIEW_THUMBS: ReviewAnswer[] = ["liked", "remove"];
const REVIEW_LABELS = { liked: "Liked", remove: "Not for us", keep: "Kept for the coming week" };
const isThumb = (a: unknown): a is ReviewAnswer => REVIEW_THUMBS.indexOf(a as ReviewAnswer) !== -1;

/**
 * The drafts review card (review_drafts / "Promote it"): { drafts: [{ slug, title, url, image, meta, alsoNext, answer }] }, or null. Built by
 * the server from the book; links and photos only on this site's origin, at most 20 rows. answer: "liked" | "remove" | "" (no thumb).
 */
export function cleanReview(r: unknown, origin: string): Review | null {
  if (!isObj(r) || !Array.isArray(r.drafts)) return null;
  const drafts: ReviewDraft[] = [];
  r.drafts.forEach((d: unknown) => {
    if (drafts.length >= 20 || !isObj(d) || typeof d.slug !== "string" || !SLUG_RE.test(d.slug) || typeof d.title !== "string" || !d.title.trim()) return;
    if (drafts.some((x) => x.slug === d.slug)) return;
    drafts.push({
      slug: d.slug,
      title: d.title.trim().slice(0, 120),
      url: (typeof d.url === "string" && safeHref(d.url, origin)) || "",
      image: (typeof d.image === "string" && d.image && safeHref(d.image, origin)) || "",
      meta: typeof d.meta === "string" ? d.meta.slice(0, 40) : "",
      alsoNext: d.also_next === true || d.alsoNext === true,
      answer: isThumb(d.answer) ? d.answer : "",
    });
  });
  return drafts.length ? { drafts } : null;
}

/**
 * The editor's thumbs as their message in the chat: "Liked: A. Not for us: B. Kept for the coming week: C." (a draft with no thumb is kept;
 * the server stores its own copy of the same words).
 */
export function reviewText(review: Review, answers: Record<string, string>): string {
  const groups: string[] = [];
  (["liked", "remove", "keep"] as const).forEach((a) => {
    const titles = review.drafts.filter((d) => (isThumb(answers[d.slug]) ? answers[d.slug] : "keep") === a).map((d) => d.title);
    if (titles.length) groups.push(`${REVIEW_LABELS[a]}: ${titles.join(", ")}.`);
  });
  return groups.join(" ");
}

/** A staged photo (a Supabase signed URL, only from that path) or a photo on this site's origin, else "". */
function photoUrl(u: unknown, origin: string, photoBase?: string): string {
  if (typeof u !== "string" || !u) return "";
  if (photoBase && u.indexOf(`${photoBase}/storage/v1/object/sign/`) === 0) return u;
  return safeHref(u, origin) || "";
}

/**
 * The optional items card (docs/structured-ingredients.md 6): { items: [{ item, name, quantity, recipes: [{ slug, title, image }], answer }] },
 * or null. Built by the server from the tray's list; photos only on this site's origin (or a recipe still in the tray: its staged photo), at
 * most 30 rows. answer: "drop" | "" (ticked = kept).
 */
export function cleanOptional(o: unknown, origin: string, photoBase?: string): OptionalCard | null {
  if (!isObj(o) || !Array.isArray(o.items)) return null;
  const items: OptionalItem[] = [];
  o.items.forEach((i: unknown) => {
    if (items.length >= 30 || !isObj(i) || typeof i.item !== "string" || !SLUG_RE.test(i.item) || typeof i.name !== "string" || !i.name.trim()) return;
    if (items.some((x) => x.item === i.item)) return;
    const recipes: OptionalItem["recipes"] = [];
    (Array.isArray(i.recipes) ? i.recipes : []).forEach((r: unknown) => {
      if (recipes.length >= 6 || !isObj(r) || typeof r.slug !== "string" || !SLUG_RE.test(r.slug)) return;
      recipes.push({ slug: r.slug, title: (typeof r.title === "string" && r.title.trim().slice(0, 120)) || r.slug.replace(/-/g, " "), image: photoUrl(r.image, origin, photoBase) });
    });
    items.push({ item: i.item, name: i.name.trim().slice(0, 60), quantity: typeof i.quantity === "string" ? i.quantity.slice(0, 20) : "", recipes, answer: i.answer === "drop" ? "drop" : "" });
  });
  return items.length ? { items } : null;
}

/** The editor's ticks as their message: "Leaving off: sesame seeds and chilli oil." / "Keeping all the optional items." (the server stores the same words). */
export function optionalText(card: OptionalCard, answers: Record<string, string>): string {
  const off = card.items.filter((i) => answers[i.item] === "drop").map((i) => i.name.toLowerCase());
  if (!off.length) return "Keeping all the optional items.";
  return `Leaving off: ${off.length === 1 ? off[0] : `${off.slice(0, -1).join(", ")} and ${off[off.length - 1]}`}.`;
}

/** A navigation button from the server: { label, url } on this site's origin, or null. */
export function cleanNav(nav: unknown, origin: string): Nav | null {
  if (!isObj(nav) || typeof nav.label !== "string" || !nav.label) return null;
  const url = safeHref(nav.url, origin);
  return url ? { label: nav.label.slice(0, 60), url } : null;
}

export const MAX_STORED = 40; // messages kept in this browser (about 20 exchanges)
export const MAX_SENT = 20; // messages a visitor sends the server each turn
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // a visitor's chat goes after two weeks, as an editor's does on the server

/** The visitor's chat as stored in this browser: { id, updated, messages }; null when it is too old or not a chat. */
export function cleanHistory(raw: unknown, now: number, origin?: string): { id: string | null; updated: unknown; messages: Message[] } | null {
  if (!isObj(raw) || !Array.isArray(raw.messages)) return null;
  if (!(now - Number(raw.updated) < MAX_AGE_MS)) return null;
  const messages: Message[] = [];
  raw.messages.forEach((m: unknown) => {
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return;
    const out: Message = { role: m.role, content: m.content };
    if (m.role === "assistant") {
      const replies = cleanReplyItems(m.replies, origin);
      if (replies.length) out.replies = replies;
      const cards = origin ? cleanCards(m.cards, origin) : [];
      if (cards.length) out.cards = cards;
      const nav = origin ? cleanNav(m.nav, origin) : null;
      if (nav) out.nav = nav;
    }
    if (out.content || out.cards) messages.push(out);
  });
  return { id: typeof raw.id === "string" ? raw.id : null, updated: raw.updated, messages: messages.slice(-MAX_STORED) };
}

/**
 * The history as the server wants it: text only, starting with a user turn, roles alternating. A user message whose reply failed
 * stays visible in the panel, so two user turns can follow each other; they are merged into one here.
 */
export function wellFormed(messages: { role: string; content: string }[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  messages.forEach((m) => {
    if (!m.content) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else if (prev || m.role === "user") out.push({ role: m.role, content: m.content });
  });
  return out;
}

export const FEEDBACK_REASONS = ["Wrong recipe", "Didn't do what I asked", "Wrong amounts", "Too slow", "Something else"];

/** Photo URLs the server signed for an editor's own messages: only the Supabase signed-URL path of the chat-uploads bucket on the site's own project, at most 8. */
export function cleanUploadUrls(list: unknown, base: string): string[] {
  const out: string[] = [];
  (Array.isArray(list) ? list : []).forEach((u: unknown) => {
    if (out.length < 8 && typeof u === "string" && base && u.indexOf(`${base}/storage/v1/object/sign/chat-uploads/`) === 0 && u.length < 1200) out.push(u);
  });
  return out;
}

/** The photo numbers (photo-7) that go with a message's photos, as positive whole numbers; [] when the server sent none or they don't line up. */
export function cleanNumbers(list: unknown, count: number): number[] {
  if (!Array.isArray(list) || list.length !== count) return [];
  for (const n of list) if (typeof n !== "number" || !(n >= 1 && n <= 100000) || Math.floor(n) !== n) return [];
  return list.slice() as number[];
}

export interface PhotoState {
  total: number;
  read: number;
  reading: number;
  active: boolean;
  followUp: boolean;
}
/** The photo reading in a conversation (GET /chat/conversations/:id `photos`): { total, read, reading, active, followUp }, or null when nothing is going on. */
export function cleanPhotos(p: unknown): PhotoState | null {
  if (!isObj(p)) return null;
  const n = (v: unknown) => (typeof v === "number" && v >= 0 && v < 100000 ? Math.floor(v) : 0);
  const out = { total: n(p.total), read: n(p.read), reading: n(p.reading), active: p.active === true, followUp: p.follow_up === true };
  return out.active || out.followUp ? out : null;
}

/** A signed-in editor's chat as the server returns it (GET /chat/conversations/:id): same cleaning as the local history, plus the turn id and feedback. */
export function cleanServerMessages(list: unknown, origin: string, photoBase = ""): Message[] {
  const out: Message[] = [];
  (Array.isArray(list) ? list : []).forEach((m: unknown) => {
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant" && m.role !== "event") || typeof m.content !== "string") return;
    if (m.role === "event") {
      // a note from the site ("Photos read: 5 recipes, 1 to check"): a status line in the conversation, plain text
      if (m.content.trim()) out.push({ role: "event", content: m.content.trim().slice(0, 300) });
      return;
    }
    const msg: Message = { role: m.role, content: m.content };
    if (m.role === "user") {
      const photos = cleanUploadUrls(m.images, photoBase);
      if (photos.length) {
        msg.images = photos;
        const nums = cleanNumbers(m.photo_numbers, photos.length);
        if (nums.length) msg.numbers = nums;
      }
    }
    if (m.role === "assistant") {
      const replies = cleanReplyItems(m.replies, origin);
      if (replies.length) msg.replies = replies;
      const question = cleanQuestion(m.question);
      if (question) msg.question = question;
      const review = cleanReview(m.review, origin);
      if (review) msg.review = review;
      const optional = cleanOptional(m.optional, origin, photoBase);
      if (optional) msg.optional = optional;
      const cards = cleanCards(m.cards, origin);
      if (cards.length) msg.cards = cards;
      const nav = cleanNav(m.nav, origin);
      if (nav) msg.nav = nav;
      if (typeof m.turn_id === "string" && m.turn_id) msg.turn_id = m.turn_id.slice(0, 64);
      const fb = isObj(m.feedback) ? m.feedback : null;
      if (fb && (fb.value === 1 || fb.value === 0)) {
        msg.feedback = {
          value: fb.value,
          reasons: (Array.isArray(fb.reasons) ? fb.reasons : []).filter((r: unknown) => FEEDBACK_REASONS.indexOf(r as string) !== -1) as string[],
          note: typeof fb.note === "string" ? fb.note.slice(0, 300) : "",
        };
      }
    }
    if (msg.content || msg.cards || msg.question || msg.review || msg.optional || msg.images) out.push(msg);
  });
  return out;
}
