import type { Ingredient, RecipeFrontmatter, StoredIngredient } from "../../../shared/recipe.ts";
import type { CatalogueChange } from "./catalogue.ts";
import type { CommitResult } from "../github.ts";
import type { Course, Week } from "./common.ts";

export type { Ingredient, RecipeFrontmatter, StoredIngredient };

/**
 * A recipe file's frontmatter as parsed. The build validates every file against the zod schema (shared/recipe.ts), so the backend reads it as
 * a valid recipe: this type says that, it doesn't check it. Keys the schema doesn't know are kept (renderFrontmatter writes them back).
 */
export type RecipeData = RecipeFrontmatter & Record<string, unknown>;

/** One "## heading" section of a recipe body; `heading` is null for the preamble. */
export interface RecipeSection {
  heading: string | null;
  content: string;
}

/** A recipe as list_recipes shows it: the numbers, the flags that are set (the others are left out). */
export interface ListRow {
  slug: string;
  title: string;
  course: Course[];
  tags: string[];
  total_mins: number;
  serves: number;
  calories: number;
  scalable?: false;
  draft?: true;
  current?: true;
  next?: true;
}

/** A list row with the recipe's structured ingredients: what the shopping list and the catalogue checks work from. */
export type BookRecipe = ListRow & { ingredients: StoredIngredient[] };

/** A list row with the ingredient names, for matching against what's at home. */
export type IngredientRow = ListRow & { ingredients: string[]; items: StoredIngredient[] };

/** What the cached recipe index holds about each recipe (lib/recipes.ts recipeIndex). */
export interface IndexEntry {
  data: RecipeData;
  /** The whole file. */
  markdown: string;
  slug: string;
  title: string;
  course: Course[];
  tags: string[];
  total_mins: number;
  calories: number;
  /** Site path of the photo, or "". */
  image: string;
  draft: boolean;
  current: boolean;
  next: boolean;
  /** The ingredient names, trimmed. */
  ingredients: string[];
  items: StoredIngredient[];
  /** The title and body, lower case, for text search. */
  text: string;
}

/** An index entry without its heavy parts (recipeSummaries: the chat's UI tools). */
export type RecipeSummary = Omit<IndexEntry, "ingredients" | "items" | "text" | "data" | "markdown">;

/** A search_recipes row. */
export type SearchRow = Omit<RecipeSummary, "image"> & { url: string };

export interface SearchFilters {
  text?: string;
  include_ingredients?: string[];
  exclude_ingredients?: string[];
  course?: string;
  tags?: string[];
  max_calories?: number;
  max_minutes?: number;
  draft?: boolean;
  week?: "this" | "next" | "none";
}

/** One row of the chat prompt's compact catalogue of the book. */
export interface BookCatalogueRow {
  slug: string;
  title: string;
  course: Course[];
  tags: string[];
  mins: number;
  kcal: number;
  status: "draft" | "regular";
  week: "this" | "next" | "both" | "none";
  ingredients: string[];
}

/** The hero photo input of create_recipe / update_recipe: exactly one of generate / url / uploaded / base64 (checked at run time). */
export interface ImageInput {
  generate?: true;
  description?: string;
  uploaded?: true;
  url?: string;
  base64?: string;
  /** Set by startImageGenerations: a dry run generates nothing. */
  skip?: true;
  /** Set by startImageGenerations: the generation that is already running. */
  pending?: Promise<Buffer>;
}

/** The fields of the create_recipe tool (and of the `create_recipe` operation of batch_changes and the tray). */
export interface CreateRecipeInput {
  title: string;
  course: Course[];
  tags?: string[];
  total_mins: number;
  serves: number;
  calories: number;
  scalable?: boolean;
  ingredients: Ingredient[];
  catalogue?: CatalogueChange[];
  instructions: string[];
  notes?: string;
  image?: ImageInput;
  draft?: boolean;
  week?: Week;
}

/** The fields of the update_recipe tool: `slug`, and only what changes. */
export interface UpdateRecipeInput {
  slug: string;
  title?: string;
  course?: Course[];
  tags?: string[];
  total_mins?: number;
  serves?: number;
  calories?: number;
  scalable?: boolean;
  ingredients?: Ingredient[];
  catalogue?: CatalogueChange[];
  instructions?: string[];
  notes?: string;
  image?: ImageInput;
}

// --- what the recipe writers resolve (lib/recipes.ts). `commit` is null when the write only staged into a ChangeSet (a batch, the tray). ---

export interface CreateRecipeResult {
  slug: string;
  markdown: string;
  commit: CommitResult | null;
  subject: string;
  draft: boolean;
  week: Week | null;
  catalogueLines: string[];
  warnings: string[];
}

export interface UpdateRecipeResult {
  slug: string;
  markdown: string;
  commit: CommitResult | null;
  subject: string | null;
  catalogueLines?: string[];
  warnings: string[];
}

export interface PromoteRecipeResult {
  slug: string;
  markdown: string;
  commit: CommitResult | null;
  subject: string;
}

export interface RemoveDraftResult {
  slug: string;
  title: string;
  removedImages: string[];
  commit: CommitResult | null;
  subject: string;
}

export interface SetWeekResult {
  changed: string[];
  unchanged: string[];
  week: Week;
  add: boolean;
  commit: CommitResult | null;
  subject: string | null;
}

/** The switch's report: which recipes went where. */
export interface SwitchReport {
  /** Were next week's, now this week's. */
  started: string[];
  /** Were in both weeks and stay in this week. */
  stayed: string[];
  /** Carried over in this week by choice. */
  carried: string[];
  /** Left this week and went back to the book. */
  left: string[];
  /** Drafts that left this week (they stay in the book). */
  droppedDrafts: string[];
}
export interface StartNextWeekResult extends SwitchReport {
  thisWeek: string[];
  commit: CommitResult | null;
  subject: string | null;
}

/** The subject of a generated photo: what it's drawn from. */
export interface DishSubject {
  title: string;
  ingredients: (Ingredient | StoredIngredient)[];
  description?: string;
}
