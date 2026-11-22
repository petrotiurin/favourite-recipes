// The shapes of the photo pipeline: what the photo reader (a vision model behind OpenRouter) is asked and answers, what it makes of a photo,
// the report's pieces, the page reader's result, the image generator's request. The reader's and the generator's answers are untrusted JSON:
// they come in as `unknown` and are narrowed by lib/photo-reader.ts (normaliseRead) and lib/image-generation.ts before they get these types.
import type { UNITS } from "../../../shared/ingredient-line.ts";
import type { COURSES } from "../../../shared/recipe.ts";
import type { startTrace } from "../langfuse.ts";
import type { Caller, Course } from "./common.ts";
import type { DishSubject } from "./recipe.ts";
import type { PhotoNumber } from "./rows.ts";

/** A trace as lib/langfuse.ts startTrace makes it (a no-op object when tracing is off). */
export type Trace = ReturnType<typeof startTrace>;

/** Where the request came from, for the server's own internal routes (api/chat.ts originOf). */
export interface OriginOption {
  origin?: string;
}

// --- the photo reader (lib/photo-reader.ts) ----------------------------------------------------------------------------------------

export type ReadKind = "recipe" | "dish" | "other";
export type Unit = (typeof UNITS)[number];

/** One ingredient as the reader read it, in the recipe's own shape (the server fills `item` when it's staged). */
export interface ReadIngredient {
  amount?: number | [number, number];
  unit?: Unit;
  name: string;
  note?: string;
  optional?: true;
  section?: string;
}

/** The recipe a photo shows, as far as it shows it. Numbers the photo doesn't give are null. */
export interface ReadRecipe {
  title: string;
  course: Course[];
  tags: string[];
  total_mins: number | null;
  total_mins_estimated: boolean;
  serves: number | null;
  serves_estimated: boolean;
  calories: number | null;
  calories_estimated: boolean;
  ingredients: ReadIngredient[];
  instructions: string[];
  notes: string;
}

/** What the reader made of one photo (or of a joined group), normalised: the schema's shape with sane bounds. */
export interface PhotoRead {
  kind: ReadKind;
  has_title: boolean;
  has_ingredients: boolean;
  has_method: boolean;
  first_step: number | null;
  last_step: number | null;
  cut_off_at_bottom: boolean;
  starts_mid_recipe: boolean;
  ingredient_names: string[];
  step_ingredients: string[];
  top_lines: string[];
  bottom_lines: string[];
  recipe: ReadRecipe;
  dish_description: string;
  unreadable: string;
}

export type ReaderErrorKind = "timeout" | "unparseable" | "refused" | "upstream" | "out-of-credit" | "not-configured" | "no-schema" | "missing";

export interface ReaderErrorOptions {
  kind?: ReaderErrorKind;
  transient?: boolean;
}

export interface ReadPhotosOptions {
  consecutive?: boolean;
  trace?: Trace;
  name?: string;
}

/** The request body the reader sends (OpenRouter chat completions). */
export type ReaderContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ReaderMessage = { role: "system"; content: string } | { role: "user"; content: ReaderContentPart[] };
export interface ReaderRequest {
  model: string;
  messages: ReaderMessage[];
  temperature: number;
  max_tokens: number;
  reasoning?: { enabled: false } | { effort: string };
  provider: { require_parameters: true };
  tools?: { type: "function"; function: { name: string; description: string; parameters: object } }[];
  tool_choice?: { type: "function"; function: { name: string } };
  response_format?: { type: "json_schema"; json_schema: { name: string; strict: true; schema: object } };
}

/** What OpenRouter's usage block carries; kept as it came, only passed on to the trace. */
export type ReaderUsage = Record<string, unknown>;

/** The parts of a completion the reader looks at, picked from untrusted JSON (every field may be missing). */
export interface Completion {
  finishReason?: unknown;
  content?: unknown;
  toolArguments?: unknown;
  refusal?: unknown;
  usage?: ReaderUsage;
}

export interface ReaderResult {
  read: PhotoRead;
  usage: ReaderUsage | undefined;
  ms: number;
  request: ReaderRequest;
}

/** The grouping signals for photo A and its neighbour B. */
export interface PairSignals {
  overlap: boolean;
  signals: string[];
  newTitle: boolean;
}
export type PairDecisionName = "joined" | "unsure" | "separate" | "split_by_user" | "joined_by_user";
export interface PhotoPair extends PairSignals {
  a: number;
  b: number;
  decision: PairDecisionName;
  why: string;
}
export interface PhotoGroup {
  id: string;
  members: number[];
}

