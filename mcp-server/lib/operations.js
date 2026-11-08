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
} from "./recipes.js";
import { updateShoppingList, setShoppingServings, updateStocktake } from "./shopping-list.js";

/** Applies one batch_changes operation to the ChangeSet and returns its report lines. */
export async function runOperation(op, cs, caller) {
  const { action, ...args } = op;
  const warn = (warnings) => (warnings?.length ? warnings.map((w) => `  warning: ${w}`) : []);
  switch (action) {
    case "create_recipe": {
      const r = await createRecipe(args, cs, caller);
      const tags = [r.draft ? "draft" : null, r.week ? `${r.week} week` : null].filter(Boolean).join(", ");
      return { ...r, nextChanged: r.week === "next", lines: [`Created "${r.slug}"${tags ? ` (${tags})` : ""}: ${pageUrl(r.slug)}`, ...warn(r.warnings)] };
    }
    case "update_recipe": {
      const r = await updateRecipe(args, cs, caller);
      return { ...r, lines: [r.subject ? `${r.subject}: ${pageUrl(r.slug)}` : `"${r.slug}": no changes, it already matches`, ...(r.subject ? warn(r.warnings) : [])] };
    }
    case "promote_recipe": {
      const r = await promoteRecipe(args.slug, cs, caller);
      return { ...r, lines: [`Promoted "${r.slug}" (draft -> regular, its weeks unchanged)`] };
    }
    case "remove_draft": {
      const r = await removeDraft(args.slug, cs, caller);
      return { ...r, lines: [`Removed draft "${r.slug}" (recipe${r.removedImages.length ? " and photo" : ""} deleted)`] };
    }
    case "set_week_recipes": {
      const r = await setWeekRecipes(args.slugs, args.week, args.add, cs, caller);
      return { ...r, nextChanged: args.week === "next" && r.changed.length > 0, lines: weekLines(r) };
    }
    case "start_next_week": {
      const r = await startNextWeek(args.carry_over, cs, caller);
      // Only empties next week, which leaves the saved list showing as it is: nothing to refresh.
      return { ...r, lines: switchLines(r) };
    }
    case "update_shopping_list": {
      const r = await updateShoppingList(args.sections, cs, args.servings, caller);
      const items = r.list.sections.reduce((n, sec) => n + sec.items.length, 0);
      const plan = Object.entries(r.list.servings).map(([slug, n]) => `${slug} x${n}`).join(", ");
      return { ...r, shoppingList: true, lines: [`Shopping list: ${items} items in ${r.list.sections.length} sections, covering ${plan}`] };
    }
    case "set_shopping_servings": {
      const r = await setShoppingServings(args.servings, cs, caller);
      return { ...r, lines: [r.changed.length ? `Planned servings: ${r.changed.map(([slug, n]) => `${slug} x${n}`).join(", ")}` : "set_shopping_servings: already planned like that"] };
    }
    case "update_stocktake": {
      // chat only (the tray's "At home" card); not a batch_changes operation
      const r = await updateStocktake(args.items, cs, caller, { signature: args.list_sig });
      return { ...r, lines: [`At home: ${r.changed.map((c) => `${c.name} ${c.have === true ? "(enough)" : c.have ? c.have : "(none)"}`).join(", ")}`] };
    }
    default:
      throw new UserError(`Unknown action "${action}"`);
  }
}

const WEEK_NAME = { this: "this week", next: "next week" };

export function weekLines({ changed, unchanged, week, add }) {
  const lines = [changed.length ? `${add ? "Added to" : "Taken out of"} ${WEEK_NAME[week]}: ${changed.join(", ")}` : "set_week_recipes: nothing changed"];
  if (unchanged.length) lines.push(`  already ${add ? "in" : "not in"} ${WEEK_NAME[week]}: ${unchanged.join(", ")}`);
  return lines;
}

export function switchLines({ started, stayed, carried, left, droppedDrafts, subject }) {
  const list = (xs) => (xs.length ? xs.join(", ") : "none");
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
