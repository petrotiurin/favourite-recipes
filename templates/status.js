// Recipe status. A recipe is in one of three tiers, always listed in this order:
//   1. draft (`draft: true`)     not tried yet; drafts are always current
//   2. current (`current: true`)  a regular recipe picked for the current rotation
//   3. everything else
// The shopping list covers every current recipe (drafts + current).
const isDraft = (r) => r.draft === true;
const isCurrent = (r) => r.draft === true || r.current === true;
const rank = (r) => (isDraft(r) ? 0 : isCurrent(r) ? 1 : 2);
const byStatusThenTitle = (a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title);

module.exports = { isDraft, isCurrent, rank, byStatusThenTitle };
