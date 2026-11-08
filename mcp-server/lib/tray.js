// The household plan tray (docs/chatbot-design.md 7.1): what the chat stages instead of committing. Items collect in one shared tray
// (lib/tray-store.js) until a person taps Save (lib/plan-apply.js), which commits them in ONE commit.
//
// Validation is a dry run of the REAL write logic: every item is an operation in the batch_changes shape ({ action, ...args }), and
// replay() runs the whole tray, in Save order, through lib/operations.js against a throwaway ChangeSet on top of the current repo. Nothing
// is ever committed here: this module never calls ChangeSet.commit, and a ChangeSet only reads from the branch. The tray's earlier items
// are therefore visible to later ones (a recipe staged as new can be read, put in next week and listed), and any problem shows on the
// item's card straight away.
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { ChangeSet, assertAllowedPath, branchSnapshot } from "./github.js";
import { slugify, parseRecipe, renderIngredient, ingredientNamesFromSection } from "./recipe-format.js";
import { listRecipes, isNextWeek, isDraft, recipeSummaries, removeDraft, UserError } from "./recipes.js";
import { ShoppingListError } from "./shopping-list.js";
import { runOperation } from "./operations.js";
import { readTray, createTray, patchTray, deleteTrayRow, removeTrayPhotos, removePhotos, uploadPhoto, signedPhotoUrl, TRAY_TTL_MS } from "./tray-store.js";
import { makePhoto } from "./tray-photos.js";
import { background } from "./background.js";
import { clock } from "./chat-store.js";
import { startTrace } from "./langfuse.js";
import { siteUrl } from "./chat-ui.js";

export const MAX_ITEMS = 40;
const PHOTO_STALE_MS = 4 * 60 * 1000; // a photo still "pending" after this is treated as failed (the job died)
const PLACEHOLDER_PHOTO = Buffer.from("staged photo"); // stands in for the real bytes while validating

/** Who may change the tray: an editor (in the chat) or the agent. Checked by every write below, whatever called it (design 4.1 layer 3). */
export function assertCanStage(caller) {
  if (!caller || (caller.role !== "editor" && caller.role !== "agent")) {
    console.warn(`Refused a tray change: caller role "${caller?.role ?? "none"}" may not stage`);
    throw new Error("Refusing to change the tray: only an editor may do that");
  }
}

// --- items -----------------------------------------------------------------------------------------------------------------

/** The card kinds, in Save order (design Q16): switch, this week's drafts, new recipes, added to next week, edits, the list, servings. */
const KIND_GROUP = { switch: 0, promote: 1, remove: 1, new: 2, next: 3, edit: 4, list: 5, servings: 6, stocktake: 7 };
const ACTION_KIND = { start_next_week: "switch", promote_recipe: "promote", remove_draft: "remove", create_recipe: "new", set_week_recipes: "next", update_recipe: "edit", update_shopping_list: "list", set_shopping_servings: "servings", update_stocktake: "stocktake" };
export const kindOf = (op) => ACTION_KIND[op?.action];

const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
/** The order Save applies items in: by group, oldest first within a group. */
export const saveOrder = (items) => [...items].sort((a, b) => KIND_GROUP[a.kind] - KIND_GROUP[b.kind] || byCreated(a, b));
/** The order cards are shown in: the same groups, newest first within a group. */
export const displayOrder = (items) => [...items].sort((a, b) => KIND_GROUP[a.kind] - KIND_GROUP[b.kind] || byCreated(b, a));

