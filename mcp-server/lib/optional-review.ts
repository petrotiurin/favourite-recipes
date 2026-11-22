// The optional items card (docs/structured-ingredients.md section 6, S6): at the end of Finalise list, ONE card lists the items on next week's
// list that only optional ingredients (garnishes, extras) need, each ticked (kept) to start. The user unticks what they don't want this week and
// taps Done. Like the drafts review card (lib/draft-review.js) it is drawn and answered by the server, with no model call.
//
// Everything on the card comes from the tray's built list: which items are optional is decided by the recipes' data, never by the model or the
// client. The client sends back only { item: "keep" | "drop" }; an item it leaves out is kept, anything else is refused. The answers become
// this-week-only `drop` patches on the list card (lib/tray.js markReviewed), never catalogue changes.
import { recipeSummaries } from "./recipes.ts";
import { cardFor } from "./chat-ui.ts";
import { slugify } from "./recipe-format.ts";
import { signedPhotoUrl } from "./tray-store.ts";

export const ANSWERS = ["keep", "drop"];
export const MAX_OPTIONAL_ITEMS = 30;

/**
 * What the panel draws: { items: [{ item, name, quantity, recipes: [{ slug, title, image }], answer? }] }, or null when there are none. `optional`
 * is the built list's optional items (listState().built.optional, after earlier drops: those are off the list, so they come back unticked).
 * `edits` are the list card's patches: an item already dropped by an answer is shown unticked.
 */
export async function optionalCard(optional, edits = [], dropped = [], trayItems = []) {
  const all = [...optional, ...dropped].slice(0, MAX_OPTIONAL_ITEMS);
  if (!all.length) return null;
  const book = new Map((await recipeSummaries().catch(() => [])).map((r) => [r.slug, r]));
  // a recipe that is new in the tray isn't in the book yet: its title and its staged photo come from its tray card
  const staged = new Map();
  const wanted = new Set(all.flatMap((o) => o.recipes || []).filter((slug) => !book.has(slug)));
  for (const i of trayItems.filter((x) => x.kind === "new" && wanted.has(slugify(x.op.title)))) {
    const url = i.photo?.status === "ready" && i.photo.path ? await signedPhotoUrl(i.photo.path).catch(() => "") : "";
    staged.set(slugify(i.op.title), { title: i.op.title, image: url || "" });
  }
  const droppedIds = new Set(edits.filter((e) => e.drop).map((e) => e.drop));
  return {
    items: all.map((o) => ({
      item: o.item,
      name: o.name,
      quantity: o.quantity || "",
      recipes: (o.recipes || []).map((slug) => {
        const r = book.get(slug);
        const card = r ? cardFor(r) : null;
        const s = staged.get(slug);
        return { slug, title: card?.title || r?.title || s?.title || slug.replace(/-/g, " "), image: card?.image || s?.image || "" };
      }),
      ...(droppedIds.has(o.item) ? { answer: "drop" } : {}),
    })),
  };
}

/** The client's ticks checked against the card's items: { answers: { item: "keep" | "drop" } } or { error }. Unanswered = keep; unknown ids ignored. */
export function parseOptionalAnswers(raw, items) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: 'Send the ticks as { item: "keep" | "drop" }.' };
  const answers = {};
  for (const o of items) {
    const a = Object.hasOwn(raw, o.item) ? raw[o.item] : undefined;
    if (a === undefined || a === null) answers[o.item] = "keep";
    else if (ANSWERS.includes(a)) answers[o.item] = a;
    else return { error: `That isn't an answer for ${o.name}.` };
  }
  return { answers };
}

const list = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The editor's answers as their message in the chat: "Leaving off: sesame seeds and chilli oil." / "Keeping all the optional items." */
export function optionalAnswersText(items, answers) {
  const off = items.filter((o) => answers[o.item] === "drop").map((o) => o.name.toLowerCase());
  return off.length ? `Leaving off: ${list(off)}.` : "Keeping all the optional items.";
}

/** Is the newest thing the editor was shown (since their last message) an optional items card that hasn't been answered? Stored rows. */
export function optionalOpen(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role === "user") return false;
    if (row.role === "assistant" && row.content?.ui?.optional) return true;
  }
  return false;
}

/** The line above the card. */
export const optionalLine = (n) =>
  `${n === 1 ? "One item is" : `${n} items are`} only for garnishes and extras. Untick what you don't want this week, then Done.`;
