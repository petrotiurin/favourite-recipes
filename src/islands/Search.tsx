// The home page's search box (`client:load`): types filter the recipe tiles by title. The box is written at build time; the tiles are the
// page's own (Tile.astro) and are hidden or shown from here (src/lib/tile-filter.ts). The chat reads the box by its id (#recipe-search).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { filterTiles } from "../lib/tile-filter.ts";
import Icon from "./Icon.tsx";

export default function Search() {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // The box isn't controlled, so text typed before this loaded (or put back by the browser on Back) stays; pick it up.
  useEffect(() => setQuery(input.current?.value ?? ""), []);
  useLayoutEffect(() => filterTiles(document, query), [query]);
  return (
    <label class="search">
      <Icon name="search" />
      <span class="sr-only">Search recipes</span>
      <input
        ref={input}
        type="search"
        id="recipe-search"
        class="search-input"
        placeholder="Search recipes"
        autocomplete="off"
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
    </label>
  );
}
