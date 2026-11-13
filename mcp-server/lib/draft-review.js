// The drafts review card (docs/chatbot-design.md 7.1 Finalise). When next week becomes this week, every draft of this week needs an answer:
// liked (promote), not for us (remove), not tried yet (keep it this week, or back to the book). One ask_user per draft made the editor wait
// for a model call after every tap, so instead ONE card lists them all and a single Done sends every answer. The server stages them itself
// (no model: the answers map straight to stage operations) in one tray write, and only then hands over to the model for the shopping list.
//
// Everything on the card is built here from the site's own data: which drafts there are comes from the book, never from the model or the
// client. The client sends only { slug: answer } back, and an answer for anything that isn't one of this week's drafts is ignored.
import { recipeSummaries } from "./recipes.js";
import { cardFor } from "./chat-ui.js";
import { stageMany, loadTray } from "./tray.js";

/** The answers a row can have, with the words the card and the stored message use. */
export const ANSWERS = { liked: "Liked", remove: "Not for us", keep: "Keep this week", book: "Back to the book" };
/** A draft that is also planned for next week stays wherever the switch puts it: it can only be liked, or not tried yet (nothing changes). */
const NEXT_LABELS = { liked: "Liked", remove: "Not for us", book: "Not tried yet" };
export const MAX_REVIEW_DRAFTS = 20;

/** This week's drafts on the site, from the cached book. */
export async function thisWeeksDrafts() {
  return (await recipeSummaries()).filter((r) => r.current && r.draft).slice(0, MAX_REVIEW_DRAFTS);
}

/** The answer a draft already has in the tray (the switch's carry-over, a staged promote or removal), or undefined. */
function stagedAnswer(slug, items) {
  if (items.some((i) => i.kind === "promote" && i.op.slug === slug)) return "liked";
  if (items.some((i) => i.kind === "remove" && i.op.slug === slug)) return "remove";
  if ((items.find((i) => i.kind === "switch")?.op.carry_over || []).includes(slug)) return "keep";
  return undefined;
}

/**
 * What the panel draws: { drafts: [{ slug, title, image, url, meta, also_next, options: [{ value, label }], answer? }] }, or null when this
 * week has no drafts. A row starts on the answer the tray already holds for it, if any.
 */
export function reviewCard(drafts, items = []) {
  if (!drafts.length) return null;
  return {
    drafts: drafts.map((r) => {
      const card = cardFor(r);
      const alsoNext = !!r.next;
      const labels = alsoNext ? NEXT_LABELS : ANSWERS;
      const answer = stagedAnswer(r.slug, items);
      return {
        slug: r.slug,
        title: card.title,
        image: card.image,
        url: card.url,
        meta: card.meta,
        also_next: alsoNext,
        options: Object.entries(labels).map(([value, label]) => ({ value, label })),
        ...(answer && labels[answer] ? { answer } : {}),
      };
    }),
  };
}

/**
 * The client's answers checked against this week's drafts: { answers: Map(slug -> answer) } or { error }. Every draft needs one; slugs that
 * aren't one of this week's drafts are ignored (the card may be older than the book).
 */
export function parseAnswers(raw, drafts) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Send an answer for each draft." };
  const answers = new Map();
  for (const r of drafts) {
    const a = Object.hasOwn(raw, r.slug) ? raw[r.slug] : undefined;
    const allowed = r.next ? NEXT_LABELS : ANSWERS;
    if (typeof a !== "string" || !Object.hasOwn(allowed, a)) return { error: `Pick an answer for ${r.title}.` };
    answers.set(r.slug, a);
  }
  return { answers };
}

const list = (titles) => (titles.length <= 1 ? titles.join("") : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`);

/** The editor's answers as their message in the chat (what the model sees in the history): "Liked: A, B. Not for us: C." */
export function answersText(drafts, answers) {
  const groups = new Map();
  for (const r of drafts) {
    const a = answers.get(r.slug);
    const label = (r.next ? NEXT_LABELS : ANSWERS)[a];
    groups.set(label, [...(groups.get(label) || []), r.title]);
  }
  return [...groups].map(([label, titles]) => `${label}: ${titles.join(", ")}.`).join(" ");
}

/**
 * Stages the answers in ONE tray write: the switch (its carry-over = the drafts kept this week, plus anything else it already carried),
 * a promote per liked draft, a removal per draft not for us (one also planned for next week is kept: the real rule refuses it). An earlier
 * answer in the tray for one of these drafts is replaced. Resolves { line (what the user is told), kept (titles not removed), needs, items }.
 */
export async function stageReview(drafts, answers, caller, { trace } = {}) {
  const slugs = new Set(drafts.map((r) => r.slug));
  const pick = (a, { next } = {}) => drafts.filter((r) => answers.get(r.slug) === a && (next === undefined || !!r.next === next));
  const liked = pick("liked");
  const removed = pick("remove", { next: false });
  const kept = pick("remove", { next: true });
  const carried = pick("keep", { next: false });
  const book = pick("book");
  const before = (await loadTray())?.items || [];
  const otherCarry = (before.find((i) => i.kind === "switch")?.op.carry_over || []).filter((s) => !slugs.has(s));
  const carryOver = [...otherCarry, ...carried.map((r) => r.slug)];
  const ops = [
    { action: "start_next_week", ...(carryOver.length ? { carry_over: carryOver } : {}) },
    ...liked.map((r) => ({ action: "promote_recipe", slug: r.slug })),
    ...removed.map((r) => ({ action: "remove_draft", slug: r.slug })),
  ];
  const out = await stageMany(ops, caller, { clear: (i) => ["promote", "remove"].includes(i.kind) && slugs.has(i.op.slug), trace });
  const bits = [
    liked.length ? `${list(liked.map((r) => r.title))} ${liked.length === 1 ? "becomes a regular recipe" : "become regular recipes"}` : "",
    removed.length ? `${list(removed.map((r) => r.title))} ${removed.length === 1 ? "is" : "are"} removed` : "",
    carried.length ? `${list(carried.map((r) => r.title))} ${carried.length === 1 ? "stays" : "stay"} this week` : "",
    book.length ? `${list(book.map((r) => r.title))} ${book.length === 1 ? "goes" : "go"} back to the book` : "",
  ].filter(Boolean);
  let line = `In the tray: the switch to a new week${bits.length ? `. ${bits.join("; ")}` : ""}.`;
  if (kept.length) line += ` ${list(kept.map((r) => r.title))} ${kept.length === 1 ? "stays" : "stay"}: ${kept.length === 1 ? "it's" : "they're"} on next week's plan.`;
  const problems = out.items.filter((i) => i.error);
  if (problems.length) line += ` ${problems.length === 1 ? "One card has a problem" : `${problems.length} cards have a problem`}: see the tray.`;
  return { line, kept: kept.map((r) => r.title), needs: out.needs, items: out.items };
}

/** Is the newest thing the editor was shown (since their last message) a drafts review card that hasn't been answered? Stored rows. */
export function reviewOpen(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role === "user") return false;
    if (row.role === "assistant" && row.content?.ui?.review) return true;
  }
  return false;
}

const PROMOTE_IT = /^\s*(promote it|promote|promote it please|yes|yes please|yep|yeah|go ahead|it's ready|its ready|ready|it is ready)\s*[.!]?\s*$/i;
/** "Promote it" (or a plain yes) to the promote question. */
export const isPromoteIt = (text) => PROMOTE_IT.test(String(text || ""));
