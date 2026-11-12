// Reading recipe photos in the background (docs/parallel-photo-reading.md 2.5, 2.6): a lightweight queue in Postgres (`photo_reads`, one row per
// photo, supabase/migrations/*_photo_reads.sql) drained by short-lived "drainers" started with background() (Vercel waitUntil). No new service
// and no long-running worker:
//   enqueue      one row per photo, then a drainer
//   drain        claims queued photos (claim_photo_reads: lowest n first, at most CHAT_VISION_CONCURRENCY reading across the household), reads them
//                in parallel, stores what was read; when the conversation is idle (nothing queued or reading) and the quiet period has passed, it
//                claims the report (claim_photo_report: exactly one drainer gets it) and reports
//   report       groups neighbouring photos, reads joined groups again together (the second pass), runs the checks (a dry run of create_recipe,
//                duplicates in the household tray and the book), stores a note from the site (an `event` message) and starts the follow-up turn
//   kick         from the panel's polling: restarts work an instance left behind (an expired lease, a report never made, a follow-up never run)
// Everything here is server-side; the main chat model only ever sees the text report.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { rest, q, clock, appendEvent, unhandledEvents, conversationById, lockHeld } from "./chat-store.js";
import { downloadUpload, dataUrl } from "./chat-uploads.js";
import { readPhotos, groupPhotos, fieldsFromRead, findDuplicate, photoLabel, ReaderError, readerConfigured } from "./photo-reader.js";
import { PHOTO_READER_PROMPT_VERSION } from "./photo-reader-prompt.js";
import { background } from "./background.js";
import { startTrace } from "./langfuse.js";
import { userEmail } from "./auth.js";

export const MAX_UNREPORTED = 30; // photos per conversation not reported yet
export const MAX_ATTEMPTS = 2;
export const DRAIN_BUDGET_MS = 200_000; // a drainer stops claiming after this and hands over to a fresh one (Vercel stops a function at 300s)
const SLOT_WAIT_MS = 1500; // the household cap is full: try again after this
const KICK_THROTTLE_MS = 10_000;
export const deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; // tests can make waiting instant

// --- the table ----------------------------------------------------------------------------------------------------------------------

export async function readsOf(conversationId) {
  return (await rest("photo_reads", { query: q({ select: "*", conversation_id: `eq.${conversationId}`, order: "n.asc" }) })) || [];
}

async function patchRead(id, patch, extra = {}) {
  return rest("photo_reads", { method: "PATCH", prefer: "return=representation", query: q({ id: `eq.${id}`, ...extra }), body: patch });
}

async function patchReads(ids, patch) {
  if (!ids.length) return;
  await rest("photo_reads", { method: "PATCH", query: q({ id: `in.(${ids.join(",")})` }), body: patch });
}

/** Photos being read or waiting, across the household: [{ user_id, name, conversation_id }]. For the tray's "Reading 3 photos · Sam". */
export async function householdReading() {
  return (await rest("photo_reads", { query: q({ select: "user_id,name,conversation_id", status: "in.(queued,reading)" }) })) || [];
}

/** The tray strip's entries: [{ name, count, mine }], one per editor with photos still being read. */
export async function readingEntries(userId) {
  const by = new Map();
  for (const r of await householdReading().catch(() => [])) {
    const e = by.get(r.user_id) || { name: r.name || "Someone", count: 0, mine: r.user_id === userId };
    e.count++;
    by.set(r.user_id, e);
  }
  return [...by.values()].sort((a, b) => Number(b.mine) - Number(a.mine));
}

/** Counts for one conversation: { total, queued, reading, read, failed, skipped, unreported, newestAt, active }. */
export function statusOf(rows) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const st = { total: rows.length, queued: count("queued"), reading: count("reading"), read: count("read"), failed: count("failed"), skipped: count("skipped") };
  st.unreported = rows.filter((r) => (r.status === "read" || r.status === "failed") && !r.reported_at).length;
  st.newestAt = rows.reduce((t, r) => Math.max(t, Date.parse(r.created_at) || 0), 0);
  st.active = st.queued + st.reading > 0 || st.unreported > 0;
  return st;
}

export async function photoStatus(conversationId) {
  return statusOf(await readsOf(conversationId));
}

