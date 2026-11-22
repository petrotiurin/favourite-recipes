import type { CatalogueEntry } from "../../../shared/catalogue.ts";
import type { StoredIngredient } from "../../../shared/recipe.ts";

/**
 * One catalogue change as a tool takes it (docs/structured-ingredients.md section 5). Exactly one key is set: the tools' schemas allow any
 * combination, so applyCatalogueChange checks that at run time.
 */
export interface CatalogueChange {
  /** A new item. */
  add?: { id: string } & CatalogueEntry;
  /** Another name for an item. */
  alias?: { item: string; name: string };
  /** Edit an item (per merges; a new unit replaces the conversions). */
  set?: { item: string } & Partial<Pick<CatalogueEntry, "name" | "section" | "unit" | "per" | "staple" | "skip">>;
  /** `from` becomes aliases of `into`; recipes using `from` are re-pointed. */
  merge?: { into: string; from: string };
  /** Only when no recipe uses it. */
  remove?: { item: string };
}

/** The re-pointing a merge asks for in the recipes. */
export interface Repoint {
  from: string;
  into: string;
}

/** What applyCatalogueChange resolves. */
export interface CatalogueChangeResult {
  catalogue: Record<string, CatalogueEntry>;
  line: string;
  repoint?: Repoint;
}

/** What applyCatalogueChanges resolves. */
export interface CatalogueChangesResult {
  catalogue: Record<string, CatalogueEntry>;
  lines: string[];
  repoints: Repoint[];
}

/** The slice of a recipe the catalogue's checks read: its slug and its ingredient lines (a file's, so `item` is there). */
export interface BookIngredients {
  slug: string;
  ingredients?: StoredIngredient[];
}
