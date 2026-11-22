// The household plan tray as the panel sees it (docs/chatbot-design.md 7.1): GET /chat/plan reduced to plain values, and the words and the one
// button the strip shows. Pure; src/lib/chat/tray.ts loads it and src/islands/chat/Tray.tsx draws it.
import { safeHref } from "./render.ts";

export const TRAY_KINDS = {
  switch: { label: "Switch", cls: "kicker-current" },
  promote: { label: "Promote", cls: "" },
  remove: { label: "Remove", cls: "" },
  new: { label: "New", cls: "kicker-draft" },
  next: { label: "Next week", cls: "kicker-next" },
  edit: { label: "Edit", cls: "" },
  catalogue: { label: "Catalogue", cls: "" },
  list: { label: "List", cls: "" },
  servings: { label: "Servings", cls: "" },
  stocktake: { label: "At home", cls: "" },
} as const;
export type TrayKind = keyof typeof TRAY_KINDS;

export interface TrayItem {
  id: string;
  kind: TrayKind;
  title: string;
  sub: string;
  added_by: string;
  reason: string;
  error: string;
  clash: { reason: string } | null;
  save_now: boolean;
  draft: boolean;
  add: boolean;
  current: boolean;
  photo: { status: "pending" | "ready" | "failed"; url: string; error: string } | null;
  recipe: { url: string; image: string } | null;
  detail?: { ingredients: string[]; sections: (string | null)[]; steps: string[]; notes: string };
  edits?: string[];
  notes?: string[];
  preview?: { name: string; items: string[] }[];
}
export interface Balance {
  recipes: number;
  dinners: number;
  avg_kcal: number;
  total_mins: number;
}
export interface Tray {
  id: string;
  balance: Balance | null;
  state: "collecting" | "finalising" | "ready";
  count: number;
  needs_list: boolean;
  list_current: boolean;
  can_save: boolean;
  blocked: string;
  expires_at: string;
  expires_day: string;
  items: TrayItem[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v) : 0;
}

/**
 * The plan tray as GET /chat/plan returns it, reduced to plain values: strings cut, links only on this site's origin, staged photos only from
 * the Supabase signed-URL path (photoBase). null when there is no tray.
 */
export function cleanTray(raw: unknown, origin: string, photoBase: string): Tray | null {
  if (!isObj(raw) || !Array.isArray(raw.items)) return null;
  const items: TrayItem[] = [];
  raw.items.forEach((i: unknown) => {
    if (!isObj(i) || !/^[a-f0-9]{8}$/.test(String(i.id)) || typeof i.kind !== "string" || !Object.prototype.hasOwnProperty.call(TRAY_KINDS, i.kind)) return;
    let photo: TrayItem["photo"] = null;
    if (isObj(i.photo)) {
      const url = typeof i.photo.url === "string" && photoBase && i.photo.url.indexOf(`${photoBase}/storage/v1/object/sign/`) === 0 ? i.photo.url : "";
      const status = i.photo.status === "pending" || i.photo.status === "ready" || i.photo.status === "failed" ? i.photo.status : "failed";
      photo = { status, url, error: str(i.photo.error, 160) };
    }
    const recipe = isObj(i.recipe) ? { url: safeHref(i.recipe.url, origin) || "", image: i.recipe.image ? safeHref(i.recipe.image, origin) || "" : "" } : null;
    const item: TrayItem = {
      id: i.id as string,
      kind: i.kind as TrayKind,
      title: str(i.title, 120),
      sub: str(i.sub, 160),
      added_by: str(i.added_by, 40),
      reason: str(i.reason, 100),
      error: i.error ? str(i.error, 300) : "",
      clash: isObj(i.clash) ? { reason: str(i.clash.reason, 200) } : null,
      save_now: i.save_now === true,
      draft: i.draft === true,
      add: i.add !== false,
      current: i.current === true,
      photo,
      recipe,
    };
    if (isObj(i.detail)) {
      const list = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 60);
      item.detail = {
        ingredients: list(i.detail.ingredients).map((x) => str(x, 160)),
        sections: list(i.detail.sections).map((x) => (x ? str(x, 40) : null)),
        steps: list(i.detail.steps).map((x) => str(x, 400)),
        notes: str(i.detail.notes, 800),
      };
    }
    if (i.kind === "list") {
      item.edits = (Array.isArray(i.edits) ? i.edits : []).slice(0, 30).map((x) => str(x, 120)).filter(Boolean);
      item.notes = (Array.isArray(i.notes) ? i.notes : []).slice(0, 5).map((x) => str(x, 300)).filter(Boolean);
    }
    if (Array.isArray(i.preview)) {
      item.preview = i.preview.slice(0, 20).map((sec: unknown) => {
        const s = isObj(sec) ? sec : null;
        return { name: str(s && s.name, 60), items: (Array.isArray(s && s.items) ? (s!.items as unknown[]) : []).slice(0, 80).map((x) => str(x, 100)) };
      });
    }
    items.push(item);
  });
  const b = isObj(raw.balance) ? raw.balance : null;
  return {
    id: str(raw.id, 64),
    balance: b ? { recipes: num(b.recipes), dinners: num(b.dinners), avg_kcal: num(b.avg_kcal), total_mins: num(b.total_mins) } : null,
    state: raw.state === "collecting" || raw.state === "finalising" || raw.state === "ready" ? raw.state : "collecting",
    count: items.length,
    needs_list: raw.needs_list === true,
    list_current: raw.list_current === true,
    can_save: raw.can_save === true,
    blocked: str(raw.blocked, 120),
    expires_at: str(raw.expires_at, 40),
    expires_day: str(raw.expires_day, 12),
    items,
  };
}

