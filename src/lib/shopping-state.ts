// The shopping page's numbers and what the browser keeps for it (src/islands/Shopping.tsx draws them; templates/shopping.js did before step 7).
// How much a row needs at the chosen servings, what is left to buy after the stocktake, how a fill row looks, and the localStorage the page keeps
// per list (ticks, servings, unsaved stocktake edits, a stocktake saved but not yet deployed, folded aisles). Nothing here imports zod (see
// shared/shopping-quantity.ts): the island is a browser module.
import { formatAmount, formatNumber, withUnit } from "../../shared/quantity.ts";
import { DEFAULT_SERVINGS } from "../../shared/servings.ts";
import { neededAmount, parseQuantity, type Plan } from "../../shared/shopping-quantity.ts";
import type { ShoppingItem } from "../../shared/shopping-list.ts";

export const MAX_SERVINGS = 12;
/** A row shows at most this many recipe photos, then "+n". */
export const ROW_PHOTOS = 3;

export interface RecipeRef {
  title: string;
  image: string;
  href: string;
}
/** What the page hands the island (Astro writes it into the page as props). */
export interface ShoppingProps {
  /** slug -> the agent's planned servings, for every recipe the list covers. */
  plan: Plan;
  /** Identifies this list (not its stocktake): the browser's ticks and unsaved edits belong to one version. */
  version: string;
  /** When the stocktake in the list was saved, or null. */
  stocktake: string | null;
  sections: { name: string; items: ShoppingItem[] }[];
  recipes: Record<string, RecipeRef>;
  /** The /stocktake endpoint, when this build lets an editor save a stocktake. */
  stocktakeApi: string | null;
}

/** Ids of the items at home: true (enough) or how much, in the item's own unit. */
export type Have = Record<string, boolean | number>;

export interface Row {
  id: string;
  item: ShoppingItem;
  amount?: number;
  unit: string;
}
export interface Aisle {
  name: string;
  rows: Row[];
}

/** The aisles' rows with an id each (`section-item`) and the quantity's number and unit. */
export function buildAisles(sections: ShoppingProps["sections"]): Aisle[] {
  return sections.map((section, si) => ({
    name: section.name,
    rows: section.items.map((item, ii) => {
      const q = parseQuantity(item.quantity);
      return { id: `${si}-${ii}`, item, ...(q ? { amount: q.amount } : {}), unit: q?.unit ?? "" };
    }),
  }));
}

/** The slugs of the plan, in its order. */
export const planSlugs = (plan: Plan): string[] => Object.keys(plan);
export function samePlan(a: Plan | null | undefined, b: Plan, slugs: string[] = planSlugs(b)): boolean {
  return slugs.every((slug) => !!a && !!b && a[slug] === b[slug]);
}
/** The one number every recipe is on, or null when they differ. */
export function uniform(map: Plan, slugs: string[]): number | null {
  const first = map[slugs[0]];
  return slugs.every((slug) => map[slug] === first) ? first : null;
}

// --- quantities ---

/** How much of the row the chosen servings need, in its unit; null for a quantity with no number. */
export function need(row: Row, servings: Plan): number | null {
  return row.amount === undefined ? null : neededAmount(row.item, servings);
}
export function needText(row: Row, servings: Plan): string {
  if (row.amount === undefined) return row.item.quantity || "";
  const n = need(row, servings)!;
  return Math.abs(n - row.amount) < 1e-9 ? row.item.quantity || "" : formatAmount(n, row.unit);
}
export const amountText = (row: Row, value: number): string => formatAmount(value, row.unit);

/** Slider steps: halves for a few of something, else 1; grams and millilitres by a round step that suits the amount. */
export function stepFor(row: Row, servings: Plan): number {
  const n = need(row, servings) ?? 0;
  if (!/^(g|kg|ml|l)$/i.test(row.unit)) return n < 4 ? 0.5 : 1;
  return n >= 1000 ? 100 : n >= 400 ? 50 : n >= 100 ? 25 : n >= 30 ? 10 : 5;
}

/** { status: "buy" | "partial" | "home", left } at the chosen servings, for a stocktake `h`. */
export function remaining(row: Row, h: Have, servings: Plan): { status: "buy" | "partial" | "home"; left: number | null } {
  const v = h[row.id];
  if (v === true) return { status: "home", left: 0 };
  if (typeof v === "number" && v > 0 && row.amount !== undefined) {
    const left = need(row, servings)! - v;
    return left > 1e-9 ? { status: "partial", left } : { status: "home", left: 0 };
  }
  return { status: "buy", left: need(row, servings) };
}

