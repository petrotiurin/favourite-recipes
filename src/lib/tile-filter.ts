// The home page's search: every word typed has to be in a tile's title. The tiles are written at build time (Tile.astro); this only hides
// the ones that don't match, and marks the grid so the CSS hides its dividers while searching.

/** The words of a search box: lower case, split on whitespace. */
export const keywords = (query: string): string[] => query.toLowerCase().trim().split(/\s+/).filter(Boolean);

/** Hides the tiles whose title lacks any of the words; no words shows them all. */
export function filterTiles(root: ParentNode, query: string): void {
  const words = keywords(query);
  const grid = root.querySelector(".tile-grid");
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>(".tile").forEach((tile) => {
    const title = (tile.querySelector(".tile-title")?.textContent ?? "").toLowerCase();
    tile.style.display = words.every((w) => title.includes(w)) ? "" : "none";
  });
  grid.classList.toggle("is-searching", words.length > 0);
}