/** "Next week after Save: 5 recipes · 3 dinners · ~420 kcal each · 2 h 15 min in all", from the numbers the server computed, or "". */
export function balanceLine(b: Balance | null | undefined): string {
  if (!b || !b.recipes) return "";
  const mins = b.total_mins;
  const time = mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
  return `Next week after Save: ${b.recipes}${b.recipes === 1 ? " recipe" : " recipes"} · ${b.dinners}${b.dinners === 1 ? " dinner" : " dinners"}${b.avg_kcal ? ` · ~${b.avg_kcal} kcal each` : ""}${mins ? ` · ${time} in all` : ""}`;
}

/** "Tray · 8 changes" (the folded line), with "until Fri" when it's open. */
export function trayLine(tray: Pick<Tray, "count" | "expires_day">, folded: boolean): string {
  return `Tray · ${tray.count} change${tray.count === 1 ? "" : "s"}${!folded && tray.expires_day ? ` · until ${tray.expires_day}` : ""}`;
}

export const DAY = 24 * 60 * 60 * 1000;
export function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "The tray expires tomorrow" within the last day before it goes (and "today" in the last hours), else "". */
export function trayExpiryNotice(tray: Pick<Tray, "expires_at">, now: number): string {
  const left = Date.parse(tray.expires_at) - now;
  if (!(left > 0) || left > DAY) return "";
  return dayStart(new Date(tray.expires_at)) === dayStart(new Date(now)) ? "The tray expires today" : "The tray expires tomorrow";
}

export type TrayButton = { kind: "finalise" | "finalising" | "save" | "blocked"; label: string };
/** What the tray's one button is: "finalise" | "finalising" | "save" | "blocked", with its label. */
export function trayButton(tray: Pick<Tray, "can_save" | "count" | "state" | "needs_list" | "list_current"> & { items: { error?: string; clash?: unknown }[] }): TrayButton {
  if (tray.can_save) return { kind: "save", label: `Save to site (${tray.count})` };
  if (tray.state === "finalising") return { kind: "finalising", label: "Reviewing the list…" };
  if (tray.needs_list && !tray.list_current && !tray.items.some((i) => i.error || i.clash)) return { kind: "finalise", label: "Finalise list" };
  return { kind: "blocked", label: `Save to site (${tray.count})` };
}

export interface Reading {
  name: string;
  count: number;
  mine: boolean;
}
/** The tray strip's "Reading 3 photos · Sam" entries (GET /chat/plan `reading`): [{ name, count, mine }], names cut, at most 4. */
export function cleanReading(list: unknown): Reading[] {
  const out: Reading[] = [];
  (Array.isArray(list) ? list : []).forEach((e: unknown) => {
    if (out.length >= 4 || !isObj(e) || typeof e.count !== "number" || !(e.count >= 1)) return;
    out.push({ name: typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 40) : "Someone", count: Math.min(999, Math.floor(e.count)), mine: e.mine === true });
  });
  return out;
}
export function readingLine(e: Reading): string {
  return `Reading ${e.count} photo${e.count === 1 ? "" : "s"} · ${e.mine ? "you" : e.name}`;
}
/** The note by the Save button while someone else's photos are still being read (Save still works). */
export function readingSaveNote(entries: Reading[]): string {
  const others = entries.filter((e) => !e.mine);
  if (!others.length) return "";
  return `${others.map((e) => `${e.name} has ${e.count} photo${e.count === 1 ? "" : "s"} still being read`).join("; ")}.`;
}
