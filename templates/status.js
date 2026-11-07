// Recipe status. Two weeks, both independent of `draft` (not tried yet):
//   `current: true`  this week: what's being cooked now, shown at the top of the home page
//   `next: true`     next week: what's being planned; only shown under the "Next week" tab, and
//                    what the shopping list is for
// A recipe can be in both weeks. A draft that's only in next week is hidden from the rest of the
// home page (and search) until the switch makes it this week's. Keep in sync with mcp-server/lib/recipes.js.
const isDraft = (r) => r.draft === true;
const isThisWeek = (r) => r.current === true;
const isNextWeek = (r) => r.next === true;
const isHiddenUntilNextWeek = (r) => isDraft(r) && isNextWeek(r) && !isThisWeek(r);
// Home page order: this week (drafts first), then the rest of the book; alphabetical within each.
const rank = (r) => (isThisWeek(r) ? (isDraft(r) ? 0 : 1) : 2);
const byStatusThenTitle = (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title);

module.exports = { isDraft, isThisWeek, isNextWeek, isHiddenUntilNextWeek, rank, byStatusThenTitle };
