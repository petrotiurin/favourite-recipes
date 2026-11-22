// The home page's order and the small pieces of a recipe list: which recipes show, in what order, and how a tile names its meal.
import type { RecipeFrontmatter } from "../../shared/recipe.ts";
import { isThisWeek, isNextWeek, isHiddenUntilNextWeek } from "./status.ts";

type Listed = Pick<RecipeFrontmatter, "title" | "course" | "draft" | "current" | "next">;

/** The home page's filters, in order (Drink has no filter). */
export const FILTER_COURSES = ["Breakfast", "Lunch", "Dinner", "Snack"] as const;

// This week's tiles sit together by meal, in the filters' order (a recipe with two courses goes by its first).
const courseRank = (r: Pick<Listed, "course">): number => {
  const i = (FILTER_COURSES as readonly string[]).indexOf((r.course ?? [])[0] ?? "");
  return i === -1 ? FILTER_COURSES.length : i;
};

/** `course-dinner`, one class per course, for the filter's CSS. */
export const courseClasses = (r: Pick<Listed, "course">): string[] => (r.course ?? []).map((c) => `course-${String(c).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);

/** "Lunch · Dinner": the meal(s), as plain text. */
export const courseLabel = (r: Pick<Listed, "course">): string => (r.course ?? []).join(" · ");

/**
 * What the home page lists. Drafts planned only for next week aren't on it at all (search can't find them either) until the switch: they
 * live on the Next week page. Recipes arrive with this week first (drafts first), then the rest; this week is regrouped by meal, the order
 * it arrived in holding inside each meal. `restStart` is the index where "The rest of the book" begins (-1 when nothing follows this week).
 * Next week's other recipes sit in the rest, unmarked.
 */
export function indexOrder<T extends Listed>(recipes: readonly T[]): { shown: T[]; restStart: number } {
  const visible = recipes.filter((r) => !isHiddenUntilNextWeek(r));
  const shown = [...visible.filter(isThisWeek).sort((a, b) => courseRank(a) - courseRank(b)), ...visible.filter((r) => !isThisWeek(r))];
  return { shown, restStart: shown.findIndex((r) => !isThisWeek(r)) };
}

/** The Next week page's recipes: everything planned for next week, alphabetical. */
export const nextWeekRecipes = <T extends Listed>(recipes: readonly T[]): T[] => recipes.filter(isNextWeek).sort((a, b) => a.title.localeCompare(b.title));