/** A fingerprint of what the shopping list was built from: every item except the list itself, by id and operation. */
export function itemsHash(items) {
  const parts = saveOrder(items).filter((i) => i.kind !== "list" && i.kind !== "stocktake").map((i) => [i.id, i.op]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export const nameFromEmail = (email) =>
  String(email || "").split("@")[0].split(/[._+-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Someone";

const oneLine = (s, max) => String(s ?? "").replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const newItemId = () => randomBytes(4).toString("hex");
const slugOf = (item) => (item.kind === "new" ? slugify(item.op.title) : item.op.slug ?? item.op.slugs?.[0]);

function makeItem(op, { caller, reason, extra = {} }) {
  const kind = kindOf(op);
  return {
    id: newItemId(),
    kind,
    op,
    added_by: { email: caller.email || null, name: nameFromEmail(caller.email) },
    reason: oneLine(reason, 100),
    created_at: new Date(clock.now()).toISOString(),
    error: null,
    photo: null,
    base: null,
    clash: null,
    ...extra,
  };
}

// --- reading the repo as it is now -----------------------------------------------------------------------------------------

const hashOf = (text) => createHash("sha1").update(text).digest("hex");
const PICK = ["title", "course", "tags", "total_mins", "serves", "calories", "scalable", "draft", "current", "next"];

/** { hash, data } of a recipe as it is on the branch right now (not through any ChangeSet), or null. */
export async function repoSnapshot(slug, { warm = false } = {}) {
  const raw = await (warm ? new ChangeSet(await warmReads()) : new ChangeSet()).read(`recipes/${slug}.md`);
  if (!raw) return null;
  const text = raw.toString("utf8");
  const { data } = parseRecipe(text);
  return { hash: hashOf(text), data: Object.fromEntries(PICK.filter((k) => k in data).map((k) => [k, data[k]])) };
}

/** Reads for a throwaway ChangeSet from the branch snapshot (lib/github.js): one ref read, everything else shared per head SHA. */
export async function warmReads() {
  const { sha, reads } = await branchSnapshot();
  return { reads, ref: sha };
}

// --- the dry run -----------------------------------------------------------------------------------------------------------

const expectedError = (err) => err instanceof UserError || err instanceof ShoppingListError;
const tidyError = (err) => oneLine(String(err.message).replace(/^[^\n]*rejected:\n- /, "").replace(/\n- /g, "; ").replace(/\n/g, " "), 300);
const photoPath = (slug) => `images/recipes/${slug}.jpg`;

/** The operation to run for an item: a staged photo stands in as an already-uploaded image (its bytes are written to the set first). */
export function applicableOp(item, cs, photoBytes) {
  const op = { ...item.op };
  if (item.photo && (item.kind === "new" || item.kind === "edit")) {
    const slug = slugOf(item);
    cs.write(photoPath(slug), photoBytes);
    op.image = { uploaded: true };
  }
  return op;
}

/**
 * Runs the given items in Save order against the repo as it is now (plus the items before them). Returns { cs, results: Map(id -> { error }
 * | { warnings, result }), nextSlugs } where an item that fails is skipped (its half-done edits undone) and later items go on without it.
 * Never commits. Unexpected failures (GitHub down) throw: those aren't a problem with the item.
 */
export async function replay(items, caller, { reads = new Map(), ref, photoBytes = () => PLACEHOLDER_PHOTO } = {}) {
  assertCanStage(caller);
  const cs = new ChangeSet({ reads, ref });
  const results = new Map();
  for (const item of saveOrder(items)) {
    const snapshot = cs.snapshot();
    try {
      const op = applicableOp(item, cs, photoBytes(item));
      const result = await runOperation(op, cs, caller);
      results.set(item.id, { ok: true, result, warnings: result.warnings || [] });
    } catch (err) {
      cs.restore(snapshot);
      if (!expectedError(err) && !/^Refusing to write/.test(err.message)) throw err;
      results.set(item.id, { error: tidyError(err) });
    }
  }
  const nextSlugs = (await listRecipes(cs)).filter(isNextWeek).map((r) => r.slug);
  return { cs, results, nextSlugs };
}

/**
 * Does Save need a shopping list built first (design 7.1 Finalise)? Yes when the tray changes next week's recipes or the servings and
 * next week won't be empty afterwards. A switch alone, a promotion, a typo fix or a new recipe kept out of next week need none.
 */
export function needsList(items, nextSlugs) {
  if (!nextSlugs.length) return false;
  return items.some(
    (i) =>
      (i.kind === "new" && i.op.week === "next") ||
      i.kind === "next" ||
      i.kind === "servings" ||
      i.kind === "list" ||
      (i.kind === "edit" && (i.op.ingredients !== undefined || i.op.serves !== undefined) && nextSlugs.includes(i.op.slug))
  );
}

export const listCurrent = (tray, items) => {
  const list = items.find((i) => i.kind === "list");
  return !!list && !list.error && tray.list_hash === itemsHash(items);
};

const statusFor = (tray, items, needs) => (needs && !listCurrent(tray, items) ? (tray.status === "finalising" ? "finalising" : "collecting") : "ready");

// --- storage with retries --------------------------------------------------------------------------------------------------

/** The active tray, or null. An expired one (7 days after its first item) is purged first: its items and staged photos are deleted. */
export async function loadTray() {
  const row = await readTray();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= clock.now()) {
    await purgeTray(row, "expired");
    return null;
  }
  return row;
}

export async function purgeTray(row, why = "emptied") {
  try {
    await removeTrayPhotos(row.id);
  } catch (err) {
    console.error("Deleting staged photos failed:", err.message);
  }
  await deleteTrayRow(row.id);
  trayEvent("tray-" + why, { items: row.items?.length ?? 0 });
}

/**
 * Read-modify-write the tray. `fn(tray | null)` returns { items, listHash?, status?, result } to write (an empty `items` empties the tray) or
 * { result } to leave it. A version clash with another writer re-reads and runs fn again.
 */
export async function mutate(caller, fn) {
  assertCanStage(caller);
  for (let attempt = 0; attempt < 6; attempt++) {
    const tray = await loadTray();
    const out = await fn(tray);
    if (!out.items) return { result: out.result, tray };
    if (!out.items.length) {
      if (tray) await purgeTray(tray, "emptied");
      return { result: out.result, tray: null };
    }
    const patch = { items: out.items, list_hash: out.listHash === undefined ? tray?.list_hash ?? null : out.listHash, status: out.status || "collecting" };
    if (!tray) {
      const row = await createTray({ items: patch.items, listHash: patch.list_hash, status: patch.status, updatedBy: caller.userId });
      if (!row) continue;
      return { result: out.result, tray: row };
    }
    const row = await patchTray(tray.id, tray.version, patch, caller.userId);
    if (row) return { result: out.result, tray: row };
  }
  throw new UserError("The tray is being changed by someone else right now. Try again in a moment.");
}

// --- staging ---------------------------------------------------------------------------------------------------------------

const EDIT_FIELDS = ["title", "course", "tags", "total_mins", "serves", "calories", "scalable", "ingredients", "instructions", "notes"];

/** Folds a new change into the existing items: { items, item (the card it ended up on, or null), message }. Pure apart from the clock. */
function planChange(items, op, { caller, reason, base, photo }) {
  const make = (o, extra) => makeItem(o, { caller, reason, extra });
  const find = (kind, slug) => items.find((i) => i.kind === kind && slugOf(i) === slug);
  const without = (...drop) => items.filter((i) => !drop.includes(i));
  switch (op.action) {
    case "create_recipe": {
      const slug = slugify(op.title);
      if (!slug) throw new UserError("Title must contain letters or numbers");
      const old = find("new", slug);
      const item = make(op, { photo: photo || old?.photo || null });
      if (old) {
        const merged = { ...old, op, reason: item.reason || old.reason, photo: item.photo, error: null };
        return { items: items.map((i) => (i === old ? merged : i)), item: merged, message: `Updated the staged new recipe "${op.title}"` };
      }
      return { items: [...items, item], item, message: `Staged the new recipe "${op.title}"` };
    }
    case "update_recipe": {
      const staged = find("new", op.slug);
      const fields = Object.fromEntries(EDIT_FIELDS.filter((k) => op[k] !== undefined).map((k) => [k, op[k]]));
      if (staged) {
        if (fields.title !== undefined && slugify(fields.title) !== op.slug) throw new UserError(`"${op.slug}" is a new recipe in the tray: to give it a different title (which changes its address) drop it and stage it again.`);
        const merged = { ...staged, op: { ...staged.op, ...fields }, error: null, photo: photo || staged.photo };
        return { items: items.map((i) => (i === staged ? merged : i)), item: merged, message: `Edited the staged new recipe "${merged.op.title}"` };
      }
      const old = find("edit", op.slug);
      if (old) {
        const merged = { ...old, op: { ...old.op, ...fields }, error: null, photo: photo || old.photo, reason: oneLine(reason, 100) || old.reason };
        return { items: items.map((i) => (i === old ? merged : i)), item: merged, message: `Added to the staged edit of "${op.slug}"` };
      }
      const item = make({ action: "update_recipe", slug: op.slug, ...fields }, { base, photo: photo || null });
      return { items: [...items, item], item, message: `Staged an edit of "${op.slug}"` };
    }
    case "promote_recipe": {
      const staged = find("new", op.slug);
      if (staged) {
        const merged = { ...staged, op: { ...staged.op, draft: false }, error: null };
        return { items: items.map((i) => (i === staged ? merged : i)), item: merged, message: `"${op.slug}" is a new recipe in the tray: it will be added as a regular recipe, not a draft` };
      }
      const dup = find("promote", op.slug);
      if (dup) return { items, item: dup, message: `"${op.slug}" is already staged for promotion` };
      const gone = items.filter((i) => i.kind === "remove" && slugOf(i) === op.slug);
      const item = make(op, { base });
      return { items: [...without(...gone), item], item, message: `Staged promoting "${op.slug}" to a regular recipe` };
    }
    case "remove_draft": {
      const staged = find("new", op.slug);
      if (staged) {
        const kept = items.filter((i) => i !== staged && !(["edit", "next"].includes(i.kind) && slugOf(i) === op.slug));
        return { items: kept, item: null, message: `"${op.slug}" was only staged in the tray, so it was dropped from it` };
      }
      const dup = find("remove", op.slug);
      if (dup) return { items, item: dup, message: `"${op.slug}" is already staged for removal` };
      const stale = items.filter((i) => ["promote", "edit", "next"].includes(i.kind) && slugOf(i) === op.slug);
      const item = make(op, { base });
      return { items: [...without(...stale), item], item, message: `Staged removing the draft "${op.slug}" (deletes the recipe and its photo)` };
    }
    case "set_week_recipes": {
      const slug = op.slugs[0];
      const staged = find("new", slug);
      if (staged) {
        const merged = { ...staged, op: { ...staged.op, week: op.add ? "next" : undefined }, error: null };
        return { items: items.map((i) => (i === staged ? merged : i)), item: merged, message: op.add ? `"${slug}" will be in next week` : `"${slug}" will not be in next week` };
      }
      const same = items.find((i) => i.kind === "next" && slugOf(i) === slug && i.op.add === op.add);
      if (same) return { items, item: same, message: `"${slug}" is already staged to ${op.add ? "go into" : "come out of"} next week` };
      const opposite = items.find((i) => i.kind === "next" && slugOf(i) === slug && i.op.add !== op.add);
      if (opposite) return { items: without(opposite), item: null, message: `That cancels the staged ${opposite.op.add ? "adding" : "removing"} of "${slug}" to next week` };
      const item = make(op);
      return { items: [...items, item], item, message: `Staged ${op.add ? "adding" : "taking out"} "${slug}" ${op.add ? "to" : "from"} next week` };
    }
    case "start_next_week": {
      const old = items.find((i) => i.kind === "switch");
      const item = make(op);
      if (old) return { items: items.map((i) => (i === old ? { ...old, op, error: null } : i)), item: { ...old, op }, message: "Updated the staged switch to a new week" };
      return { items: [...items, item], item, message: "Staged the switch: next week becomes this week" };
    }
    case "update_shopping_list": {
      const old = items.find((i) => i.kind === "list");
      const item = make(op);
      return { items: [...without(...(old ? [old] : [])), item], item, message: "Staged the shopping list" };
    }
    case "update_stocktake": {
      // one "At home" card: later updates merge into it (the newest word on an item wins)
      const old = items.find((i) => i.kind === "stocktake");
      if (old) {
        const byName = new Map(old.op.items.map((u) => [u.name.toLowerCase(), u]));
        for (const u of op.items) byName.set(u.name.toLowerCase(), u);
        const merged = { ...old, op: { ...op, items: [...byName.values()] }, error: null };
        return { items: items.map((i) => (i === old ? merged : i)), item: merged, message: "Updated what's at home in the tray" };
      }
      const item = make(op);
      return { items: [...items, item], item, message: "Staged what's at home" };
    }
    case "set_shopping_servings": {
      const old = items.find((i) => i.kind === "servings");
      if (old) {
        const merged = { ...old, op: { ...op, servings: { ...old.op.servings, ...op.servings } }, error: null };
        return { items: items.map((i) => (i === old ? merged : i)), item: merged, message: "Updated the staged servings" };
      }
      const item = make(op);
      return { items: [...items, item], item, message: "Staged the planned servings" };
    }
    default:
      throw new UserError(`Unknown change "${op.action}"`);
  }
}

/** What to look at in the repo before staging, to know later whether the recipe changed under us (clash detection). */
async function baseFor(op) {
  if (!["update_recipe", "promote_recipe", "remove_draft"].includes(op.action)) return null;
  const snap = await repoSnapshot(op.slug, { warm: true });
  return snap ? { slug: op.slug, ...snap } : null;
}

/**
 * Stages one change. `spec`: { op (batch_changes shape), reason?, imageUrl?, newPhoto?, conversation? }. Validates by dry run, stores the item
 * (with its error, if the dry run found one) and starts the photo job for a new recipe. Resolves { item, message, error, warnings, tray, view }.
 * Never commits to the repo.
 */
export async function stageOp(spec, caller, ctx = {}) {
  assertCanStage(caller);
  const { op } = spec;
  if (!kindOf(op)) throw new UserError(`Unknown change "${op?.action}"`);
  if (op.action === "remove_draft") await removeDraft(op.slug, new ChangeSet(await warmReads()), caller); // the real rule, against the repo as it is (a draft planned for next week stays)
  if (op.action === "update_recipe" && !Object.keys(op).some((k) => EDIT_FIELDS.includes(k)) && !spec.imageUrl && !spec.newPhoto && !spec.uploadPath) throw new UserError("Nothing to change: pass at least one field");
  const base = await baseFor(op);
  if (base === null && ["update_recipe", "promote_recipe", "remove_draft"].includes(op.action)) {
    // not on the site: fine if it is a recipe staged in this tray (planChange folds into it), else the dry run reports "No recipe with slug"
  }
  const reason = spec.reason || (ctx.conversationTitle ? `from the chat "${oneLine(ctx.conversationTitle, 40)}"` : "");
  const photoSpec = { status: "pending", image_url: spec.imageUrl || null, ...(spec.uploadPath ? { upload: spec.uploadPath } : {}), started: clock.now() };
  const wantsPhoto = op.action === "create_recipe" || spec.imageUrl || spec.newPhoto || spec.uploadPath ? photoSpec : null;
  const reads = await warmReads();
  let outcome;
  const { tray } = await mutate(caller, async (tray) => {
    const items = tray?.items || [];
    if (items.length >= MAX_ITEMS && !(op.action === "update_recipe" || op.action === "create_recipe")) throw new UserError(`The tray is full (${MAX_ITEMS} changes). Save or drop some first.`);
    const planned = planChange(items, op, { caller, reason, base, photo: wantsPhoto });
    if (planned.items.length > MAX_ITEMS) throw new UserError(`The tray is full (${MAX_ITEMS} changes). Save or drop some first.`);
    const { results, nextSlugs } = await replay(planned.items, caller, reads);
    const checked = planned.items.map((i) => ({ ...i, error: results.get(i.id)?.error || null }));
    const item = planned.item ? checked.find((i) => i.id === planned.item.id) : null;
    const needs = needsList(checked, nextSlugs);
    const listHash = item?.kind === "list" ? itemsHash(checked) : checked.some((i) => i.kind === "list") ? tray?.list_hash ?? null : null;
    const next = { ...(tray || { status: "collecting" }), list_hash: listHash, items: checked };
    outcome = { item, message: planned.message, warnings: item ? results.get(item.id)?.warnings || [] : [], needs };
    return { items: checked, listHash, status: statusFor(next, checked, needs), result: null };
  });
  if (outcome.item && wantsPhoto && tray) startPhotoJob(tray.id, outcome.item.id);
  trayEvent(`tray-staged`, { kind: outcome.item?.kind || kindOf(op), action: op.action, error: !!outcome.item?.error, trace: ctx.trace });
  return { ...outcome, error: outcome.item?.error || null, tray };
}

/** Drops an item (and its staged photo). Returns the dropped item, or null if it isn't there. */
export async function dropItem(id, caller, ctx = {}) {
  assertCanStage(caller);
  let dropped = null;
  const reads = await warmReads();
  const { tray } = await mutate(caller, async (tray) => {
    dropped = tray?.items.find((i) => i.id === id) || null;
    if (!dropped) return { result: null };
    const items = tray.items.filter((i) => i.id !== id);
    if (!items.length) return { items: [], result: null };
    const { results, nextSlugs } = await replay(items, caller, reads);
    const checked = items.map((i) => ({ ...i, error: results.get(i.id)?.error || null }));
    const needs = needsList(checked, nextSlugs);
    const listHash = checked.some((i) => i.kind === "list") ? tray.list_hash : null;
    return { items: checked, listHash, status: statusFor({ ...tray, list_hash: listHash }, checked, needs), result: null };
  });
  if (dropped?.photo?.path) await removePhotos([dropped.photo.path]).catch((err) => console.error("Deleting a staged photo failed:", err.message));
  if (dropped) trayEvent("tray-dropped", { kind: dropped.kind, trace: ctx.trace });
  return dropped;
}

/** Settles a clash: keep_mine rebases the item onto the recipe as it is now; keep_theirs and drop remove it. */
export async function resolveClash(id, resolution, caller, ctx = {}) {
  assertCanStage(caller);
  if (!["keep_mine", "keep_theirs", "drop"].includes(resolution)) throw new UserError('resolution must be "keep_mine", "keep_theirs" or "drop"');
  const item = (await loadTray())?.items.find((i) => i.id === id);
  if (!item) throw new UserError("That item isn't in the tray any more.");
  if (resolution !== "keep_mine") {
    await dropItem(id, caller, ctx);
    return { item, message: `Dropped it from the tray (kept the site's version)` };
  }
  const snap = item.base ? await repoSnapshot(item.base.slug) : null;
  await mutate(caller, async (tray) => {
    const items = (tray?.items || []).map((i) => (i.id === id ? { ...i, clash: null, base: snap ? { slug: item.base.slug, ...snap } : i.base } : i));
    return { items, status: tray.status, listHash: tray.list_hash, result: null };
  });
  trayEvent("tray-clash-resolved", { resolution, trace: ctx.trace });
  return { item, message: "Kept yours: it will overwrite what changed on the site when you save" };
}

// --- clashes ---------------------------------------------------------------------------------------------------------------

const CLASH_FIELDS = ["title", "course", "tags", "total_mins", "serves", "calories", "scalable"];
const show = (v) => (Array.isArray(v) ? v.join(", ") : v === undefined ? "none" : String(v));

/** For each item staged against an existing recipe: has that recipe changed on the site since? Map(id -> { reason, details }). */
export async function findClashes(items) {
  const clashes = new Map();
  for (const item of items) {
    if (!item.base) continue;
    const now = await repoSnapshot(item.base.slug);
    const title = item.base.data?.title || item.base.slug;
    if (!now) {
      clashes.set(item.id, { reason: `"${title}" was removed on the site since this was staged`, details: [] });
    } else if (now.hash !== item.base.hash) {
      const was = item.base.data || {};
      let reason = `"${title}" changed on the site since this was staged`;
      if (was.draft === true && now.data.draft !== true) reason = `"${title}" was promoted on the site since this was staged`;
      else if (was.title !== undefined && now.data.title !== was.title) reason = `"${title}" was renamed on the site (now "${now.data.title}")`;
      const details = item.kind === "edit" ? CLASH_FIELDS.filter((f) => item.op[f] !== undefined && JSON.stringify(now.data[f]) !== JSON.stringify(was[f])).map((f) => `${f}: you set ${show(item.op[f])}, the site now has ${show(now.data[f])} (was ${show(was[f])})`) : [];
      clashes.set(item.id, { reason, details });
    }
  }
  return clashes;
}

// --- photos ----------------------------------------------------------------------------------------------------------------

async function photoSubject(item) {
  if (item.kind === "new") return { title: item.op.title, ingredients: item.op.ingredients || [], slug: slugOf(item) };
  const { data, sections } = parseRecipe((await new ChangeSet(await warmReads()).read(`recipes/${item.op.slug}.md`)).toString("utf8"));
  const names = ingredientNamesFromSection(sections.find((s) => s.heading?.toLowerCase() === "ingredients")?.content);
  return { title: item.op.title || data.title, ingredients: item.op.ingredients || names, slug: item.op.slug };
}

/** Changes one item inside the tray (retrying on a version clash); does nothing if the item or the tray is gone. Returns the item. */
async function updateItem(trayId, itemId, change) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const tray = await readTray();
    const item = tray?.items.find((i) => i.id === itemId);
    if (!tray || tray.id !== trayId || !item) return null;
    const row = await patchTray(tray.id, tray.version, { items: tray.items.map((i) => (i.id === itemId ? change(i) : i)), list_hash: tray.list_hash, status: tray.status });
    if (row) return row.items.find((i) => i.id === itemId);
  }
  return null;
}

/** Makes (or remakes) a staged item's photo in the background: "Making the photo…" on the card until it's ready or has failed. */
export function startPhotoJob(trayId, itemId, { regenerate = false } = {}) {
  return background(async () => {
    const tray = await readTray();
    const item = tray?.items.find((i) => i.id === itemId);
    if (!tray || tray.id !== trayId || !item?.photo) return;
    const path = `${trayId}/${slugOf(item)}.jpg`;
    try {
      const subject = await photoSubject(item);
      const made = await makePhoto({ title: subject.title, ingredients: subject.ingredients, description: item.photo.description, imageUrl: item.photo.image_url, uploadPath: item.photo.upload, regenerate });
      await uploadPhoto(path, made.buffer);
      const after = await updateItem(trayId, itemId, (i) => ({ ...i, photo: { ...i.photo, status: "ready", path, source: made.source, note: made.note || null, error: null } }));
      if (!after) await removePhotos([path]).catch(() => {}); // dropped (or saved) while we were making it
    } catch (err) {
      console.error(`Photo for a staged item failed: ${err.message}`);
      await updateItem(trayId, itemId, (i) => ({ ...i, photo: { ...i.photo, status: "failed", error: oneLine(err.message, 160) } }));
    }
  });
}

/** "New photo" on a card: remakes it (generated, whatever the first source was). Returns the item, or null. */
export async function regeneratePhoto(id, caller) {
  assertCanStage(caller);
  let found = null;
  const { tray } = await mutate(caller, async (tray) => {
    found = tray?.items.find((i) => i.id === id && i.photo) || null;
    if (!found) return { result: null };
    const items = tray.items.map((i) => (i.id === id ? { ...i, photo: { ...i.photo, status: "pending", error: null, started: clock.now() } } : i));
    return { items, listHash: tray.list_hash, status: tray.status, result: null };
  });
  if (found) startPhotoJob(tray.id, id, { regenerate: true });
  return found;
}

// --- Save now ------------------------------------------------------------------------------------------------------------

/**
 * Can this item be saved on its own (design 7.1 "Quick fixes")? title, steps, notes, time, calories, tags, course, photo, promoting a draft,
 * and ingredient edits to a recipe that isn't in next week. New recipes, removals, anything about next week, the switch, servings and
 * ingredient edits to a next-week recipe wait for Finalise. `inNext`: slugs that are (or will be, through the tray) in next week.
 */
export function saveNowRule(item, inNext) {
  if (item.kind === "promote" || item.kind === "stocktake") return true; // neither changes next week
  if (item.kind !== "edit") return false;
  const changesIngredients = item.op.ingredients !== undefined || item.op.serves !== undefined;
  return !(changesIngredients && inNext.has(item.op.slug));
}

// --- what the panel and the model are told --------------------------------------------------------------------------------

const lineOfIngredient = (i) => renderIngredient(i).replace(/^- /, "").replace(/\*\*/g, "");
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

/**
 * Next week as it will be after Save, in numbers (design 11.6; no model): how many recipes, how many are dinners, the average kcal per serving
 * and the total cooking time. `rows` are list rows (course, calories, total_mins). null when there are no recipes.
 */
export function weekBalance(rows) {
  if (!rows.length) return null;
  const kcal = rows.map((r) => Number(r.calories)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    recipes: rows.length,
    dinners: rows.filter((r) => (r.course || []).includes("Dinner")).length,
    avg_kcal: kcal.length ? Math.round(kcal.reduce((a, b) => a + b, 0) / kcal.length) : null,
    total_mins: rows.reduce((n, r) => n + (Number(r.total_mins) || 0), 0),
  };
}

/** Everything the panel needs to draw the tray, computed fresh. null when there's no tray. */
export async function trayView(tray, caller) {
  if (!tray) return null;
  const items = tray.items || [];
  const book = new Map((await recipeSummaries().catch(() => [])).map((r) => [r.slug, r]));
  const { results, nextSlugs, cs: afterSave } = await replay(items, caller, await warmReads());
  const balance = weekBalance((await listRecipes(afterSave)).filter(isNextWeek));
  const needs = needsList(items, nextSlugs);
  const current = listCurrent(tray, items);
  const inNext = new Set([...(await listRecipes().then((rs) => rs.filter(isNextWeek).map((r) => r.slug)).catch(() => [])), ...items.filter((i) => i.kind === "next" && i.op.add).map((i) => slugOf(i))]);
  // "Save now" eligibility comes from the one full replay above (plus the quick-fix rule): no replay per item. Save re-checks the item on its own.
  const saveNow = new Map(items.map((item) => [item.id, !item.error && !item.clash && saveNowRule(item, inNext) && (!item.photo || item.photo.status === "ready") && !results.get(item.id)?.error]));
  const photoState = (item) => {
    if (!item.photo) return null;
    const stale = item.photo.status === "pending" && clock.now() - (item.photo.started || 0) > PHOTO_STALE_MS;
    return { status: stale ? "failed" : item.photo.status, error: stale ? "The photo took too long" : item.photo.error || item.photo.note || null };
  };
  const cards = [];
  for (const item of displayOrder(items)) {
    const slug = slugOf(item);
    const recipe = book.get(slug);
    const card = {
      id: item.id,
      kind: item.kind,
      added_by: item.added_by?.name || "Someone",
      reason: item.reason || "",
      error: item.error || null,
      clash: item.clash || null,
      save_now: !!saveNow.get(item.id),
      photo: photoState(item),
    };
    if (item.photo?.status === "ready" && item.photo.path) card.photo = { ...card.photo, url: await signedPhotoUrl(item.photo.path) };
    switch (item.kind) {
      case "switch":
        card.title = "Next week becomes this week";
        card.sub = item.op.carry_over?.length ? `Carried over in this week: ${item.op.carry_over.map((slug) => book.get(slug)?.title || slug).join(", ")}` : "";
        break;
      case "new":
        card.title = item.op.title;
        card.sub = [item.op.draft === false ? "Regular recipe" : "Draft", item.op.week === "next" ? "next week" : "", `${item.op.total_mins} min`, `${item.op.calories} kcal`].filter(Boolean).join(" · ");
        card.draft = item.op.draft !== false;
        card.next = item.op.week === "next";
        card.detail = { ingredients: item.op.ingredients.map(lineOfIngredient), steps: item.op.instructions, notes: item.op.notes || "" };
        break;
      case "promote":
        card.title = recipe?.title || slug;
        card.sub = "Draft becomes a regular recipe";
        break;
      case "remove":
        card.title = recipe?.title || slug;
        card.sub = "Deletes the draft and its photo";
        break;
      case "next":
        card.title = recipe?.title || slug;
        card.sub = item.op.add ? "Goes into next week" : "Comes out of next week";
        card.add = item.op.add;
        break;
      case "edit":
        card.title = recipe?.title || item.op.title || slug;
        card.sub = `Changes ${Object.keys(item.op).filter((k) => EDIT_FIELDS.includes(k)).map((k) => ({ total_mins: "time", instructions: "steps", course: "course" })[k] || k.replace(/_/g, " ")).concat(item.photo ? ["photo"] : []).join(", ")}`;
        break;
      case "list": {
        const sections = item.op.sections || [];
        const n = sections.reduce((t, s) => t + s.items.length, 0);
        const recipes = new Set(sections.flatMap((s) => s.items.flatMap((i) => i.recipes || []))).size;
        card.title = `${n} items for ${recipes} recipe${recipes === 1 ? "" : "s"}`;
        card.sub = current ? "Ready" : "Out of date";
        card.current = current;
        if (!current) card.error = null; // an out-of-date list "fails" only because the tray moved on: the card says so instead
        card.preview = sections.map((s) => ({ name: s.name, items: s.items.map((i) => (i.quantity ? `${i.name} (${i.quantity})` : i.name)) }));
        break;
      }
      case "stocktake": {
        const ups = item.op.items || [];
        card.title = `At home: ${ups.length} item${ups.length === 1 ? "" : "s"}`;
        card.sub = ups.slice(0, 3).map((u) => `${u.name}${u.have === true ? "" : u.have ? ` ${u.have}` : ": none"}`).join(", ") + (ups.length > 3 ? ", …" : "");
        card.preview = [{ name: "At home", items: ups.map((u) => (u.have === true ? `${u.name}: enough` : u.have ? `${u.name}: ${u.have}` : `${u.name}: none`)) }];
        break;
      }
      case "servings":
        card.title = "Planned servings";
        card.sub = Object.entries(item.op.servings).map(([s, n]) => `${book.get(s)?.title || s}: ${n}`).join(", ");
        break;
    }
    if (recipe && item.kind !== "new" && item.kind !== "list" && item.kind !== "switch" && item.kind !== "servings" && item.kind !== "stocktake") {
      card.recipe = { url: siteUrl(`recipes/${slug}.html`), image: typeof recipe.image === "string" && recipe.image.startsWith("/images/") ? new URL(`${config.siteUrl}${recipe.image}`).href : "" };
    }
    cards.push(card);
  }
  const problems = items.filter((i) => i.error || i.clash).length;
  const photosPending = items.some((i) => i.photo && photoState(i).status === "pending");
  const photosFailed = items.some((i) => i.photo && photoState(i).status === "failed");
  const ready = !needs || current;
  return {
    id: tray.id,
    state: statusFor(tray, items, needs),
    count: items.length,
    needs_list: needs,
    balance,
    list_current: current,
    can_save: ready && !problems && !photosPending && !photosFailed && items.length > 0,
    blocked: problems ? "Some changes have a problem" : photosPending ? "Photos are still being made" : photosFailed ? "A photo failed: tap New photo" : "",
    expires_at: tray.expires_at,
    expires_day: WEEKDAY.format(new Date(tray.expires_at)),
    items: cards,
  };
}

/** A few lines for the model about the tray and next week on the site, added to its note each turn. */
export async function trayNote(tray, caller) {
  const book = await recipeSummaries().catch(() => []);
  const next = book.filter((r) => r.next);
  const drafts = book.filter((r) => r.current && r.draft);
  const lines = [];
  if (!tray || !tray.items?.length) lines.push("Plan tray (shared by the household): empty. Nothing is saved to the site until a person taps Save.");
  else {
    const view = await trayView(tray, caller);
    lines.push(`Plan tray (shared by the household; nothing in it is on the site until a person taps Save): ${view.count} change${view.count === 1 ? "" : "s"}, state ${view.state}${view.needs_list ? (view.list_current ? ", shopping list up to date" : ", the shopping list is needed and is not up to date (Finalise list builds it)") : ", no shopping list needed"}.`);
    for (const card of view.items) {
      const bits = [card.kind, card.title, card.sub, `added by ${card.added_by}`, card.photo ? `photo ${card.photo.status}` : "", card.error ? `PROBLEM: ${card.error}` : "", card.clash ? `CLASH: ${card.clash.reason}${card.clash.details?.length ? ` (${card.clash.details.join("; ")})` : ""}` : ""].filter(Boolean);
      lines.push(`- [${card.id}] ${bits.join(" | ")}`);
    }
  }
  lines.push(`Next week on the site now: ${next.length ? `${next.length} recipe${next.length === 1 ? "" : "s"}: ${next.map((r) => `${r.title} (${r.slug})`).join(", ")}` : "no recipes"}.`);
  lines.push(`This week's drafts on the site: ${drafts.length ? drafts.map((r) => `${r.title} (${r.slug})${r.next ? " [also in next week]" : ""}`).join(", ") : "none"}.`);
  return lines.join("\n");
}

/** After a Finalise turn: if the list didn't get built the tray goes back to collecting. */
export async function settleFinalise(caller) {
  await mutate(caller, async (tray) => {
    if (!tray || tray.status !== "finalising") return { result: null };
    const { nextSlugs } = await replay(tray.items, caller, await warmReads());
    const needs = needsList(tray.items, nextSlugs);
    return { items: tray.items, listHash: tray.list_hash, status: needs && !listCurrent(tray, tray.items) ? "collecting" : "ready", result: null };
  }).catch((err) => console.error("Settling the tray failed:", err.message));
}

export async function startFinalise(caller) {
  const { tray } = await mutate(caller, async (tray) => (tray ? { items: tray.items, listHash: tray.list_hash, status: "finalising", result: null } : { result: null }));
  return tray;
}

// --- Langfuse (design 8.1): tray events, never with emails or tokens ----------------------------------------------------------------

/** Records a tray event: on the turn's trace when there is one, else as a tiny trace of its own. */
export function trayEvent(name, { trace, userId, sessionId, level = "DEFAULT", ...metadata } = {}) {
  try {
    if (trace?.enabled) return trace.event({ name, metadata, level });
    const t = startTrace({ name: "tray", sessionId, userId, tags: ["editor", "tray"], metadata: {}, input: name });
    t.event({ name, metadata, level });
    t.finish(name);
  } catch {
    // tracing never gets in the way
  }
}

export { assertAllowedPath };
