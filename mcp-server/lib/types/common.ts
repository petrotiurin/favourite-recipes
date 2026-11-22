// Types every backend module shares. The data shapes themselves (recipe, ingredient, catalogue, shopping list, chat events) are zod schemas in
// ../../shared/ and their `z.infer` types are imported from there; this folder holds the backend's own shapes on top of them:
//   common.ts     who is calling, the weeks
//   recipe.ts     a recipe as the backend reads it and the inputs of the recipe tools, the cached index and its rows
//   catalogue.ts  a catalogue change (the input of the catalogue tools)
//   shopping.ts   the shopping list builder's rows, edits and reports, stocktake updates
//   tray.ts       the plan tray: its items, the operations they hold, the cards the panel draws
//   rows.ts       the Supabase rows (conversations, messages, trays, photo_reads) and what is stored in their jsonb columns
import type { RecipeFrontmatter } from "../../../shared/recipe.ts";

/** Who is asking. `public`: read tools only. `editor`: a signed-in editor (chat). `agent`: the MCP bearer, or an upload link. */
export type Role = "public" | "editor" | "agent";

/** A caller as the transports build it (lib/tools.ts makeCaller freezes it). Never built from request data. */
export interface Caller {
  readonly role: Role;
  readonly email?: string | null;
  readonly userId?: string;
  readonly ip?: string;
  readonly via?: string;
}

/** The two weeks: `current: true` is this week, `next: true` is next week. */
export type Week = "this" | "next";

export type Course = NonNullable<RecipeFrontmatter["course"]>[number];

/** The options bag of the functions that take a clock for tests. */
export type Now = () => number;
