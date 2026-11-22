// The chat's small words: the chats list's dates, the feedback note, the starter chips and the photo-reading line. Pure.
import type { PhotoState } from "./clean.ts";
import { DAY, dayStart } from "./tray-data.ts";

/** "Today" / "Yesterday" / "Mon 2 Nov" for when a chat was last updated. */
export function updatedLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const diff = Math.round((dayStart(new Date(now)) - dayStart(d)) / DAY);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
/** "until Sat" for when a chat goes away (with the date once it is more than a week off, so the weekday isn't ambiguous). */
export function expiryLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const days = Math.round((dayStart(d) - dayStart(new Date(now))) / DAY);
  if (days <= 0) return "until today";
  if (days === 1) return "until tomorrow";
  return `until ${d.toLocaleDateString(undefined, days > 6 ? { weekday: "short", day: "numeric", month: "short" } : { weekday: "short" })}`;
}
/** What the chats list shows under a title: "Today · until Sat". */
export function chatMeta(conv: { updated_at: string; expires_at: string }, now: number): string {
  return `${updatedLabel(conv.updated_at, now)} · ${expiryLabel(conv.expires_at, now)}`;
}
/** The one line next to the thumbs once feedback is given: "Thanks" for up, "Sent: Wrong amounts" / "Sent" after the box, else "". */
export function feedbackNote(fb: { value: number; reasons?: string[] } | null | undefined, sent: boolean): string {
  if (!fb) return "";
  if (fb.value === 1) return "Thanks";
  if (!sent) return "";
  return fb.reasons && fb.reasons.length ? `Sent: ${fb.reasons.join(", ")}` : "Sent";
}

/** Starter chips for an empty chat, by page (they are sent as the user's first message). */
export function startersFor(page: string | undefined, editor?: boolean): string[] {
  const byPage: Record<string, string[]> = {
    // "Add to next week" invites a write, which only a signed-in editor's chat can do.
    recipe: editor ? ["Swap an ingredient", "Scale it for 6", "Add to next week"] : ["Swap an ingredient", "Scale it for 6", "What goes with it?"],
    index: ["Something quick tonight", "Light and healthy"],
    "next-week": ["What's planned?"],
    shopping: ["What's left to buy?", "What can I make from what's at home?"],
  };
  return (page && Object.prototype.hasOwnProperty.call(byPage, page) && byPage[page]) || [];
}

/** The line under the conversation while photos are read: "Reading photos… 4 of 6", then "Adding them to the tray…". */
export function photoProgress(p: PhotoState | null): string {
  if (!p) return "";
  if (p.reading > 0) return `Reading photos… ${p.read} of ${p.read + p.reading}`;
  if (p.followUp || p.active) return "Adding them to the tray…";
  return "";
}

/** The page's name on the "On: …" chip above the input, from the page context. */
export function contextLabel(ctx: { page?: string; title?: string }): string {
  if (ctx.page === "recipe" && ctx.title) return ctx.title;
  return ({ index: "The recipe list", "next-week": "Next week", shopping: "Shopping list" } as Record<string, string>)[ctx.page ?? ""] || "";
}
