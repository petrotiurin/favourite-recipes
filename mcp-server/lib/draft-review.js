// The drafts review card (docs/chatbot-design.md 7.1 Finalise). When next week becomes this week, each draft of this week gets a thumb:
// up = liked (promoted), down = not for us (removed), none = not decided yet, so it is kept for the coming week (carried over by the switch).
// One ask_user per draft made the editor wait for a model call after every tap, so instead ONE card lists them all and a single Done sends
// the thumbs. The server stages them itself (no model: they map straight to stage operations) in one tray write, and only then hands over
// to the model for the shopping list.
//
// Everything on the card is built here from the site's own data: which drafts there are comes from the book, never from the model or the
// client. The client sends only { slug: "liked" | "remove" } back; a draft it leaves out is kept, and anything that isn't one of this week's
// drafts is ignored.
import { recipeSummaries } from "./recipes.js";
import { cardFor } from "./chat-ui.js";
import { stageMany, loadTray } from "./tray.js";

/** The thumbs a row can send, and what each answer is called in the stored message. No thumb = "keep". */
export const THUMBS = ["liked", "remove"];
const LABELS = { liked: "Liked", remove: "Not for us", keep: "Kept for the coming week" };
export const MAX_REVIEW_DRAFTS = 20;

/** This week's drafts on the site, from the cached book. */
export async function thisWeeksDrafts() {
  return (await recipeSummaries()).filter((r) => r.current && r.draft).slice(0, MAX_REVIEW_DRAFTS);
}

/** The thumb a draft already has in the tray (a staged promote or removal), or undefined. */
function stagedAnswer(slug, items) {
  if (items.some((i) => i.kind === "promote" && i.op.slug === slug)) return "liked";
  if (items.some((i) => i.kind === "remove" && i.op.slug === slug)) return "remove";
  return undefined;
}

/**
 * What the panel draws: { drafts: [{ slug, title, image, url, meta, also_next, answer? }] }, or null when this week has no drafts. A row starts
 * on the thumb the tray already holds for it, if any.
 */
export function reviewCard(drafts, items = []) {
  if (!drafts.length) return null;
  return {
    drafts: drafts.map((r) => {
      const card = cardFor(r);
      const answer = stagedAnswer(r.slug, items);
      return { slug: r.slug, title: card.title, image: card.image, url: card.url, meta: card.meta, also_next: !!r.next, ...(answer ? { answer } : {}) };
    }),
  };
}

/**
 * The client's thumbs checked against this week's drafts: { answers: Map(slug -> "liked" | "remove" | "keep") } or { error }. A draft with
 * no thumb is "keep"; slugs that aren't one of this week's drafts are ignored (the card may be older than the book).
 */
export function parseAnswers(raw, drafts) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "Send the thumbs as { slug: \"liked\" | \"remove\" }." };
  const answers = new Map();
  for (const r of drafts) {
    const a = Object.hasOwn(raw, r.slug) ? raw[r.slug] : undefined;
    if (a === undefined || a === null) answers.set(r.slug, "keep");
    else if (THUMBS.includes(a)) answers.set(r.slug, a);
    else return { error: `That isn't an answer for ${r.title}.` };
  }
  return { answers };
}

const list = (titles) => (titles.length <= 1 ? titles.join("") : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`);

/** The editor's answers as their message in the chat (what the model sees in the history): "Liked: A, B. Not for us: C." */
export function answersText(drafts, answers) {
  const groups = new Map();
  for (const r of drafts) {
    const a = answers.get(r.slug);
    const label = LABELS[a];
    groups.set(label, [...(groups.get(label) || []), r.title]);
  }
  return [...groups].map(([label, titles]) => `${label}: ${titles.join(", ")}.`).join(" ");
}

/**
 * Stages the answers in ONE tray write: the switch (its carry-over = the drafts with no thumb, plus anything else it already carried), a
 * promote per thumb up, a removal per thumb down (one also planned for next week is kept: the real rule refuses it). A draft also in next
 * week needs no carry-over: the switch puts it in the coming week anyway. An earlier answer in the tray for one of these drafts is replaced.
 * Resolves { line (what the user is told), kept (titles not removed), needs, items }.
 */
export async function stageReview(drafts, answers, caller, { trace } = {}) {
  const slugs = new Set(drafts.map((r) => r.slug));
  const pick = (a, { next } = {}) => drafts.filter((r) => answers.get(r.slug) === a && (next === undefined || !!r.next === next));
  const liked = pick("liked");
  const removed = pick("remove", { next: false });
  const kept = pick("remove", { next: true });
  const carried = pick("keep", { next: false });
  const staying = pick("keep");
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
    staying.length ? `${list(staying.map((r) => r.title))} ${staying.length === 1 ? "stays" : "stay"} for the coming week` : "",
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