/** "[photos still being read: 4 of 6]" for the turn's note while reading, plus photos that were attached but never handed to the reader. */
export function progressNote(rows, photos = []) {
  const lines = [];
  const pending = rows.filter((r) => r.status === "queued" || r.status === "reading").length;
  const batch = rows.filter((r) => r.status !== "skipped" && (!r.reported_at || r.status === "queued" || r.status === "reading"));
  if (pending) lines.push(`[photos still being read: ${batch.length - pending} of ${batch.length} done. The result arrives as a note from the site: don't say they are read, and don't call read_recipe_photos for them again.]`);
  const queued = new Set(rows.map((r) => r.path));
  const never = photos.filter((p) => !queued.has(p.path));
  if (never.length) lines.push(`Photos the user attached that haven't been sent to the photo reader yet: ${never.map((p) => `photo-${p.n}`).join(", ")}. Call read_recipe_photos to read them.`);
  return lines.join("\n");
}

// --- enqueue ------------------------------------------------------------------------------------------------------------------------

/**
 * Queues photos ([{ n, path }]) of a conversation for reading and starts a drainer. Photos already queued are skipped (unique per conversation
 * and path). Returns { queued: rows, refused: n (over the 30-unreported limit), status }.
 */
export async function enqueuePhotos({ conversationId, caller, photos, origin }) {
  if (caller?.role !== "editor" || !caller.userId) throw new Error("Refusing to queue photos: only an editor may");
  const rows = await readsOf(conversationId);
  const have = new Set(rows.map((r) => r.path));
  const fresh = photos.filter((p) => !have.has(p.path) && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i.test(p.path) && p.path.startsWith(`${conversationId}/`));
  const room = Math.max(0, MAX_UNREPORTED - rows.filter((r) => r.status !== "skipped" && !r.reported_at).length);
  const take = fresh.slice(0, room);
  let queued = [];
  if (take.length) {
    queued = (await rest("photo_reads", {
      method: "POST",
      prefer: "return=representation,resolution=ignore-duplicates",
      query: q({ on_conflict: "conversation_id,path" }),
      body: take.map((p) => ({ conversation_id: conversationId, user_id: caller.userId, name: nameOf(caller.email), n: p.n, path: p.path, created_at: new Date(clock.now()).toISOString() })),
    })) || [];
    startDrainer(conversationId, { origin });
  }
  return { queued, refused: fresh.length - take.length, status: statusOf([...rows, ...queued]) };
}

