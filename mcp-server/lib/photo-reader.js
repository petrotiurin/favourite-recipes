// The photo reader (docs/parallel-photo-reading.md 2.1-2.3, 2.6): a separate vision model reads recipe screenshots into a fixed schema, one
// call per photo (or per group of consecutive screenshots), with no tools, no conversation and nothing private in its prompt. Everything here
// apart from readPhotos() is pure: normalising what the model returned, grouping neighbouring photos, turning a read into a create_recipe
// operation and matching it against the tray and the book.
import { config, COURSES } from "./config.js";
import { readerSystemPrompt, readerInstruction, READER_SCHEMA, PHOTO_READER_PROMPT_VERSION } from "./photo-reader-prompt.js";

export class ReaderError extends Error {
  /** kind: timeout | unparseable | refused | upstream | out-of-credit | not-configured. transient: worth one more try. */
  constructor(message, { kind = "upstream", transient = false } = {}) {
    super(message);
    this.kind = kind;
    this.transient = transient;
  }
}

export const readerConfigured = () => !!config.chatVisionModel && !!config.chatVisionKey;
const TEMPERATURE = 0.1;

/** The request body the reader sends: the reader prompt, ONE user message with the fixed instruction and the image parts, the schema. */
export function readerRequest(imageUrls, { consecutive = false, forcedTool = false } = {}) {
  const messages = [
    { role: "system", content: readerSystemPrompt() },
    { role: "user", content: [{ type: "text", text: readerInstruction(consecutive) }, ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } }))] },
  ];
  const r = config.chatVisionReasoning;
  const reasoning = r === "off" ? { reasoning: { enabled: false } } : ["low", "medium", "high"].includes(r) ? { reasoning: { effort: r } } : {};
  // require_parameters: OpenRouter only routes to providers that honour response_format / the forced tool. Some providers of a model ignore the
  // schema, and a model left free can loop and invent fields until it runs out of tokens (seen with Qwen 3.5 397B).
  const base = { model: config.chatVisionModel, messages, temperature: TEMPERATURE, max_tokens: config.chatVisionMaxTokens, ...reasoning, provider: { require_parameters: true } };
  if (forcedTool) {
    // for providers without response_format: one forced tool with the same schema, and nothing else
    return { ...base, tools: [{ type: "function", function: { name: "recipe_read", description: "Report what the photo(s) show.", parameters: READER_SCHEMA } }], tool_choice: { type: "function", function: { name: "recipe_read" } } };
  }
  return { ...base, response_format: { type: "json_schema", json_schema: { name: "recipe_read", strict: true, schema: READER_SCHEMA } } };
}

