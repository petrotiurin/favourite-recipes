// The photo reader (docs/parallel-photo-reading.md 2.1-2.3, 2.6): a separate vision model reads recipe screenshots into a fixed schema, one
// call per photo (or per group of consecutive screenshots), with no tools, no conversation and nothing private in its prompt. Everything here
// apart from readPhotos() is pure: normalising what the model returned, grouping neighbouring photos, turning a read into a create_recipe
// operation and matching it against the tray and the book.
import { UNITS } from "../../shared/ingredient-line.ts";
import { config, COURSES } from "./config.ts";
import { readerSystemPrompt, readerInstruction, READER_SCHEMA, PHOTO_READER_PROMPT_VERSION } from "./photo-reader-prompt.ts";
import { errorMessage } from "./errors.ts";
import { asRecord, isTimeoutError } from "./narrow.ts";
import type {
  Completion,
  DuplicateMatch,
  DuplicateResult,
  FieldsFromRead,
  FindDuplicateOptions,
  PairDecisionName,
  PairSignals,
  PhotoGroup,
  PhotoPair,
  PhotoRead,
  ReadFields,
  ReadIngredient,
  ReadKind,
  ReadPhotosOptions,
  ReadRecipe,
  ReaderErrorKind,
  ReaderErrorOptions,
  ReaderRequest,
  ReaderResult,
  SimilarRecipe,
  Unit,
} from "./types/photos.ts";
import type { Course } from "./types/common.ts";
import type { PhotoReadRow } from "./types/rows.ts";

export class ReaderError extends Error {
  declare kind: ReaderErrorKind;
  declare transient: boolean;
  /** kind: timeout | unparseable | refused | upstream | out-of-credit | not-configured. transient: worth one more try. */
  constructor(message: string, { kind = "upstream", transient = false }: ReaderErrorOptions = {}) {
    super(message);
    this.kind = kind;
    this.transient = transient;
  }
}

export const readerConfigured = () => !!config.chatVisionModel && !!config.chatVisionKey;
const TEMPERATURE = 0.1;

/** The request body the reader sends: the reader prompt, ONE user message with the fixed instruction and the image parts, the schema. */
export function readerRequest(imageUrls: string[], { consecutive = false, forcedTool = false }: { consecutive?: boolean; forcedTool?: boolean } = {}): ReaderRequest {
  const messages: ReaderRequest["messages"] = [
    { role: "system", content: readerSystemPrompt() },
    { role: "user", content: [{ type: "text", text: readerInstruction(consecutive) }, ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }))] },
  ];
  const r = config.chatVisionReasoning;
  const reasoning: Pick<ReaderRequest, "reasoning"> = r === "off" ? { reasoning: { enabled: false } } : ["low", "medium", "high"].includes(r) ? { reasoning: { effort: r } } : {};
  // require_parameters: OpenRouter only routes to providers that honour response_format / the forced tool. Some providers of a model ignore the
  // schema, and a model left free can loop and invent fields until it runs out of tokens (seen with Qwen 3.5 397B).
  const base: ReaderRequest = { model: config.chatVisionModel, messages, temperature: TEMPERATURE, max_tokens: config.chatVisionMaxTokens, ...reasoning, provider: { require_parameters: true } };
  if (forcedTool) {
    // for providers without response_format: one forced tool with the same schema, and nothing else
    return { ...base, tools: [{ type: "function", function: { name: "recipe_read", description: "Report what the photo(s) show.", parameters: READER_SCHEMA } }], tool_choice: { type: "function", function: { name: "recipe_read" } } };
  }
  return { ...base, response_format: { type: "json_schema", json_schema: { name: "recipe_read", strict: true, schema: READER_SCHEMA } } };
}

