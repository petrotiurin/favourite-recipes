// Recipe status. Two weeks, both independent of `draft` (not tried yet):
//   `current: true`  this week: what's being cooked now, shown at the top of the home page
//   `next: true`     next week: what's being planned; listed on next-week.html, and
//                    what the shopping list is for
// A recipe can be in both weeks. A draft that's only in next week is left off the home page
// (and so out of search) until the switch makes it this week's. Keep in sync with mcp-server/lib/recipes.js.
import type { RecipeFrontmatter } from "../../shared/recipe.ts";

type Flags = Pick<RecipeFrontmatter, "draft" | "current" | "next">;
type Titled = Flags & Pick<RecipeFrontmatter, "title">;

export const isDraft = (r: Flags): boolean => r.draft === true;
export const isThisWeek = (r: Flags): boolean => r.current === true;
export const isNextWeek = (r: Flags): boolean => r.next === true;
export const isHiddenUntilNextWeek = (r: Flags): boolean => isDraft(r) && isNextWeek(r) && !isThisWeek(r);
// Home page order: this week (drafts first), then the rest of the book; alphabetical within each.
export const rank = (r: Flags): number => (isThisWeek(r) ? (isDraft(r) ? 0 : 1) : 2);
export const byStatusThenTitle = (a: Titled, b: Titled): number => rank(a) - rank(b) || a.title.localeCompare(b.title);