async function call(body, signal) {
  let res;
  try {
    res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${config.chatVisionKey}`, "Content-Type": "application/json", "HTTP-Referer": config.siteUrl, "X-Title": "Our Favourite Recipes" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new ReaderError("The photo took too long to read", { kind: "timeout", transient: true });
    throw new ReaderError("Couldn't reach the photo reader", { transient: true });
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    // the time limit can run out while the answer is still arriving: that's a timeout, not a garbled answer
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new ReaderError("The photo took too long to read", { kind: "timeout", transient: true });
    throw new ReaderError("The photo reader's answer was cut off", { transient: true });
  }
  if (!res.ok) {
    if (res.status === 402 || res.status === 401 || res.status === 403 || /insufficient|credit/i.test(text)) throw new ReaderError("The photo reader is resting (out of credit)", { kind: "out-of-credit" });
    if (res.status === 400 && /response_format|json_schema|structured/i.test(text)) throw new ReaderError("no structured output", { kind: "no-schema" });
    throw new ReaderError(`The photo reader answered ${res.status}`, { transient: res.status === 429 || res.status >= 500 });
  }
  try {
    return { json: JSON.parse(text), status: res.status };
  } catch {
    throw new ReaderError("The photo reader's answer wasn't readable", { kind: "unparseable" });
  }
}

/**
 * Reads one photo, or a group of consecutive screenshots of one recipe, as JPEG data URLs. Resolves { read (normalised), usage, ms, request }
 * or throws ReaderError. The call has its own timeout (CHAT_VISION_TIMEOUT_MS) and max_tokens.
 */
export async function readPhotos(imageUrls, { consecutive = imageUrls.length > 1, trace, name = "photo read" } = {}) {
  if (!readerConfigured()) throw new ReaderError("Photo reading isn't set up.", { kind: "not-configured" });
  const started = Date.now();
  let body = readerRequest(imageUrls, { consecutive });
  const gen = trace?.generation?.({ name, model: config.chatVisionModel, input: body.messages, modelParameters: { temperature: TEMPERATURE, max_tokens: config.chatVisionMaxTokens }, metadata: { promptVersion: PHOTO_READER_PROMPT_VERSION, photos: imageUrls.length, consecutive } });
  try {
    let out;
    try {
      out = await call(body, AbortSignal.timeout(config.chatVisionTimeoutMs));
    } catch (err) {
      if (!(err instanceof ReaderError) || err.kind !== "no-schema") throw err;
      body = readerRequest(imageUrls, { consecutive, forcedTool: true });
      out = await call(body, AbortSignal.timeout(config.chatVisionTimeoutMs));
    }
    const choice = out.json?.choices?.[0];
    const raw = body.tools ? choice?.message?.tool_calls?.[0]?.function?.arguments : choice?.message?.content;
    if (choice?.finish_reason === "error") throw new ReaderError("The photo reader's provider failed mid-answer", { kind: "upstream", transient: true });
    if (choice?.finish_reason === "length") {
      const u = out.json?.usage;
      console.warn(`The photo reader ran out of room: ${u?.completion_tokens ?? "?"} tokens (${u?.completion_tokens_details?.reasoning_tokens ?? 0} thinking) of max ${config.chatVisionMaxTokens}`);
      throw new ReaderError("The photo reader ran out of room", { kind: "unparseable", transient: true });
    }
    const parsed = parseReaderJson(raw);
    const read = normaliseRead(parsed);
    if (!read) {
      if (choice?.message?.refusal) throw new ReaderError("The photo reader refused this photo", { kind: "refused" });
      // tried once more (MAX_ATTEMPTS in photo-queue.js): the same prompt usually lands on another provider and comes back well-formed
      throw new ReaderError("The photo reader's answer didn't fit the schema", { kind: "unparseable", transient: true });
    }
    gen?.end?.({ output: read, usage: out.json?.usage, finishReason: choice?.finish_reason });
    return { read, usage: out.json?.usage, ms: Date.now() - started, request: body };
  } catch (err) {
    gen?.end?.({ error: err.message });
    throw err;
  }
}

/**
 * The reader's answer as an object. Providers don't all enforce the schema strictly: a model may wrap the object in a one-item array (Qwen does),
 * fence it in ```json, or put a line of prose around it. Anything else is null (a failed read).
 */
export function parseReaderJson(raw) {
  let value = raw;
  if (typeof raw === "string") {
    const text = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
    try {
      value = JSON.parse(text);
    } catch {
      const start = text.search(/[[{]/);
      const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      try {
        value = start !== -1 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
      } catch {
        value = null;
      }
    }
  }
  if (Array.isArray(value) && value.length === 1) value = value[0];
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// --- normalising what the reader returned (it is untrusted: shapes and lengths are enforced here) ------------------------------------

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => clean(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);
const posInt = (v, max) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max ? Math.round(Number(v)) : null);
const bool = (v) => v === true;

/** The reader's output reduced to the schema's shape with sane bounds, or null if it isn't an object at all. */
export function normaliseRead(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw.recipe && typeof raw.recipe === "object" ? raw.recipe : {};
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .filter((i) => i && typeof i === "object")
    .map((i) => ({ quantity: clean(i.quantity, 60), name: clean(i.name, 100).replace(/\*+/g, ""), note: clean(i.note, 120) }))
    .filter((i) => i.name)
    .slice(0, 60);
  return {
    kind: ["recipe", "dish", "other"].includes(raw.kind) ? raw.kind : "other",
    has_title: bool(raw.has_title),
    has_ingredients: bool(raw.has_ingredients),
    has_method: bool(raw.has_method),
    first_step: posInt(raw.first_step, 200),
    last_step: posInt(raw.last_step, 200),
    cut_off_at_bottom: bool(raw.cut_off_at_bottom),
    starts_mid_recipe: bool(raw.starts_mid_recipe),
    ingredient_names: strList(raw.ingredient_names, 60, 100),
    step_ingredients: strList(raw.step_ingredients, 60, 100),
    top_lines: strList(raw.top_lines, 3, 200),
    bottom_lines: strList(raw.bottom_lines, 3, 200),
    recipe: {
      title: clean(r.title, 120),
      course: strList(r.course, 5, 20).filter((c) => COURSES.includes(c)),
      tags: strList(r.tags, 6, 40),
      total_mins: posInt(r.total_mins, 24 * 60),
      total_mins_estimated: bool(r.total_mins_estimated),
      serves: posInt(r.serves, 50),
      serves_estimated: bool(r.serves_estimated),
      calories: posInt(r.calories, 5000),
      calories_estimated: bool(r.calories_estimated),
      ingredients,
      instructions: strList(r.instructions, 60, 600),
      notes: clean(r.notes, 1500),
    },
    dish_description: clean(raw.dish_description, 300),
    unreadable: clean(raw.unreadable, 200),
  };
}

// --- grouping neighbouring photos (2.2) ------------------------------------------------------------------------------------------------

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const singular = (w) => (w.length > 3 ? w.replace(/(ch|sh|ss|x|z|o)es$/, "$1").replace(/ies$/, "y").replace(/([^s])s$/, "$1") : w);
const nameSet = (list) => new Set((list || []).map((x) => norm(x).split(" ").map(singular).join(" ")).filter(Boolean));
const shared = (a, b) => [...a].filter((x) => b.has(x)).length;

/** Text that carries on from one screenshot to the next: a line at the top of B that is also at the bottom of A. */
function overlaps(a, b) {
  const bottoms = (a.bottom_lines || []).map(norm).filter((l) => l.length >= 12);
  // the same line on both (a screenshot's last line cut in half still matches when the shorter part is long enough to be telling)
  const part = (x, y) => x.length >= 30 && y.includes(x);
  return (b.top_lines || []).map(norm).filter((l) => l.length >= 12).some((top) => bottoms.some((bot) => bot === top || part(top, bot) || part(bot, top)));
}

/** The grouping signals for neighbours A (photo n) and B (photo n+1), both read as recipes. */
export function pairSignals(a, b) {
  const signals = [];
  if (a.cut_off_at_bottom) signals.push("cut_off");
  if (b.starts_mid_recipe) signals.push("starts_mid_recipe");
  if (a.last_step && b.first_step === a.last_step + 1) signals.push("next_step");
  if (b.has_method && !b.has_ingredients && !b.has_title && shared(nameSet(b.step_ingredients), nameSet(a.ingredient_names)) > 0) signals.push("method_uses_ingredients");
  return { overlap: overlaps(a, b), signals, newTitle: b.has_title };
}

/** joined (overlap, or two signs), unsure (one sign), separate. A title on B makes signs alone at most "unsure". */
export function pairDecision({ overlap, signals, newTitle }) {
  if (overlap) return "joined";
  if (newTitle) return signals.length >= 2 ? "unsure" : "separate";
  return signals.length >= 2 ? "joined" : signals.length === 1 ? "unsure" : "separate";
}

const lacks = (r, n) => {
  const missing = [!r.has_title && "no title", !r.has_ingredients && "no ingredients", !r.has_method && "no method"].filter(Boolean);
  return missing.length ? `${n} has ${missing.join(", ")}` : `${n} looks like a whole recipe`;
};

/**
 * Groups a conversation's photos (rows: { n, status, result, joined_to, split_from_prev }) into recipes: only photo n and n + 1 are ever
 * joined automatically (and only two read recipes), plus the user's own corrections (joined_to links a photo to an earlier one; split_from_prev
 * keeps it apart from the one before). Returns { groups: [{ id: "3+4", members: [3, 4] }], pairs: [{ a, b, overlap, signals, decision, why }] }.
 */
export function groupPhotos(rows) {
  const live = rows.filter((r) => r.status === "read" && r.result).sort((x, y) => x.n - y.n);
  const byN = new Map(live.map((r) => [r.n, r]));
  const parent = new Map(live.map((r) => [r.n, r.n]));
  const find = (n) => (parent.get(n) === n ? n : find(parent.get(n)));
  const union = (a, b) => parent.set(find(Math.max(a, b)), find(Math.min(a, b)));
  const pairs = [];
  for (const b of live) {
    const a = byN.get(b.n - 1);
    const recipes = a && a.result.kind === "recipe" && b.result.kind === "recipe";
    if (recipes && b.joined_to !== a.n) {
      const s = pairSignals(a.result, b.result);
      let decision = pairDecision(s);
      if (b.split_from_prev) decision = "split_by_user";
      pairs.push({ a: a.n, b: b.n, ...s, decision, why: decision === "unsure" ? `${lacks(a.result, a.n)}, ${lacks(b.result, b.n)}` : "" });
      if (decision === "joined") union(a.n, b.n);
    }
    // the user's word wins, neighbours or not, whatever each photo was read as on its own (a step list can read as "other")
    if (b.joined_to && byN.has(b.joined_to)) {
      union(b.joined_to, b.n);
      pairs.push({ a: b.joined_to, b: b.n, overlap: false, signals: [], newTitle: false, decision: "joined_by_user", why: "" });
    }
  }
  const groups = new Map();
  for (const r of live) {
    const root = find(r.n);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r.n);
  }
  return { groups: [...groups.values()].map((members) => ({ id: members.join("+"), members })), pairs };
}

/** "photo-3+4" (also "3+4", "photo-3+photo-4", "photo 3") -> [3, 4], or null. */
export function parsePhotoId(id) {
  const s = String(id || "").toLowerCase().replace(/photo[-\s]?/g, "").replace(/\s+/g, "");
  if (!/^\d+(\+\d+)*$/.test(s)) return null;
  const ns = [...new Set(s.split("+").map(Number))].sort((a, b) => a - b);
  return ns.every((n) => n >= 1 && n <= 10_000) ? ns : null;
}
export const photoLabel = (members) => `photo-${members.join("+")}`;

// --- a read recipe as a create_recipe operation --------------------------------------------------------------------------------------

/**
 * The create_recipe fields of a read recipe: { fields, estimated: ["serves", ...], missing: ["method", ...] }. Numbers the reader couldn't
 * give get a plain default and are marked estimated, so the model can say so.
 */
export function fieldsFromRead(read) {
  const r = read?.recipe || {};
  const estimated = [];
  const pick = (key, fallback) => {
    if (r[key]) {
      if (r[`${key}_estimated`]) estimated.push(key);
      return r[key];
    }
    estimated.push(key);
    return fallback;
  };
  const fields = {
    title: r.title || "",
    course: r.course?.length ? r.course : ["Dinner"],
    tags: r.tags || [],
    total_mins: pick("total_mins", 30),
    serves: pick("serves", 2),
    calories: pick("calories", 500),
    ingredients: (r.ingredients || []).map((i) => ({ ...(i.quantity ? { quantity: i.quantity } : {}), name: i.name, ...(i.note ? { note: i.note } : {}) })),
    instructions: r.instructions || [],
    ...(r.notes ? { notes: r.notes } : {}),
  };
  const missing = [!fields.title && "title", !fields.ingredients.length && "ingredients", !fields.instructions.length && "method"].filter(Boolean);
  return { fields, estimated, missing };
}

// --- duplicates across the household tray and the book (2.6) -------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "and", "with", "of", "in", "on", "for", "recipe", "easy", "best", "ever", "quick", "my", "our", "simple", "perfect", "ultimate", "homemade", "style"]);
const titleWords = (t) => new Set(norm(t).split(" ").filter((w) => w && !STOP.has(w)).map(singular));
export const TITLE_MATCH = 0.6;
export const INGREDIENT_MATCH = 0.6;

/** { title, ingredients } scores against another recipe: share of title words ("most of them") and of ingredient names. */
export function similarity(a, b) {
  const ta = titleWords(a.title);
  const tb = titleWords(b.title);
  const title = ta.size && tb.size ? shared(ta, tb) / Math.max(ta.size, tb.size) : 0;
  const ia = nameSet(a.ingredients);
  const ib = nameSet(b.ingredients);
  const ingredients = ia.size && ib.size ? shared(ia, ib) / Math.min(ia.size, ib.size) : 0;
  return { title: Math.round(title * 100) / 100, ingredients: Math.round(ingredients * 100) / 100 };
}

/**
 * The likely duplicate of a read recipe ({ title, ingredients: [names] }) among the tray's new recipes (whoever added them) and the book, or
 * null. tray: [{ id, title, ingredients, added_by }], book: [{ slug, title, ingredients }], skipIds: tray items to ignore (its own card).
 * Returns { match: { kind: "tray" | "book", id?, slug?, title, added_by? } | null, checks: [{ against, title, ingredients, duplicate }] }.
 */
export function findDuplicate(recipe, { tray = [], book = [], skipIds = [] } = {}) {
  const checks = [];
  let match = null;
  const consider = (kind, other) => {
    const s = similarity(recipe, other);
    const duplicate = s.title >= TITLE_MATCH && s.ingredients >= INGREDIENT_MATCH;
    checks.push({ against: kind === "tray" ? `tray:${other.id}` : `book:${other.slug}`, ...s, duplicate });
    if (duplicate && !match) match = kind === "tray" ? { kind, id: other.id, title: other.title, added_by: other.added_by } : { kind, slug: other.slug, title: other.title };
  };
  for (const item of tray) if (!skipIds.includes(item.id)) consider("tray", item);
  for (const r of book) consider("book", r);
  return { match, checks };
}