const nameOf = (email) => String(email || "").split("@")[0].split(/[._+-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Someone";

// --- draining -----------------------------------------------------------------------------------------------------------------------

/** Starts a drainer for the conversation: in a fresh function run through the internal route when it can, else here in the background. */
export function startDrainer(conversationId, { origin, fresh = false } = {}) {
  if (fresh && internalReachable(origin)) {
    return background(async () => {
      if (!(await internalCall("internal/drain", { conversation_id: conversationId }, origin))) await drain(conversationId, { origin });
    });
  }
  return background(() => drain(conversationId, { origin }));
}

/** Claims, reads and reports until the conversation's queue is empty (see the top of this file). Never throws. */
export async function drain(conversationId, { origin, startedAt = clock.now() } = {}) {
  try {
    for (;;) {
      if (clock.now() - startedAt > DRAIN_BUDGET_MS) {
        startDrainer(conversationId, { origin, fresh: true });
        return;
      }
      const claimed = (await rest("rpc/claim_photo_reads", { method: "POST", body: { p_conversation: conversationId, p_max: config.chatVisionConcurrency, p_cap: config.chatVisionConcurrency, p_lease_ms: config.chatVisionLeaseMs, p_max_attempts: MAX_ATTEMPTS } })) || [];
      if (claimed.length) {
        await Promise.all(claimed.map((row) => readOne(row)));
        continue;
      }
      const st = await photoStatus(conversationId);
      if (st.queued) {
        await deps.sleep(SLOT_WAIT_MS); // the household cap is full: wait for a slot
        continue;
      }
      if (st.reading || !st.unreported) return; // another drainer is reading (it reports), or there is nothing to report
      const wait = st.newestAt + config.chatVisionSettleMs - clock.now();
      // a turn of this chat is running (usually the one that sent the photos): report after it, so the note comes after its reply and the
      // follow-up isn't refused by the lock
      const convo = await conversationById(conversationId);
      if (lockHeld(convo)) {
        await deps.sleep(2000);
        continue;
      }
      if (wait > 0) {
        await deps.sleep(Math.min(wait, 5000)); // the quiet period: photos sent a few seconds apart go into one report
        continue;
      }
      const lot = (await rest("rpc/claim_photo_report", { method: "POST", body: { p_conversation: conversationId, p_lease_ms: config.chatVisionLeaseMs } })) || [];
      if (!lot.length) return; // someone else is reporting
      await report(conversationId, lot, { origin });
      // photos queued while the report was being built wait for the next one
      const after = await photoStatus(conversationId);
      if (!(after.queued || after.reading || after.unreported)) return;
    }
  } catch (err) {
    console.error(`Photo drainer for a conversation failed: ${err.message}`);
  }
}

const friendly = (err) =>
  err instanceof ReaderError
    ? { timeout: "it took too long to read", unparseable: "the reader's answer didn't make sense", refused: "the reader refused it", missing: "the photo is gone", "out-of-credit": "the photo reader is out of credit", "not-configured": "photo reading isn't set up" }[err.kind] || "the reader failed"
    : "something went wrong reading it";

/** Reads one claimed photo (the first pass) and stores the result; a transient failure goes back on the queue once. */
export async function readOne(row) {
  const trace = startTrace({ name: `photo read photo-${row.n}`, sessionId: row.conversation_id, userId: row.user_id, tags: ["editor", "photos"], version: PHOTO_READER_PROMPT_VERSION, metadata: { photo: `chat-uploads/${row.path}`, attempt: row.attempts, model: config.chatVisionModel }, input: `photo-${row.n}` });
  try {
    const bytes = await downloadUpload(row.path);
    if (!bytes) throw new ReaderError("The photo is gone", { kind: "missing" });
    const { read } = await readPhotos([dataUrl(bytes)], { consecutive: false, trace, name: `photo read photo-${row.n}` });
    await patchRead(row.id, { status: "read", result: read, lease_until: null, read_at: new Date(clock.now()).toISOString(), error: null }, { status: "eq.reading" });
    trace.finish(read.kind === "recipe" ? read.recipe.title || "(recipe, no title)" : read.kind);
  } catch (err) {
    const retry = err instanceof ReaderError ? err.transient && row.attempts < MAX_ATTEMPTS : row.attempts < MAX_ATTEMPTS;
    if (!(err instanceof ReaderError)) console.error(`Reading photo-${row.n} failed: ${err.message}`);
    else console.warn(`Reading photo-${row.n} failed (${err.kind}${retry ? ", will retry" : ""}): ${err.message}`);
    await patchRead(row.id, { status: retry ? "queued" : "failed", error: friendly(err), lease_until: null }, { status: "eq.reading" }).catch((e) => console.error("Storing a failed read failed:", e.message));
    trace.finish(`failed: ${friendly(err)}`);
  }
}

// --- the report ---------------------------------------------------------------------------------------------------------------------

const quote = (s, max = 60) => JSON.stringify(String(s || "").replace(/\s+/g, " ").trim().slice(0, max));
const ingNames = (fields) => fields.ingredients.map((i) => i.name);

/** The household tray's new recipes, for the duplicate check: [{ id, title, ingredients, added_by }]. */
async function trayRecipes() {
  const { loadTray } = await import("./tray.js");
  const tray = await loadTray().catch(() => null);
  return (tray?.items || []).filter((i) => i.kind === "new").map((i) => ({ id: i.id, title: i.op.title, ingredients: (i.op.ingredients || []).map((x) => x.name), added_by: i.added_by?.name || "Someone" }));
}

async function bookRecipes() {
  const { recipeIngredients } = await import("./recipes.js");
  return (await recipeIngredients().catch(() => [])).map((r) => ({ slug: r.slug, title: r.title, ingredients: r.ingredients }));
}

/** A dry run of create_recipe for a read recipe, against the repo as it is: null when it would pass, else the problem. */
export async function dryRunCheck(fields, caller) {
  const { ChangeSet } = await import("./github.js");
  const { slugify } = await import("./recipe-format.js");
  const { runOperation } = await import("./operations.js");
  const { warmReads } = await import("./tray.js");
  const slug = slugify(fields.title);
  if (!slug) return "no title";
  try {
    const cs = new ChangeSet(await warmReads());
    cs.write(`images/recipes/${slug}.jpg`, Buffer.from("check"));
    const r = await runOperation({ action: "create_recipe", ...fields, image: { uploaded: true }, week: "next" }, cs, caller);
    return { warnings: r.warnings || [] };
  } catch (err) {
    return { error: String(err.message).replace(/^[^\n]*rejected:\n- /, "").replace(/\n- /g, "; ").replace(/\n/g, " ").slice(0, 240) };
  }
}

/** The recipe a group of photos makes: the first pass for one photo; the second pass (all photos in one call) for a joined group. */
async function groupRead(group, byN, trace) {
  const rows = group.members.map((n) => byN.get(n));
  if (rows.length === 1) return { read: rows[0].result, pass: 1 };
  const first = rows[0];
  if (first.group_id === group.id && first.recipe) return { read: first.recipe, pass: 2, cached: true };
  try {
    const urls = [];
    for (const r of rows) {
      const bytes = await downloadUpload(r.path);
      if (!bytes) throw new ReaderError("The photo is gone", { kind: "missing" });
      urls.push(dataUrl(bytes));
    }
    const { read } = await readPhotos(urls, { consecutive: true, trace, name: `photo read ${group.id}` });
    return { read, pass: 2, fresh: true };
  } catch (err) {
    // the second pass failed: glue the first-pass reads together (title from the first, lists in order)
    console.warn(`Second pass for photos ${group.id} failed (${err.kind || err.message}): joining the first reads`);
    const merged = structuredClone(rows[0].result);
    for (const r of rows.slice(1)) {
      merged.recipe.ingredients.push(...r.result.recipe.ingredients.filter((i) => !merged.recipe.ingredients.some((x) => x.name.toLowerCase() === i.name.toLowerCase())));
      merged.recipe.instructions.push(...r.result.recipe.instructions.filter((s) => !merged.recipe.instructions.includes(s)));
      merged.recipe.title ||= r.result.recipe.title;
    }
    return { read: merged, pass: 1, glued: true };
  }
}

/**
 * Builds and stores the report for the claimed photos (`lot`): groups (with their neighbours already reported), second pass, checks, the note.
 * Then sets reported_at and starts the follow-up turn. Exported for tests.
 */
export async function report(conversationId, lot, { origin } = {}) {
  const rows = await readsOf(conversationId);
  const byN = new Map(rows.map((r) => [r.n, r]));
  const newIds = new Set(lot.map((r) => r.id));
  const isNew = (n) => newIds.has(byN.get(n)?.id);
  const owner = rows[0]?.user_id;
  const convo = await conversationById(conversationId);
  const email = convo ? await userEmail(convo.user_id) : null;
  const editor = !!email && config.shoppingEditors.includes(email);
  const { makeCaller } = await import("./tools.js");
  const caller = editor ? makeCaller({ role: "editor", email, userId: convo.user_id, ip: "server" }) : null;
  const trace = startTrace({ name: "photo report", sessionId: conversationId, userId: owner, tags: ["editor", "photos"], version: PHOTO_READER_PROMPT_VERSION, input: `photos ${lot.map((r) => r.n).join(", ")}` });

  const { groups, pairs } = groupPhotos(rows);
  const [tray, book] = await Promise.all([trayRecipes(), bookRecipes()]);
  const lines = [];
  const meta = { pairs: pairs.map(({ a, b, overlap, signals, decision }) => ({ a, b, overlap, signals, decision })), duplicates: [], groups: [] };
  const counts = { ok: 0, check: 0 };
  const why = { duplicate: 0, unsure: 0, unreadable: 0, incomplete: 0 };
  const newNs = lot.map((r) => r.n).sort((a, b) => a - b);
  lines.push(`new since last time: ${newNs.length === 1 ? `photo-${newNs[0]}` : `photo-${newNs[0]} to photo-${newNs[newNs.length - 1]}`}${newNs.length > 1 && newNs[newNs.length - 1] - newNs[0] + 1 !== newNs.length ? ` (${newNs.map((n) => `photo-${n}`).join(", ")})` : ""}`);
  const seenThisLot = [];
  const updates = []; // [id, patch]
  for (const g of groups) {
    const members = g.members;
    if (!members.some(isNew) && members.every((n) => byN.get(n).group_id === g.id)) continue; // unchanged and already reported
    const label = photoLabel(members);
    const { read, pass, fresh, glued } = await groupRead(g, byN, trace);
    for (const n of members) {
      const r = byN.get(n);
      const patch = { group_id: g.id };
      if (n === members[0] && members.length > 1 && fresh) patch.recipe = read;
      if (r.group_id !== g.id || patch.recipe) updates.push([r.id, patch]);
    }
    const carries = members.length > 1 && members.some((n) => !isNew(n)) ? ` (${members.filter(isNew).map((n) => `photo-${n}`).join(", ")} carries on ${members.filter((n) => !isNew(n)).map((n) => `photo-${n}`).join(", ")})` : "";
    const together = members.length > 1 ? `: read together${glued ? " (pieced together from the separate reads)" : ""}` : "";
    const stagedIds = [...new Set(members.map((n) => byN.get(n).tray_item_id).filter(Boolean))];
    if (read.kind === "dish") {
      lines.push(`${label}: a photo of a dish, not a recipe${read.dish_description ? ` (${quote(read.dish_description, 120)})` : ""}. Use it as a recipe's photo (photo_from_attachment: ${members[0]}) only if the user asks.`);
      continue;
    }
    if (read.kind === "other") {
      lines.push(`${label}: not a recipe${read.unreadable ? ` (${quote(read.unreadable, 80)})` : ""}.`);
      counts.check++;
      why.unreadable++;
      continue;
    }
    const { fields, estimated, missing } = fieldsFromRead(read);
    const bits = [`${quote(fields.title || "(no title)")}`, `serves ${fields.serves}${estimated.includes("serves") ? " (estimated)" : ""}`, `${fields.calories} kcal${estimated.includes("calories") ? " (estimated)" : ""}`, `${fields.total_mins} min${estimated.includes("total_mins") ? " (estimated)" : ""}`];
    let status = "ok";
    if (missing.length) status = `incomplete: no ${missing.join(", no ")}`;
    else if (caller) {
      const check = await dryRunCheck(fields, caller);
      if (check?.error) status = `problem: ${check.error}`;
    }
    const dup = findDuplicate({ title: fields.title, ingredients: ingNames(fields) }, { tray, book, skipIds: stagedIds });
    const inLot = seenThisLot.find((o) => findDuplicate({ title: fields.title, ingredients: ingNames(fields) }, { book: [{ slug: o.label, title: o.title, ingredients: o.ingredients }] }).match);
    meta.duplicates.push({ photos: label, checks: dup.checks.filter((c) => c.title > 0 || c.ingredients > 0).slice(0, 12), match: dup.match });
    if (dup.match?.kind === "tray") bits.push(`looks like ${quote(dup.match.title)} already in the tray (added by ${dup.match.added_by})`);
    else if (dup.match?.kind === "book") bits.push(`looks like ${quote(dup.match.title)} already in the book (${dup.match.slug})`);
    else if (inLot) bits.push(`looks like ${inLot.label} in this lot`);
    if (stagedIds.length) bits.push(members.length > 1 ? "replaces its card" : "already staged");
    lines.push(`${label}${carries}${together}: ${bits.join(" · ")} · ${status}`);
    if (status === "ok" && !dup.match && !inLot) counts.ok++;
    else {
      counts.check++;
      if (dup.match || inLot) why.duplicate++;
      else if (status.startsWith("incomplete")) why.incomplete++;
      else why.unreadable++;
    }
    seenThisLot.push({ label, title: fields.title, ingredients: ingNames(fields) });
    meta.groups.push({ photos: label, pass, status, estimated });
  }
  for (const r of lot.filter((x) => x.status === "failed")) {
    lines.push(`photo-${r.n}: couldn't be read (${r.error || "the reader failed"}). Ask the user for a clearer photo or the text.`);
    counts.check++;
    why.unreadable++;
  }
  const unsure = pairs.filter((p) => p.decision === "unsure" && (isNew(p.a) || isNew(p.b)));
  lines.push(`unsure: ${unsure.length ? unsure.map((p) => `photo-${p.a} and photo-${p.b} may be one recipe (${p.why})`).join("; ") : "none"}`);
  counts.check += unsure.length;
  why.unsure += unsure.length;
  const earlier = rows.filter((r) => r.reported_at && !newIds.has(r.id) && r.status !== "skipped");
  if (earlier.length) {
    const staged = earlier.filter((r) => r.tray_item_id).length;
    const failed = earlier.filter((r) => r.status === "failed").map((r) => `photo-${r.n}`);
    lines.push(`earlier: ${earlier.length} photo${earlier.length === 1 ? "" : "s"} (photo-${earlier[0].n} to photo-${earlier[earlier.length - 1].n}), ${staged} staged${failed.length ? `, unreadable: ${failed.join(", ")}` : ""}`);
  }
  lines.push(
    "What to do now: stage every recipe marked ok straight away with stage_create_recipe({ from_photo: \"photo-N\" }) (one call each; pass only fields the user changed). Don't stage likely duplicates: say who already added them (stage with keep_both: true only if the user says to add theirs anyway). Ask about the unsure pairs and the unreadable or incomplete photos with ask_user (\"Same recipe\" / \"Two recipes\" for a pair). Then one short line on what was added."
  );
  const recipes = meta.groups.length;
  // the panel's status line says what "to check" is, in plain words
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const checks = [
    why.duplicate && `${plural(why.duplicate, "already added", "already added")}`,
    why.unsure && plural(why.unsure, "pair that may be one recipe", "pairs that may be one recipe"),
    why.incomplete && plural(why.incomplete, "incomplete", "incomplete"),
    why.unreadable && plural(why.unreadable, "unreadable", "unreadable"),
  ].filter(Boolean);
  const again = lot.every((r) => r.group_id || r.status === "failed") && lot.some((r) => r.group_id); // only photos reported before: a correction
  const summary = `${again ? "Photos read again" : "Photos read"}: ${plural(recipes, "recipe", "recipes")}${checks.length ? ` · ${checks.join(" · ")}` : ""}`;
  const content = `photos read.\n${lines.join("\n")}`;

  const eventId = await appendEvent(conversationId, { content, summary, kind: "photos" });
  for (const [id, patch] of updates) await patchRead(id, patch).catch((e) => console.error("Storing a group failed:", e.message));
  await patchReads([...newIds], { reported_at: new Date(clock.now()).toISOString(), report_lease_until: null });
  trace.event({ name: "photo-report", metadata: meta });
  trace.finish(summary, { report: content });
  if (caller) startFollowUp(eventId, { origin });
  else console.warn("Photo report stored as a note only: the conversation's owner isn't an editor (any more)");
  return { eventId, content, summary, meta };
}

// --- corrections: join, split, skip -------------------------------------------------------------------------------------------------

/**
 * The user's corrections ("3 and 4 are one recipe", "2 and 3 are different", "skip photo 4"): stored on the rows, the affected photos are
 * reported again (and joined groups read again together). Returns lines for the model.
 */
export async function applyCorrections(conversationId, { join = [], split = [], skip = [] }, { caller, origin } = {}) {
  const rows = await readsOf(conversationId);
  const byN = new Map(rows.map((r) => [r.n, r]));
  const lines = [];
  const touched = new Map(); // id -> patch
  const touch = (r, patch = {}) => touched.set(r.id, { ...(touched.get(r.id) || {}), reported_at: null, ...patch });
  const groupOf = (r) => (r.group_id ? r.group_id.split("+").map(Number) : [r.n]);
  for (const g of join) {
    const ns = [...new Set(g)].sort((a, b) => a - b);
    const missing = ns.filter((n) => !byN.has(n) || byN.get(n).status === "skipped");
    if (ns.length < 2 || missing.length) {
      lines.push(`Can't join ${ns.map((n) => `photo-${n}`).join(" and ")}: ${missing.length ? `${missing.map((n) => `photo-${n}`).join(", ")} isn't a photo being read in this chat` : "give at least two photos"}.`);
      continue;
    }
    ns.forEach((n, i) => touch(byN.get(n), i ? { joined_to: ns[i - 1], split_from_prev: false } : {}));
    lines.push(`Joining ${ns.map((n) => `photo-${n}`).join(" + ")}: they are read again together.`);
  }
  for (const pair of split) {
    const [a, b] = [...new Set(pair)].sort((x, y) => x - y);
    if (!byN.has(a) || !byN.has(b)) {
      lines.push(`Can't split photo-${a} and photo-${b}: not photos in this chat.`);
      continue;
    }
    const rb = byN.get(b);
    for (const n of [...groupOf(byN.get(a)), ...groupOf(rb)]) if (byN.has(n)) touch(byN.get(n));
    touch(rb, { ...(rb.joined_to === a ? { joined_to: null } : {}), ...(b === a + 1 ? { split_from_prev: true } : {}) });
    lines.push(`photo-${a} and photo-${b} are now separate recipes.`);
  }
  const { dropItem, loadTray } = await import("./tray.js");
  const trayIds = new Set(((await loadTray().catch(() => null))?.items || []).map((i) => i.id));
  for (const n of [...new Set(skip)]) {
    const r = byN.get(n);
    if (!r) {
      lines.push(`There is no photo-${n} in this chat.`);
      continue;
    }
    // only photos read together with it come back into a report (its neighbours can't be joined across it anyway)
    for (const m of groupOf(r)) if (byN.has(m) && m !== n) touch(byN.get(m));
    touch(r, { status: "skipped", lease_until: null, group_id: null });
    let dropped = "";
    if (r.tray_item_id && trayIds.has(r.tray_item_id) && caller) {
      await dropItem(r.tray_item_id, caller).catch(() => null);
      dropped = " Its card was taken out of the tray.";
    }
    lines.push(`Skipped photo-${n}.${dropped}`);
  }
  for (const [id, patch] of touched) {
    const r = rows.find((x) => x.id === id);
    // a skipped photo isn't reported; a read photo comes back into the next report; a queued one stays queued
    const p = { ...patch };
    if (r.status === "skipped" && p.status !== "skipped") delete p.reported_at;
    await patchRead(id, p);
  }
  if (touched.size) startDrainer(conversationId, { origin });
  return lines;
}

// --- kicking, and the follow-up turn ------------------------------------------------------------------------------------------------

const lastKick = new Map();
/**
 * Called by the panel's polling: restarts what a dead instance left behind. A drainer for photos queued a while ago, an expired lease or a report
 * that never came; the follow-up for a note no turn picked up. Throttled per conversation; never throws.
 */
export async function kick(conversationId, { origin, force = false } = {}) {
  const now = clock.now();
  if (!force && now - (lastKick.get(conversationId) || 0) < KICK_THROTTLE_MS) return;
  lastKick.set(conversationId, now);
  try {
    const rows = await readsOf(conversationId);
    const old = (r, ms) => now - (Date.parse(r.created_at) || 0) > ms;
    const st = statusOf(rows);
    const stuck =
      rows.some((r) => r.status === "queued" && old(r, 15_000)) ||
      rows.some((r) => r.status === "reading" && Date.parse(r.lease_until) < now) ||
      (st.unreported && !st.queued && !st.reading && now - st.newestAt > config.chatVisionSettleMs + 20_000 && !rows.some((r) => !r.reported_at && Date.parse(r.report_lease_until) > now));
    if (stuck) startDrainer(conversationId, { origin });
    const events = await unhandledEvents(conversationId);
    if (events.length && now - Date.parse(events[0].created_at) > 30_000) {
      const convo = await conversationById(conversationId);
      if (convo && !lockHeld(convo, now)) startFollowUp(events[0].id, { origin });
    }
  } catch (err) {
    console.error("Kicking the photo queue failed:", err.message);
  }
}

/** Hands a note to a follow-up turn: through the internal route (its own function run and time limit) when it can, else in this function. */
export function startFollowUp(eventId, { origin } = {}) {
  return background(async () => {
    if (internalReachable(origin) && (await internalCall("internal/continue", { event_id: eventId }, origin))) return;
    const { runFollowUp } = await import("./follow-up.js");
    await runFollowUp(eventId, { origin });
  });
}

const internalBase = (origin) => config.chatInternalUrl || origin || "";
export const internalReachable = (origin) => !!config.chatInternalSecret && !!internalBase(origin);

/** POSTs to one of the server's own internal routes; true when it was accepted. */
export async function internalCall(route, body, origin) {
  try {
    const res = await fetch(`${internalBase(origin)}/chat/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Internal-Secret": config.chatInternalSecret }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (res.ok) return true;
    console.error(`The internal route ${route} answered ${res.status}`);
  } catch (err) {
    console.error(`The internal route ${route} couldn't be reached: ${err.message}`);
  }
  return false;
}

/** Is this the server's own secret? (constant time; refuses everything when no secret is set) */
export function internalSecretOk(given) {
  const want = config.chatInternalSecret;
  if (!want || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export { readerConfigured, randomUUID };