/** The create_recipe fields a read recipe makes, with what was estimated or is missing. */
export interface ReadFields {
  title: string;
  course: Course[];
  tags: string[];
  total_mins: number;
  serves: number;
  calories: number;
  ingredients: ReadIngredient[];
  instructions: string[];
  notes?: string;
}
export interface FieldsFromRead {
  fields: ReadFields;
  estimated: string[];
  missing: string[];
}

/** A recipe to compare against: the tray's new recipes and the book's. */
export interface SimilarRecipe {
  title: string;
  ingredients: string[];
}
export interface TrayRecipe extends SimilarRecipe {
  id: string;
  added_by: string;
}
export interface BookRecipeNames extends SimilarRecipe {
  slug: string;
}
export interface DuplicateCheck {
  against: string;
  title: number;
  ingredients: number;
  duplicate: boolean;
}
export type DuplicateMatch = { kind: "tray"; id: string; title: string; added_by: string } | { kind: "book"; slug: string; title: string };
export interface FindDuplicateOptions {
  tray?: TrayRecipe[];
  book?: BookRecipeNames[];
  skipIds?: string[];
}
export interface DuplicateResult {
  match: DuplicateMatch | null;
  checks: DuplicateCheck[];
}

// --- the queue and its report (lib/photo-queue.ts) --------------------------------------------------------------------------------------

export interface PhotoStatus {
  total: number;
  queued: number;
  reading: number;
  read: number;
  failed: number;
  skipped: number;
  unreported: number;
  newestAt: number;
  active: boolean;
}

export interface ReadingEntry {
  name: string;
  count: number;
  mine: boolean;
}

export interface EnqueueInput {
  conversationId: string;
  caller: Caller | null | undefined;
  photos: PhotoNumber[];
  origin?: string;
}

export interface Corrections {
  join?: number[][];
  split?: number[][];
  skip?: number[];
}

/** A dry run of create_recipe: what it would warn about, or why it would be refused. */
export type DryRun = string | { warnings: string[]; error?: undefined } | { error: string; warnings?: undefined };

/** What the report found out about the photos' groups and pairs, for the trace. */
export interface ReportMeta {
  pairs: Pick<PhotoPair, "a" | "b" | "overlap" | "signals" | "decision">[];
  duplicates: { photos: string; checks: DuplicateCheck[]; match: DuplicateMatch | null }[];
  groups: { photos: string; pass: number; status: string; estimated: string[] }[];
}

/** The recipe a group of photos makes: the first pass for one photo; the second pass (all photos in one call) for a joined group. */
export interface GroupRead {
  read: PhotoRead;
  pass: 1 | 2;
  cached?: true;
  fresh?: true;
  glued?: true;
}

// --- the page reader (lib/page-reader.ts) -----------------------------------------------------------------------------------------------

/** A page's JSON-LD Recipe block, reduced; empty fields are left out. */
export interface PageRecipe {
  name?: string;
  description?: string;
  prep_mins?: number;
  cook_mins?: number;
  total_mins?: number;
  yield?: string;
  calories_per_serving?: string;
  ingredients?: string[];
  steps?: string[];
  image?: string;
}

export interface Page {
  url: string;
  title: string;
  image: string | null;
  recipe: PageRecipe | null;
  text: string;
}

// --- photos for staged recipes (lib/tray-photos.ts, lib/image-generation.ts) -----------------------------------------------------------

/** How the fetcher gets a URL once its address has been checked: the default is a pinned connection, tests swap in fetch. */
export interface PinnedGetInit {
  headers?: Record<string, string>;
  timeoutMs?: number;
}
export interface FetchedFile {
  buffer: Buffer;
  type: string;
  url: string;
}
export interface MakePhotoInput {
  title: string;
  ingredients?: DishSubject["ingredients"];
  description?: string | null;
  imageUrl?: string | null;
  uploadPath?: string | null;
  regenerate?: boolean;
}
export interface MadePhoto {
  buffer: Buffer;
  source: "upload" | "link" | "generated";
  note?: string;
}

/** What the dish prompt is made from: a DishSubject whose ingredients may be left out. */
export type DishPromptInput = Omit<DishSubject, "ingredients"> & Partial<Pick<DishSubject, "ingredients">>;