async function call(body: ReaderRequest, signal: AbortSignal): Promise<{ json: unknown; status: number }> {
  let res;
  try {
    res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${config.chatVisionKey}`, "Content-Type": "application/json", "HTTP-Referer": config.siteUrl, "X-Title": "Our Favourite Recipes" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new ReaderError("The photo took too long to read", { kind: "timeout", transient: true });
    throw new ReaderError("Couldn't reach the photo reader", { transient: true });
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    // the time limit can run out while the answer is still arriving: that's a timeout, not a garbled answer
    if (isTimeoutError(err)) throw new ReaderError("The photo took too long to read", { kind: "timeout", transient: true });
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
export async function readPhotos(imageUrls: string[], { consecutive = imageUrls.length > 1, trace, name = "photo read" }: ReadPhotosOptions = {}): Promise<ReaderResult> {
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
    const choice = completionOf(out.json);
    const raw = body.tools ? choice.toolArguments : choice.content;
    if (choice.finishReason === "error") throw new ReaderError("The photo reader's provider failed mid-answer", { kind: "upstream", transient: true });
    if (choice.finishReason === "length") {
      const u = choice.usage;
      console.warn(`The photo reader ran out of room: ${u?.completion_tokens ?? "?"} tokens (${asRecord(u?.completion_tokens_details)?.reasoning_tokens ?? 0} thinking) of max ${config.chatVisionMaxTokens}`);
      throw new ReaderError("The photo reader ran out of room", { kind: "unparseable", transient: true });
    }
    const parsed = parseReaderJson(raw);
    const read = normaliseRead(parsed);
    if (!read) {
      if (choice.refusal) throw new ReaderError("The photo reader refused this photo", { kind: "refused" });
      // tried once more (MAX_ATTEMPTS in photo-queue.ts): the same prompt usually lands on another provider and comes back well-formed
      throw new ReaderError("The photo reader's answer didn't fit the schema", { kind: "unparseable", transient: true });
    }
    gen?.end?.({ output: read, usage: choice.usage, finishReason: choice.finishReason });
    return { read, usage: choice.usage, ms: Date.now() - started, request: body };
  } catch (err) {
    gen?.end?.({ error: errorMessage(err) });
    throw err;
  }
}

/** The parts of a completion the reader looks at. The body is a provider's JSON: every field may be missing or the wrong type. */
function completionOf(json: unknown): Completion {
  const root = asRecord(json);
  const choices = root?.choices;
  const choice = asRecord(Array.isArray(choices) ? choices[0] : undefined);
  const message = asRecord(choice?.message);
  const toolCalls = message?.tool_calls;
  const firstCall = asRecord(Array.isArray(toolCalls) ? toolCalls[0] : undefined);
  return { finishReason: choice?.finish_reason, content: message?.content, toolArguments: asRecord(firstCall?.function)?.arguments, refusal: message?.refusal, usage: asRecord(root?.usage) };
}

/**
 * The reader's answer as an object. Providers don't all enforce the schema strictly: a model may wrap the object in a one-item array (Qwen does),
 * fence it in ```json, or put a line of prose around it. Anything else is null (a failed read).
 */
export function parseReaderJson(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
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
  return asRecord(value) ?? null;
}

// --- normalising what the reader returned (it is untrusted: shapes and lengths are enforced here) ------------------------------------

const clean = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
const strList = (v: unknown, maxItems: number, maxLen: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => clean(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);
const posInt = (v: unknown, max: number): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max ? Math.round(Number(v)) : null);
const bool = (v: unknown): boolean => v === true;
const isUnit = (u: unknown): u is Unit => (UNITS as readonly unknown[]).includes(u);
const isKind = (k: unknown): k is ReadKind => k === "recipe" || k === "dish" || k === "other";
const isCourse = (c: string): c is Course => (COURSES as readonly string[]).includes(c);

const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100000 ? Math.round(v * 1000) / 1000 : null);
/** One read ingredient in the recipe's own shape (docs/structured-ingredients.md section 1); the server fills `item` when it's staged. */
function readIngredient(i: Record<string, unknown>): ReadIngredient {
  const amount = posNum(i.amount);
  const max = posNum(i.amount_max);
  const unit = isUnit(i.unit) ? i.unit : undefined;
  return {
    ...(amount ? { amount: max && max > amount ? ([amount, max] as [number, number]) : amount } : {}),
    ...(unit && amount ? { unit } : {}),
    name: clean(i.name, 100).replace(/\*+/g, ""),
    ...(clean(i.note, 120) ? { note: clean(i.note, 120) } : {}),
    ...(i.optional === true ? { optional: true } : {}),
    ...(clean(i.section, 40) ? { section: clean(i.section, 40).replace(/\*+/g, "") } : {}),
  };
}

/** The reader's output reduced to the schema's shape with sane bounds, or null if it isn't an object at all. */
export function normaliseRead(value: unknown): PhotoRead | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const r = asRecord(raw.recipe) ?? {};
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .map((i) => asRecord(i))
    .filter((i) => i !== undefined)
    .map((i) => readIngredient(i))
    .filter((i) => i.name)
    .slice(0, 60);
  return {
    kind: isKind(raw.kind) ? raw.kind : "other",
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
      course: strList(r.course, 5, 20).filter(isCourse),
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

const norm = (s: unknown): string => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const singular = (w: string): string => (w.length > 3 ? w.replace(/(ch|sh|ss|x|z|o)es$/, "$1").replace(/ies$/, "y").replace(/([^s])s$/, "$1") : w);
const nameSet = (list: readonly unknown[] | null | undefined): Set<string> => new Set((list || []).map((x) => norm(x).split(" ").map(singular).join(" ")).filter(Boolean));
const shared = (a: Set<string>, b: Set<string>): number => [...a].filter((x) => b.has(x)).length;

/** Text that carries on from one screenshot to the next: a line at the top of B that is also at the bottom of A. */
function overlaps(a: PhotoRead, b: PhotoRead): boolean {
  const bottoms = (a.bottom_lines || []).map(norm).filter((l) => l.length >= 12);
  // the same line on both (a screenshot's last line cut in half still matches when the shorter part is long enough to be telling)
  const part = (x: string, y: string) => x.length >= 30 && y.includes(x);
  return (b.top_lines || []).map(norm).filter((l) => l.length >= 12).some((top) => bottoms.some((bot) => bot === top || part(top, bot) || part(bot, top)));
}

/** The grouping signals for neighbours A (photo n) and B (photo n+1), both read as recipes. */
export function pairSignals(a: PhotoRead, b: PhotoRead): PairSignals {
  const signals: string[] = [];
  if (a.cut_off_at_bottom) signals.push("cut_off");
  if (b.starts_mid_recipe) signals.push("starts_mid_recipe");
  if (a.last_step && b.first_step === a.last_step + 1) signals.push("next_step");
  if (b.has_method && !b.has_ingredients && !b.has_title && shared(nameSet(b.step_ingredients), nameSet(a.ingredient_names)) > 0) signals.push("method_uses_ingredients");
  return { overlap: overlaps(a, b), signals, newTitle: b.has_title };
}

/** joined (overlap, or two signs), unsure (one sign), separate. A title on B makes signs alone at most "unsure". */
export function pairDecision({ overlap, signals, newTitle }: PairSignals): "joined" | "unsure" | "separate" {
  if (overlap) return "joined";
  if (newTitle) return signals.length >= 2 ? "unsure" : "separate";
  return signals.length >= 2 ? "joined" : signals.length === 1 ? "unsure" : "separate";
}

const lacks = (r: PhotoRead, n: number): string => {
  const missing = [!r.has_title && "no title", !r.has_ingredients && "no ingredients", !r.has_method && "no method"].filter(Boolean);
  return missing.length ? `${n} has ${missing.join(", ")}` : `${n} looks like a whole recipe`;
};

/**
 * Groups a conversation's photos (rows: { n, status, result, joined_to, split_from_prev }) into recipes: only photo n and n + 1 are ever
 * joined automatically (and only two read recipes), plus the user's own corrections (joined_to links a photo to an earlier one; split_from_prev
 * keeps it apart from the one before). Returns { groups: [{ id: "3+4", members: [3, 4] }], pairs: [{ a, b, overlap, signals, decision, why }] }.
 */
export function groupPhotos(rows: GroupableRow[]): { groups: PhotoGroup[]; pairs: PhotoPair[] } {
  const live = rows.filter((r): r is LiveRow => r.status === "read" && !!r.result).sort((x, y) => x.n - y.n);
  const byN = new Map<number, LiveRow>(live.map((r) => [r.n, r]));
  const parent = new Map<number, number>(live.map((r) => [r.n, r.n]));
  const find = (n: number): number => {
    const p = parent.get(n);
    return p === undefined || p === n ? n : find(p);
  };
  const union = (a: number, b: number) => parent.set(find(Math.max(a, b)), find(Math.min(a, b)));
  const pairs: PhotoPair[] = [];
  for (const b of live) {
    const a = byN.get(b.n - 1);
    if (a && a.result.kind === "recipe" && b.result.kind === "recipe" && b.joined_to !== a.n) {
      const s = pairSignals(a.result, b.result);
      let decision: PairDecisionName = pairDecision(s);
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
  const groups = new Map<number, number[]>();
  for (const r of live) {
    const root = find(r.n);
    const members = groups.get(root) ?? [];
    members.push(r.n);
    groups.set(root, members);
  }
  return { groups: [...groups.values()].map((members) => ({ id: members.join("+"), members })), pairs };
}

/** "photo-3+4" (also "3+4", "photo-3+photo-4", "photo 3") -> [3, 4], or null. */
export function parsePhotoId(id: unknown): number[] | null {
  const s = String(id || "").toLowerCase().replace(/photo[-\s]?/g, "").replace(/\s+/g, "");
  if (!/^\d+(\+\d+)*$/.test(s)) return null;
  const ns = [...new Set(s.split("+").map(Number))].sort((a, b) => a - b);
  return ns.every((n) => n >= 1 && n <= 10_000) ? ns : null;
}
export const photoLabel = (members: number[]): string => `photo-${members.join("+")}`;

// --- a read recipe as a create_recipe operation --------------------------------------------------------------------------------------

/**
 * The create_recipe fields of a read recipe: { fields, estimated: ["serves", ...], missing: ["method", ...] }. Numbers the reader couldn't
 * give get a plain default and are marked estimated, so the model can say so.
 */
export function fieldsFromRead(read: PhotoRead | null | undefined): FieldsFromRead {
  const r: Partial<ReadRecipe> = read?.recipe || {};
  const estimated: string[] = [];
  const pick = (key: string, value: number | null | undefined, wasEstimated: boolean | undefined, fallback: number): number => {
    if (value) {
      if (wasEstimated) estimated.push(key);
      return value;
    }
    estimated.push(key);
    return fallback;
  };
  const fields: ReadFields = {
    title: r.title || "",
    course: r.course?.length ? r.course : ["Dinner"],
    tags: r.tags || [],
    total_mins: pick("total_mins", r.total_mins, r.total_mins_estimated, 30),
    serves: pick("serves", r.serves, r.serves_estimated, 2),
    calories: pick("calories", r.calories, r.calories_estimated, 500),
    ingredients: (r.ingredients || []).map((i) => ({ ...i })),
    instructions: r.instructions || [],
    ...(r.notes ? { notes: r.notes } : {}),
  };
  const missing: string[] = [];
  if (!fields.title) missing.push("title");
  if (!fields.ingredients.length) missing.push("ingredients");
  if (!fields.instructions.length) missing.push("method");
  return { fields, estimated, missing };
}

// --- duplicates across the household tray and the book (2.6) -------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "and", "with", "of", "in", "on", "for", "recipe", "easy", "best", "ever", "quick", "my", "our", "simple", "perfect", "ultimate", "homemade", "style"]);
const titleWords = (t: unknown): Set<string> => new Set(norm(t).split(" ").filter((w) => w && !STOP.has(w)).map(singular));
/** The photo_reads columns grouping looks at. */
type GroupableRow = Pick<PhotoReadRow, "n" | "status" | "result" | "joined_to" | "split_from_prev">;
type LiveRow = GroupableRow & { result: PhotoRead };

export const TITLE_MATCH = 0.6;
export const INGREDIENT_MATCH = 0.6;

/** { title, ingredients } scores against another recipe: share of title words ("most of them") and of ingredient names. */
export function similarity(a: SimilarRecipe, b: SimilarRecipe): { title: number; ingredients: number } {
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
export function findDuplicate(recipe: SimilarRecipe, { tray = [], book = [], skipIds = [] }: FindDuplicateOptions = {}): DuplicateResult {
  const checks: DuplicateResult["checks"] = [];
  let match: DuplicateMatch | null = null;
  const consider = (other: SimilarRecipe, against: string, found: DuplicateMatch) => {
    const s = similarity(recipe, other);
    const duplicate = s.title >= TITLE_MATCH && s.ingredients >= INGREDIENT_MATCH;
    checks.push({ against, ...s, duplicate });
    if (duplicate && !match) match = found;
  };
  for (const item of tray) if (!skipIds.includes(item.id)) consider(item, `tray:${item.id}`, { kind: "tray", id: item.id, title: item.title, added_by: item.added_by });
  for (const r of book) consider(r, `book:${r.slug}`, { kind: "book", slug: r.slug, title: r.title });
  return { match, checks };
}
