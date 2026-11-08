// Save (docs/chatbot-design.md 7.1 "Save", "Quick fixes"): the one place the tray turns into a commit. It is its own request
// (POST /chat/plan/apply), never a model tool: a person taps the button, the server checks their token and EDITORS afresh (api/chat.js),
// re-validates every item against the repo as it is NOW, checks for clashes, and commits ONCE through the same batch machinery as
// batch_changes (lib/operations.js + ChangeSet.commit), photos included. Then it empties the tray (or removes just the saved item).
import { config } from "./config.js";
import { ChangeSet, assertCanCommit } from "./github.js";
import { slugify } from "./recipe-format.js";
import { listRecipes, isNextWeek, pageUrl, UserError } from "./recipes.js";
import { runOperation } from "./operations.js";
import { loadTray, mutate, replay, needsList, listCurrent, saveOrder, findClashes, saveNowRule, repoSnapshot, applicableOp, trayEvent, assertCanStage, purgeTray } from "./tray.js";
import { downloadPhoto, removePhotos, patchTray } from "./tray-store.js";
import { buildCards, loadBook } from "./chat-ui.js";

/** A refusal with a status the endpoint can answer with, and optional extra data for the panel. */
export class PlanError extends Error {
  constructor(message, status = 409, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const slugOfItem = (i) => (i.kind === "new" ? slugify(i.op.title) : i.op.slug ?? i.op.slugs?.[0]);

/**
 * Saves the whole tray (`itemId` undefined) or one item ("Save now"). `caller` is an editor built from a freshly verified token.
 * Resolves { saved, commit, lines, cards, summary }. Throws PlanError when nothing was committed (and says why).
 */
export async function applyPlan({ caller, itemId, trace }) {
  assertCanCommit(caller); // defence in depth: the commit below asserts again
  assertCanStage(caller);
  const tray = await loadTray();
  if (!tray || !tray.items.length) throw new PlanError("The tray is empty.", 404);
  const all = tray.items;
  const one = itemId !== undefined;
  const picked = one ? all.filter((i) => i.id === itemId) : all;
  if (!picked.length) throw new PlanError("That item isn't in the tray any more.", 404);

  // 1. What may go: everything validates against the repo as it is now.
  const fresh = await replay(all, caller);
  if (!one && needsList(all, fresh.nextSlugs) && !listCurrent(tray, all)) throw new PlanError("Finalise the list first: the tray changes next week, so the shopping list has to be built before saving.", 409);
  const broken = picked.filter((i) => fresh.results.get(i.id)?.error);
  if (broken.length) {
    throw new PlanError(`${broken.length === 1 ? "A change has" : `${broken.length} changes have`} a problem, so nothing was saved: ${fresh.results.get(broken[0].id).error}`, 409, { problems: broken.map((i) => ({ id: i.id, error: fresh.results.get(i.id).error })) });
  }
  for (const i of picked) {
    if (!i.photo) continue;
    if (i.photo.status === "pending") throw new PlanError("A photo is still being made. Try again in a moment.", 409);
    if (i.photo.status !== "ready") throw new PlanError("A photo failed: tap New photo on its card first.", 409);
  }
  if (one) {
    const item = picked[0];
    const inNext = new Set([...(await listRecipes()).filter(isNextWeek).map((r) => r.slug), ...all.filter((i) => i.kind === "next" && i.op.add).map(slugOfItem)]);
    if (!saveNowRule(item, inNext)) throw new PlanError("That change goes in with the week's plan: use Save to site.", 409);
    const alone = await replay([item], caller);
    if (alone.results.get(item.id)?.error) throw new PlanError(`That change has a problem: ${alone.results.get(item.id).error}`, 409);
  }

  // 2. Clashes: something it was staged against changed on the site. Nothing is committed; the cards are flagged and the bot resolves them.
  const clashes = await findClashes(picked);
  if (clashes.size) {
    await mutate(caller, async (t) => (t ? { items: t.items.map((i) => (clashes.has(i.id) ? { ...i, clash: clashes.get(i.id) } : i)), listHash: t.list_hash, status: t.status, result: null } : { result: null }));
    trayEvent("tray-clash", { count: clashes.size, trace });
    throw new PlanError(`Nothing was saved: ${[...clashes.values()][0].reason}.`, 409, { clash: [...clashes].map(([id, c]) => ({ id, ...c })) });
  }

  // 3. One ChangeSet, the real operations, the photos' bytes: one commit.
  const bytes = new Map();
  for (const i of picked) if (i.photo?.path) bytes.set(i.id, (await downloadPhoto(i.photo.path)) || (() => { throw new PlanError("A staged photo has gone missing: tap New photo on its card.", 409); })());
  const cs = new ChangeSet();
  const results = [];
  for (const item of saveOrder(picked)) {
    try {
      results.push({ item, r: await runOperation(applicableOp(item, cs, bytes.get(item.id)), cs, caller) });
    } catch (err) {
      if (err instanceof UserError || err.name === "ShoppingListError" || err.constructor?.name === "ShoppingListError" || err.constructor?.name === "StocktakeError") throw new PlanError(`Nothing was saved: ${err.message.split("\n")[0]}`, 409);
      throw err;
    }
  }
  const subjects = results.map(({ r }) => r.subject).filter(Boolean);
  let commit = null;
  if (cs.size) {
    const message = subjects.length === 1 ? `${subjects[0]}\n\nSaved from the chat plan tray.` : `Batch update: ${subjects.length} changes\n\n${subjects.map((s) => `- ${s}`).join("\n")}\n\nSaved from the chat plan tray.`;
    commit = await cs.commit(message, caller);
  }

  // 4. Empty the tray of what was saved (anything added meanwhile stays), rebase what remains on what we just wrote, delete the photos.
  const savedIds = new Set(picked.map((i) => i.id));
  let remaining = [];
  await mutate(caller, async (t) => {
    if (!t) return { result: null };
    const left = t.items.filter((i) => !savedIds.has(i.id));
    remaining = left;
    if (!left.length) return { items: [], result: null };
    const rebased = [];
    for (const i of left) {
      const snap = i.base ? await repoSnapshot(i.base.slug) : null;
      rebased.push(snap ? { ...i, base: { slug: i.base.slug, ...snap } } : i);
    }
    const hasList = rebased.some((i) => i.kind === "list");
    return { items: rebased, listHash: hasList && !picked.some((p) => p.kind === "list") ? t.list_hash : null, status: "collecting", result: null };
  });
  await removePhotos(picked.map((i) => i.photo?.path)).catch((err) => console.error("Deleting staged photos failed:", err.message));
  if (!remaining.length) await loadTray().catch(() => {});
  trayEvent(one ? "tray-save-now" : "tray-save", { items: picked.length, commit: commit?.url, trace, userId: caller.userId });

  // 5. The summary the chat shows: new recipes as cards that stay "Publishing…" until their pages are live.
  const newSlugs = results.filter(({ item }) => item.kind === "new").map(({ item }) => slugOfItem(item));
  const book = await loadBook();
  const cards = buildCards(book, newSlugs).cards.map((c) => ({ ...c, publishing: true }));
  const titles = new Map((await listRecipes()).map((x) => [x.slug, x.title]));
  const recipeTitle = (slug) => titles.get(slug) || all.find((i) => i.base?.slug === slug)?.base?.data?.title || String(slug).replace(/-/g, " ");
  const lines = results.map(({ item, r }) => chatLine(item, r, recipeTitle)).filter(Boolean);
  const title = (n) => `${n} change${n === 1 ? "" : "s"}`;
  const summary = commit
    ? `Saved ${title(picked.length)} to the site in one commit. It will be live in about a minute.${lines.length ? `\n\n${lines.map((l) => `- ${l.replace(/: https?:\/\/\S+$/, "")}`).join("\n")}` : ""}`
    : `Nothing needed changing: every change already matched the site.`;
  return { saved: picked.length, commit: commit ? { url: commit.url, sha: commit.sha } : null, summary, cards, newSlugs, lines, left: remaining.length };
}

/**
 * One plain-words line per saved item for the chat's summary (recipe titles, no slugs, no tool jargon). `title(slug)` gives a recipe's title.
 * Separate from the operations' own report lines, which /mcp's batch_changes keeps using.
 */
export function chatLine(item, r, title) {
  const op = item.op;
  const names = (slugs) => slugs.map(title).join(", ");
  switch (item.kind) {
    case "switch":
      return `Started the new week: next week's recipes are now this week${op.carry_over?.length ? `; kept in this week: ${names(op.carry_over)}` : ""}`;
    case "promote":
      return `${title(op.slug)} is now a regular recipe`;
    case "remove":
      return `Removed the draft ${title(op.slug)}`;
    case "new":
      return `New: ${op.title}${op.draft === false ? "" : " (draft)"}${op.week === "next" ? ", planned for next week" : ""}`;
    case "next": {
      const slugs = op.slugs || [];
      return `${names(slugs)} ${op.add ? "added to" : "taken out of"} next week`;
    }
    case "edit": {
      const fields = Object.keys(op).filter((k) => !["action", "slug", "image"].includes(k)).map((k) => ({ total_mins: "time", instructions: "steps", course: "course" })[k] || k.replace(/_/g, " "));
      return `Updated ${title(op.slug)}${fields.length ? ` (${fields.join(", ")})` : item.photo ? " (photo)" : ""}`;
    }
    case "list": {
      const items = (r.list?.sections || []).reduce((n, sec) => n + sec.items.length, 0);
      return `Shopping list: ${items} item${items === 1 ? "" : "s"} for ${r.next?.length ?? 0} recipe${r.next?.length === 1 ? "" : "s"}`;
    }
    case "servings":
      return "Planned servings updated";
    case "stocktake":
      return `What's at home updated (${r.changed?.length ?? 0} item${r.changed?.length === 1 ? "" : "s"})`;
    default:
      return null;
  }
}

/** Which of these recipe pages are live yet? A HEAD to the Pages URL, server-side; slugs are validated, so the URL is always on our own site. */
export async function pagesLive(slugs) {
  const out = {};
  await Promise.all(
    slugs.slice(0, 8).map(async (slug) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return;
      try {
        const res = await fetch(pageUrl(slug), { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000), cache: "no-store" });
        out[slug] = res.ok;
      } catch {
        out[slug] = false;
      }
    })
  );
  return out;
}

export { patchTray, purgeTray, config };
