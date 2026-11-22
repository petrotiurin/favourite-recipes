// The events of the /chat stream (Server-Sent Events: `event: <name>` + `data: <json>`), written by mcp-server/api/chat.js and
// mcp-server/lib/chat.js (`emit({ type, ...data })`) and read by templates/chat.cjs. This describes the wire as it is; the browser reads it
// defensively and re-checks every link and photo against the site's origin.
import { z } from "zod";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A chip under an answer: a reply the user sends, a link to a site page, or a button that presses one of the tray's own buttons. */
export const suggestionSchema = z.union([
  z.string(),
  z.object({ label: z.string(), url: z.string() }),
  z.object({ label: z.string(), action: z.enum(["apply_plan", "finalise_plan"]) }),
]);
export type Suggestion = z.infer<typeof suggestionSchema>;

/** A recipe card built from our own data (`cardFor` in lib/chat-ui.js); `publishing` while a just-saved recipe's page isn't live yet. */
export const recipeCardSchema = z.object({
  slug: z.string().regex(SLUG),
  title: z.string(),
  image: z.string(),
  kicker: z.object({ kind: z.enum(["this", "next", "draft", ""]), label: z.string() }),
  meta: z.string(),
  url: z.string(),
  publishing: z.boolean().optional(),
});
export type RecipeCard = z.infer<typeof recipeCardSchema>;

/** One of this week's drafts on the review card; `answer` when the tray already holds a thumb for it. */
export const draftRowSchema = z.object({
  slug: z.string(),
  title: z.string(),
  image: z.string(),
  url: z.string(),
  meta: z.string(),
  also_next: z.boolean(),
  answer: z.enum(["liked", "remove"]).optional(),
});

/** One optional ingredient on the optional-items card; `answer: "drop"` when an earlier answer already left it off. */
export const optionalItemSchema = z.object({
  item: z.string(),
  name: z.string(),
  quantity: z.string(),
  recipes: z.array(z.object({ slug: z.string(), title: z.string(), image: z.string() })),
  answer: z.literal("drop").optional(),
});

/** The data of each event, by the name that comes after `event:`. */
export const chatEventData = {
  /** Editors only, first: the ids the client needs. */
  meta: z.object({ conversation_id: z.string(), turn_id: z.string() }),
  text: z.object({ delta: z.string() }),
  /** What the bot is doing, in plain words. */
  status: z.object({ text: z.string() }),
  suggestions: z.object({ replies: z.array(suggestionSchema) }),
  /** ask_user: solid answer chips; the tapped answer is the next message. */
  question: z.object({ question: z.string(), options: z.array(z.string()), multi: z.boolean() }),
  /** The drafts review card: one answer per draft of this week, then Done. */
  review: z.object({ drafts: z.array(draftRowSchema) }),
  /** The optional items card. */
  optional: z.object({ items: z.array(optionalItemSchema) }),
  /** The plan tray changed: the panel reloads it. */
  tray: z.object({ added: z.array(z.string()).optional(), /** What was staged, in a few words, for the status line. */ label: z.string().optional() }),
  cards: z.object({ cards: z.array(recipeCardSchema) }),
  /** A button that opens one site page; never navigates by itself. */
  navigation: z.object({ label: z.string(), url: z.string() }),
  /** Editors only, when a new chat got its title. */
  title: z.object({ conversation_id: z.string(), title: z.string() }),
  /** Editors only: the numbers of the photos on this message (photo-7…), for the badges. */
  photos: z.object({ numbers: z.array(z.number().int()) }),
  /** The turn finished; `suggestions` says whether chips came with it. */
  done: z.object({ suggestions: z.boolean() }),
  /** Safe to show the visitor. */
  error: z.object({ message: z.string() }),
};
export type ChatEventName = keyof typeof chatEventData;
export type ChatEventDataMap = { [K in ChatEventName]: z.infer<(typeof chatEventData)[K]> };

/** An event as the server's `emit` takes it: `{ type: <name>, ...data }`. */
const d = chatEventData;
export const chatEventSchema = z.discriminatedUnion("type", [
  d.meta.extend({ type: z.literal("meta") }),
  d.text.extend({ type: z.literal("text") }),
  d.status.extend({ type: z.literal("status") }),
  d.suggestions.extend({ type: z.literal("suggestions") }),
  d.question.extend({ type: z.literal("question") }),
  d.review.extend({ type: z.literal("review") }),
  d.optional.extend({ type: z.literal("optional") }),
  d.tray.extend({ type: z.literal("tray") }),
  d.cards.extend({ type: z.literal("cards") }),
  d.navigation.extend({ type: z.literal("navigation") }),
  d.title.extend({ type: z.literal("title") }),
  d.photos.extend({ type: z.literal("photos") }),
  d.done.extend({ type: z.literal("done") }),
  d.error.extend({ type: z.literal("error") }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
