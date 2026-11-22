// The house icon language (design.md): one outline set on a 24px grid with round caps, as the path data, so the `.astro` components
// (Icon.astro) and the Preact islands (islands/Icon.tsx) draw the same icons. Constants only: nothing here comes from a user or a model.
export type IconName =
  | "search" | "arrow" | "back" | "cart" | "chevron" | "house" | "house-some" | "house-all" | "house-clear" | "slide" | "check" | "undo" | "person" | "close" | "minus" | "plus" | "sun" | "external";

const HOUSE = '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>';

/** `filled`: the shapes are painted with the text colour as well (the "have it all" house). */
export const ICONS: Record<IconName, { stroke: number; paths: string; filled?: boolean }> = {
  search: { stroke: 1.8, paths: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>' },
  arrow: { stroke: 2, paths: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>' },
  back: { stroke: 1.8, paths: '<path d="M15 5l-7 7 7 7"/>' },
  cart: { stroke: 1.8, paths: '<path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>' },
  chevron: { stroke: 2, paths: '<path d="M6 9l6 6 6-6"/>' },
  house: { stroke: 2, paths: HOUSE },
  "house-some": { stroke: 2, paths: `${HOUSE}<rect x="5" y="14" width="14" height="6" fill="currentColor"/>` },
  "house-all": { stroke: 2, paths: '<path d="M3 11l9-7 9 7v9H3z"/>', filled: true },
  "house-clear": { stroke: 2, paths: `${HOUSE}<path d="M9 13l6 6M15 13l-6 6"/>` },
  // The shopping page's controls and the sign-in sheet's.
  slide: { stroke: 2, paths: '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>' },
  check: { stroke: 2, paths: '<path d="M5 12l5 5 9-10"/>' },
  undo: { stroke: 2, paths: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>' },
  person: { stroke: 2, paths: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>' },
  close: { stroke: 2, paths: '<path d="M6 6l12 12M18 6L6 18"/>' },
  minus: { stroke: 2, paths: '<path d="M6 12h12"/>' },
  plus: { stroke: 2, paths: '<path d="M12 6v12M6 12h12"/>' },
  // "Keep screen on".
  sun: { stroke: 1.8, paths: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  // "Opens elsewhere" (Cook with Claude).
  external: { stroke: 1.8, paths: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>' },
};
