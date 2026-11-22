// One batch_changes operation, applied to a ChangeSet (docs/chatbot-design.md 7.1): shared by the batch_changes tool and by the chat's
// plan tray (dry-run validation at staging, and Save), so both run exactly the same write logic.
import {
  createRecipe,
  updateRecipe,
  promoteRecipe,
  removeDraft,
  setWeekRecipes,
  startNextWeek,
  pageUrl,
  UserError,
} from "./recipes.ts";
import { updateShoppingList, buildAndSaveShoppingList, setShoppingServings, updateStocktake, builtReport } from "./shopping-list.ts";
import { stageCatalogueChanges } from "./recipes.ts";
import type { ChangeSet } from "./github.ts";
import type { Caller } from "./types/common.ts";
import type { ListRow, SetWeekResult, StartNextWeekResult, SwitchReport } from "./types/recipe.ts";
import type { StepOutcome, TrayOp } from "./types/tray.ts";

/** What one operation reports: its lines, plus what the batch and the tray read from it (the writer's own result is spread in, so more keys follow). */
export interface OperationOutcome extends StepOutcome {
  subject?: string | null;
  nextChanged?: boolean;
  shoppingList?: boolean;
  catalogueChanged?: boolean;
  next?: ListRow[];
  changed?: unknown[];
}

/** Applies one batch_changes operation to the ChangeSet and returns its report lines. */
export async function runOperation(op: TrayOp, cs: ChangeSet, caller: Caller | null | undefined): Promise<OperationOutcome> {
  const warn = (warnings: string[] | undefined): string[] => (warnings?.length ? warnings.map((w) => `  warning: ${w}`) : []);
  switch (op.action) {
    case "create_recipe": {
      const { action: _action, ...args } = op;
      const r = await createRecipe(args, cs, caller);
      const tags = [r.draft ? "draft" : null, r.week ? `${r.week} week` : null].filter(Boolean).join(", ");
      return { ...r, nextChanged: r.week === "next", lines: [`Created "${r.slug}"${tags ? ` (${tags})` : ""}: ${pageUrl(r.slug)}`, ...(r.catalogueLines || []).map((l) => `  ${l}`), ...warn(r.warnings)] };
    }
    case "update_recipe": {
      const { action: _action, ...args } = op;
      const r = await updateRecipe(args, cs, caller);
      return { ...r, lines: [r.subject ? `${r.subject}: ${pageUrl(r.slug)}` : `"${r.slug}": no changes, it already matches`, ...(r.catalogueLines || []).map((l) => `  ${l}`), ...(r.subject ? warn(r.warnings) : [])] };
    }
    case "promote_recipe": {
      const r = await promoteRecipe(op.slug, cs, caller);
      return { ...r, lines: [`Promoted "${r.slug}" (draft -> regular, its weeks unchanged)`] };
    }
    case "remove_draft": {
      const r = await removeDraft(op.slug, cs, caller);
      return { ...r, lines: [`Removed draft "${r.slug}" (recipe${r.removedImages.length ? " and photo" : ""} deleted)`] };
    }
    case "set_week_recipes": {
      const r = await setWeekRecipes(op.slugs, op.week, op.add, cs, caller);
      return { ...r, nextChanged: op.week === "next" && r.changed.length > 0, lines: weekLines(r) };
    }
    case "start_next_week": {
      const r = await startNextWeek(op.carry_over, cs, caller);
      // Only empties next week, which leaves the saved list showing as it is: nothing to refresh.
      return { ...r, lines: switchLines(r) };
    }
    case "update_shopping_list": {
      // build: true (docs/structured-ingredients.md 3): the server adds up next week's recipes; `sections` is the older, agent-written list
      if (!op.build === !op.sections) throw new UserError("update_shopping_list: pass build: true (the server builds the list), or sections, not both");
      const builtList = op.build ? await buildAndSaveShoppingList({ edits: op.edits }, cs, op.servings, caller) : undefined;
      const r = builtList ?? (await updateShoppingList(op.sections ?? [], cs, op.servings, caller));
      const items = r.list.sections.reduce((n, sec) => n + sec.items.length, 0);
      const plan = Object.entries(r.list.servings).map(([slug, n]) => `${slug} x${n}`).join(", ");
      return { ...r, shoppingList: true, lines: [`Shopping list: ${items} items in ${r.list.sections.length} sections, covering ${plan}`, ...builtReport(builtList?.built).map((l) => `  ${l}`)] };
    }
    case "set_shopping_servings": {
      const r = await setShoppingServings(op.servings, cs, caller);
      return { ...r, lines: [r.changed.length ? `Planned servings: ${r.changed.map(([slug, n]) => `${slug} x${n}`).join(", ")}` : "set_shopping_servings: already planned like that"] };
    }
    case "update_catalogue": {
      // review fixes that are generally true (docs/structured-ingredients.md section 5): no recipe to ride on
      const r = await stageCatalogueChanges(op.changes, cs);
      return { ...r, catalogueChanged: true, lines: r.lines.length ? r.lines : ["update_catalogue: nothing to change"] };
    }
    case "update_stocktake": {
      // chat only (the tray's "At home" card); not a batch_changes operation
      const r = await updateStocktake(op.items, cs, caller, { signature: op.list_sig });
      return { ...r, lines: [`At home: ${r.changed.map((c) => `${c.name} ${c.have === true ? "(enough)" : c.have ? c.have : "(none)"}`).join(", ")}`] };
    }
    default:
      throw new UserError(`Unknown action "${(op as { action?: unknown }).action}"`);
  }
}

const WEEK_NAME: Record<string, string> = { this: "this week", next: "next week" };

export function weekLines({ changed, unchanged, week, add }: Pick<SetWeekResult, "changed" | "unchanged" | "week" | "add">): string[] {
  const lines = [changed.length ? `${add ? "Added to" : "Taken out of"} ${WEEK_NAME[week]}: ${changed.join(", ")}` : "set_week_recipes: nothing changed"];
  if (unchanged.length) lines.push(`  already ${add ? "in" : "not in"} ${WEEK_NAME[week]}: ${unchanged.join(", ")}`);
  return lines;
}

export function switchLines({ started, stayed, carried, left, droppedDrafts, subject }: SwitchReport & Pick<StartNextWeekResult, "subject">): string[] {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  return [
    subject ? "Started next week: next week's recipes are now this week, and next week is empty." : "start_next_week: nothing to change (both weeks were already empty).",
    `  this week now: ${list([...started, ...stayed, ...carried])}`,
    ...(stayed.length ? [`  (already in this week too: ${stayed.join(", ")})`] : []),
    ...(carried.length ? [`  carried over from last week: ${carried.join(", ")}`] : []),
    ...(left.length ? [`  left this week: ${left.join(", ")}`] : []),
    ...(droppedDrafts.length ? [`  drafts back in the book (still drafts, in no week): ${droppedDrafts.join(", ")}`] : []),
    "  the shopping list is unchanged: the page keeps showing it until next week is planned and a new list saved",
  ];
}
