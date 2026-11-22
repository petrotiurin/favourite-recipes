import type { BuiltList, ListEdit, OptionalItem, ReviewFlag, Servings, ShoppingList, ShoppingSectionInput, StockUpdate } from "./shopping.ts";
import type { CatalogueChange } from "./catalogue.ts";
import type { Week } from "./common.ts";
import type { CreateRecipeInput, RecipeFrontmatter, UpdateRecipeInput } from "./recipe.ts";

/** The card kinds, in Save order (docs/chatbot-design.md Q16). */
export type TrayKind = "switch" | "promote" | "remove" | "new" | "next" | "edit" | "catalogue" | "list" | "servings" | "stocktake";
export type TrayStatus = "collecting" | "finalising" | "ready";

// The operations a tray item holds: the batch_changes shape ({ action, ...args }), what lib/operations.ts runOperation applies.
export type CreateRecipeOp = { action: "create_recipe" } & CreateRecipeInput;
export type UpdateRecipeOp = { action: "update_recipe" } & UpdateRecipeInput;
export interface PromoteOp {
  action: "promote_recipe";
  slug: string;
}
export interface RemoveDraftOp {
  action: "remove_draft";
  slug: string;
}
export interface SetWeekOp {
  action: "set_week_recipes";
  week: Week;
  slugs: string[];
  add: boolean;
}
export interface StartNextWeekOp {
  action: "start_next_week";
  carry_over?: string[];
}
export interface ShoppingListOp {
  action: "update_shopping_list";
  build?: true;
  edits?: ListEdit[];
  sections?: ShoppingSectionInput[];
  servings?: Servings;
}
export interface CatalogueOp {
  action: "update_catalogue";
  changes: CatalogueChange[];
}
export interface StocktakeOp {
  action: "update_stocktake";
  items: StockUpdate[];
  /** The list signature the update was made against (a rebuilt list drops it). */
  list_sig?: string;
}
export interface ServingsOp {
  action: "set_shopping_servings";
  servings: Servings;
}
export type TrayOp = CreateRecipeOp | UpdateRecipeOp | PromoteOp | RemoveDraftOp | SetWeekOp | StartNextWeekOp | ShoppingListOp | CatalogueOp | StocktakeOp | ServingsOp;
export type OpAction = TrayOp["action"];

/** The operation each kind of card holds. */
export interface OpOfKind {
  switch: StartNextWeekOp;
  promote: PromoteOp;
  remove: RemoveDraftOp;
  new: CreateRecipeOp;
  next: SetWeekOp;
  edit: UpdateRecipeOp;
  catalogue: CatalogueOp;
  list: ShoppingListOp;
  servings: ServingsOp;
  stocktake: StocktakeOp;
}

/** A staged photo: made in the background ("pending" until it is "ready" in the tray-photos bucket, or "failed"). */
export interface TrayPhoto {
  status: "pending" | "ready" | "failed";
  image_url: string | null;
  /** The chat upload it is made from. */
  upload?: string;
  /** When the job started (ms). */
  started: number;
  description?: string;
  path?: string;
  source?: string;
  note?: string | null;
  error?: string | null;
}

/** A recipe as it was on the site when the change was staged (clash detection compares against it). */
export interface TrayBase {
  slug: string;
  hash: string;
  data: Partial<RecipeFrontmatter>;
}

/** The recipe changed (or went) on the site since the change was staged. */
export interface TrayClash {
  reason: string;
  details: string[];
}

/** What Finalise list has gone through on the list card: the flag keys the model looked at, and the optional items answered. */
export interface ListReview {
  flags: string[];
  optional: string[];
}

interface TrayItemBase {
  id: string;
  added_by: { email: string | null; name: string };
  reason: string;
  created_at: string;
  error: string | null;
  photo: TrayPhoto | null;
  base: TrayBase | null;
  clash: TrayClash | null;
}
/** One change in the tray. `kind` and `op` go together: narrow on `kind` and `op` is that kind's operation. */
export type TrayItemOf<K extends TrayKind> = TrayItemBase & { kind: K; op: OpOfKind[K]; reviewed?: ListReview | null };
export type TrayItem = { [K in TrayKind]: TrayItemOf<K> }[TrayKind];

/** The tray's row in Supabase `trays`. */
export interface TrayRow {
  id: string;
  status: TrayStatus;
  items: TrayItem[];
  list_hash: string | null;
  version: number;
  created_at: string;
  expires_at: string;
  updated_at: string;
  updated_by: string | null;
}

/** Where the list card stands (lib/tray.ts listState). */
export interface ListState {
  needs: boolean;
  list: TrayItemOf<"list"> | null;
  built: BuiltList | null;
  error: string | null;
  reviewed: boolean;
  flagsOpen: ReviewFlag[];
  optionalOpen: OptionalItem[];
}

/** What running one tray item against the throwaway ChangeSet gave: its report, or why it failed. */
export interface StepOutcome {
  /** The operation's report lines, warnings, and for the list its built list and file. */
  lines: string[];
  warnings?: string[];
  built?: BuiltList;
  list?: ShoppingList;
  [key: string]: unknown;
}
export type ReplayResult =
  | { ok: true; result: StepOutcome; warnings: string[]; error?: undefined }
  | { ok?: undefined; error: string; result?: undefined; warnings?: undefined };

/** next week after Save, in numbers. */
export interface WeekBalance {
  recipes: number;
  dinners: number;
  avg_kcal: number | null;
  total_mins: number;
}

/** A recipe card's detail: its ingredient lines with each line's section, steps, notes. */
export interface RecipeDetail {
  ingredients: string[];
  sections: (string | null)[];
  steps: string[];
  notes: string;
}

/** A tray card as the panel draws it (lib/tray.ts trayView). Which of the optional fields are set depends on the kind. */
export interface TrayCard {
  id: string;
  kind: TrayKind;
  added_by: string;
  reason: string;
  error: string | null;
  clash: TrayClash | null;
  save_now: boolean;
  photo: { status: string; error: string | null; url?: string | null } | null;
  title?: string;
  sub?: string;
  draft?: boolean;
  next?: boolean;
  detail?: RecipeDetail;
  add?: boolean;
  current?: boolean;
  edits?: string[];
  notes?: string[];
  preview?: { name: string; items: string[] }[];
  optional?: number;
  recipe?: { url: string; image: string };
}

/** The whole tray as the panel draws it. */
export interface TrayView {
  id: string;
  state: TrayStatus;
  count: number;
  needs_list: boolean;
  balance: WeekBalance | null;
  list_current: boolean;
  review: { flags: number; optional: number } | null;
  can_save: boolean;
  blocked: string;
  expires_at: string;
  expires_day: string;
  items: TrayCard[];
}
