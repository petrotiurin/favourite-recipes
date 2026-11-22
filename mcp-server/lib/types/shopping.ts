import type { SECTIONS, SHOP_UNITS } from "../../../shared/catalogue.ts";
import type { ShoppingItem, ShoppingList, ShoppingSection } from "../../../shared/shopping-list.ts";

export type { ShoppingItem, ShoppingList, ShoppingSection };
/** One of the shopping list's aisles. */
export type Section = (typeof SECTIONS)[number];
/** A unit an item is bought in. */
export type ShopUnit = (typeof SHOP_UNITS)[number];
/** slug -> how many people the recipe is planned for. */
export type Servings = Record<string, number>;

/** The older, agent-written list: sections of items, each naming its next-week recipes (update_shopping_list's `sections`). */
export interface ShoppingSectionInput {
  name: string;
  items: {
    name: string;
    quantity?: string;
    note?: string;
    recipes?: string[];
    amounts?: Record<string, number>;
  }[];
}

/** One review patch on the built list, by catalogue item id: exactly one of the first seven keys (checked by the tool's schema). */
export interface ListEdit {
  round_up?: string;
  /** [into, from]: from's amounts are added to into. */
  merge?: [string, string];
  note?: { item: string; text: string };
  move?: { item: string; section: Section };
  rename?: { item: string; name: string };
  drop?: string;
  scale?: { item: string; factor: number };
  /** merge / move / rename only: also change the catalogue. */
  remember?: boolean;
}

/** What the user said is at home: `have` true (enough), an amount, or false / 0 to clear. */
export interface StockUpdate {
  name: string;
  have?: boolean | number;
}

/** An item as the page's stocktake sends it back: the list's items by name and quantity, with `have`. */
export interface StockItem {
  name: string;
  quantity?: string;
  have?: boolean | number;
}

export type ListStatus = "none" | "not planned" | "current" | "outdated";

/** What's left to buy of one item at the planned servings. */
export interface Remaining {
  status: "buy" | "partial" | "home";
  need: number | null;
  remaining: number | null;
}

/** One catalogue item next week needs, summed over the recipes (lib/shopping-list.ts listRows). */
export interface ShoppingRow {
  item: string;
  name: string;
  section: Section;
  /** The unit it's bought in; null for a staple (listed without a quantity). */
  unit?: ShopUnit | null;
  /** slug -> amount at 2 servings. */
  shares: Record<string, number>;
  recipes: string[];
  optional: boolean;
  notes: string[];
}

/** Something the model is asked to look at in the built list: a key that stays the same, the item (null for a recipe), and the text. */
export interface ReviewFlag {
  key: string;
  item: string | null;
  text: string;
}

/** A patch that no longer applies, and why. */
export interface StaleEdit {
  edit: ListEdit;
  why: string;
}

/** An item only optional ingredients need: the user is asked whether to keep it. */
export interface OptionalItem {
  item: string;
  name: string;
  quantity: string;
  recipes: string[];
}

/** A section of the built list: what rowsToSections writes (every item names its recipes; `amounts` are numbers, the recipes' shares). */
export interface BuiltSection {
  name: string;
  items: { name: string; quantity?: string; note?: string; recipes: string[]; amounts?: Record<string, number> }[];
}

/** What buildShoppingList resolves. */
export interface BuiltList {
  sections: BuiltSection[];
  rows: Map<string, ShoppingRow>;
  optional: OptionalItem[];
  droppedOptional: OptionalItem[];
  flags: ReviewFlag[];
  stale: StaleEdit[];
  /** Slugs of recipes with no ingredients recorded. */
  empty: string[];
  problems: string[];
}

/** The list as lib/shopping-list.ts writes it: dated, with the recipes it covers and the plan. */
export type StoredShoppingList = ShoppingList & { updated: string; recipes: string[]; servings: Servings };