/** A stocktake value as a number for comparing: true stays true, an amount stays, nothing is 0. */
export const norm = (v: boolean | number | undefined): true | number => (v === true ? true : typeof v === "number" && v > 0 ? v : 0);
export function changedCount(rows: Row[], draft: Have | null, have: Have): number {
  if (!draft) return 0;
  return rows.filter((r) => norm(draft[r.id]) !== norm(have[r.id])).length;
}
export function counts(rows: Row[], h: Have, servings: Plan): { buy: number; home: number; partly: number } {
  const c = { buy: 0, home: 0, partly: 0 };
  for (const row of rows) {
    const s = remaining(row, h, servings).status;
    if (s === "home") c.home++;
    else {
      c.buy++;
      if (s === "partial") c.partly++;
    }
  }
  return c;
}
export function shortDate(iso: string | null): string {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export interface FillState {
  level: "all" | "some" | "none";
  value: number;
  pct: number;
  amt: string;
  changed: boolean;
}
/** How a row on the "At home" tab looks for the unsaved edits (`v`: its value in the draft, else in the saved stocktake). */
export function fillState(row: Row, draft: Have | null, have: Have, servings: Plan): FillState {
  const v = draft ? draft[row.id] : have[row.id];
  const n = need(row, servings);
  const level = v === true || (typeof v === "number" && n !== null && v >= n - 1e-9) ? "all" : typeof v === "number" && v > 0 ? "some" : "none";
  const amt = level === "some" ? `${formatNumber(v as number, row.unit)} / ${withUnit(formatNumber(n as number, row.unit), row.unit)}` : needText(row, servings);
  return {
    level,
    value: typeof v === "number" ? Math.min(v, n as number) : level === "all" ? (n as number) : 0,
    pct: level === "all" ? 100 : level === "some" ? Math.round(((v as number) / (n as number)) * 100) : 0,
    amt,
    changed: !!draft && norm(draft[row.id]) !== norm(have[row.id]),
  };
}
/** A slider position (0..need) as a stocktake value: all of it is `true`, so it doesn't depend on servings. */
export const fromSlider = (n: number, value: number): true | number => (value >= n - 1e-9 ? true : value);

// --- what the browser keeps (localStorage; it can throw in private mode or with storage blocked, and everything still works without it) ---

export const keysFor = (version: string) => ({
  plan: `shopping-plan:${version}`,
  ticks: `shopping-ticks:${version}`,
  pending: `shopping-stocktake:${version}`,
  draft: `shopping-draft:${version}`,
});
export const COLLAPSED_KEY = "shopping-collapsed";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* kept for this page view only */
  }
}

export interface Local {
  servings: Plan;
  ticks: string[];
  have: Have;
  stocktakeAt: string | null;
  draft: Have | null;
  collapsed: string[];
}

/** What the page has when it loads with nothing kept: the plan, and the stocktake the list was built with. */
export function initialLocal(props: ShoppingProps, aisles: Aisle[]): Local {
  const have: Have = {};
  for (const { rows } of aisles) for (const r of rows) if (r.item.have !== undefined) have[r.id] = r.item.have;
  return { servings: { ...props.plan }, ticks: [], have, stocktakeAt: props.stocktake, draft: null, collapsed: [] };
}

/**
 * What this browser kept for this list: servings changes (dropped when the agent changes the plan, so a new plan always shows), ticks, unsaved
 * stocktake edits, a stocktake saved from here that the site hasn't redeployed with yet (dropped once the site has one that new), and the aisles
 * folded away. Also forgets what was kept for other lists, and the old one-number servings pick.
 */
export function loadLocal(props: ShoppingProps, aisles: Aisle[]): Local {
  const keys = keysFor(props.version);
  try {
    // Ticks, unsaved edits and saved-but-not-yet-deployed stocktakes belong to one list: drop other lists' ones.
    const mine = Object.values(keys);
    for (const k of Object.keys(localStorage)) {
      if (/^shopping-(ticks|stocktake|draft|plan):/.test(k) && !mine.includes(k)) localStorage.removeItem(k);
    }
    localStorage.removeItem("shopping-servings");
  } catch {
    /* nothing kept */
  }
  const local = initialLocal(props, aisles);

  const pending = load<{ saved?: string; have: Have } | null>(keys.pending, null);
  if (pending && pending.saved && (!props.stocktake || pending.saved > props.stocktake)) {
    local.have = pending.have;
    local.stocktakeAt = pending.saved;
  } else save(keys.pending, undefined);

  const slugs = planSlugs(props.plan);
  const storedPlan = load<{ plan: Plan; servings?: Plan } | null>(keys.plan, null);
  if (storedPlan && samePlan(storedPlan.plan, props.plan, slugs) && storedPlan.servings) {
    for (const slug of slugs) {
      const n = storedPlan.servings[slug];
      if (n >= 1 && n <= MAX_SERVINGS && n === Math.round(n)) local.servings[slug] = n;
    }
  } else save(keys.plan, undefined);

  local.ticks = load<string[]>(keys.ticks, []);
  local.draft = load<Have | null>(keys.draft, null);
  local.collapsed = load<string[]>(COLLAPSED_KEY, []);
  return local;
}

export const servingsOf = (servings: Plan, slug: string): number => servings[slug] || DEFAULT_SERVINGS;
