// The Supabase rows (supabase/migrations/*.sql) and what the jsonb columns hold. Written to be read from PostgREST with the service-role key:
// a `select` with a column list gives a `Pick` of these.
import type { ChatEventDataMap, RecipeCard, Suggestion } from "../../../shared/chat-events.ts";
import type { TrayRow } from "./tray.ts";

export type { TrayRow };

// --- conversations and messages (*_chat_conversations.sql, *_photo_reads.sql) ---------------------------------------------------

export interface ConversationRow {
  id: string;
  user_id: string;
  /** null for a chat made by a photo upload before its first message. */
  title: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  /** The turn lock: held until this time by the turn whose token is turn_lock_id. */
  turn_lock_until: string | null;
  turn_lock_id: string | null;
  /** The newest reply (the bubble's unread dot). */
  last_reply_at: string | null;
}

/** What getConversation selects. */
export type Conversation = Pick<ConversationRow, "id" | "user_id" | "title" | "created_at" | "updated_at" | "turn_lock_until" | "turn_lock_id" | "last_reply_at">;
/** What conversationById selects. */
export type ConversationLock = Pick<ConversationRow, "id" | "user_id" | "title" | "updated_at" | "turn_lock_until" | "turn_lock_id">;
/** What the chat list shows (listConversations): the row, and when it goes away. */
export interface ConversationListing {
  id: string;
  title: string;
  updated_at: string;
  expires_at: string;
}

/** What the panel shows again on reload, kept on the assistant message of a turn. */
export interface MessageUi {
  cards?: RecipeCard[];
  nav?: ChatEventDataMap["navigation"];
  replies?: Suggestion[];
  question?: ChatEventDataMap["question"];
  review?: ChatEventDataMap["review"];
  optional?: ChatEventDataMap["optional"];
  /** The turn ended in an error: the message the panel shows. */
  error?: string;
}

/** A model's tool call, OpenAI style. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A photo attached to a user message: its storage path (older rows hold the bare string). */
export type StoredImage = string | { path: string; width?: number; height?: number };

export interface StoredUserMessage {
  role: "user";
  content: string;
  images?: StoredImage[];
}
export interface StoredAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning?: string;
  ui?: MessageUi;
}
export interface StoredToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
/** A note from the site (a photo was read): `content` is what the model is handed, `summary` the panel's status line. */
export interface StoredEvent {
  role: "event";
  kind: string;
  content: string;
  summary?: string;
}
/** The `content` of a messages row, as the server stores it. */
export type StoredMessage = StoredUserMessage | StoredAssistantMessage | StoredToolMessage | StoredEvent;

/** A thumbs up / down on a turn: `value` 1 good, 0 bad (with reasons and a note). */
export type Feedback = { value: 1 } | { value: 0; reasons: string[]; note: string };

export type MessageRole = StoredMessage["role"];

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: MessageRole;
  content: StoredMessage;
  turn_id: string | null;
  trace_id: string | null;
  feedback: Feedback | null;
  created_at: string;
  handled_at: string | null;
}

/** What getMessages selects. */
export type StoredRow = Pick<MessageRow, "id" | "role" | "content" | "turn_id" | "trace_id" | "feedback" | "created_at" | "handled_at">;

/** A message as the model gets it (the stored one without `ui`, user photos as paths until withPhotoNotes turns them into a text line). */
export type ModelMessage =
  | { role: "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: "tool"; tool_call_id: string; content: string };

/** A message as the panel shows it (messagesForPanel). */
export type PanelMessage =
  | { role: "user"; content: string; images?: string[]; photo_numbers?: number[] }
  | { role: "event"; content: string }
  | {
      role: "assistant";
      content: string;
      turn_id: string | null;
      cards?: RecipeCard[];
      nav?: ChatEventDataMap["navigation"];
      replies?: Suggestion[];
      question?: ChatEventDataMap["question"];
      review?: ChatEventDataMap["review"];
      optional?: ChatEventDataMap["optional"];
      feedback?: Feedback;
    };

/** A photo attached in the conversation, numbered in order (photo-7). */
export interface PhotoNumber {
  n: number;
  path: string;
}

// --- photo_reads (*_photo_reads.sql) ---------------------------------------------------------------------------------------

export type PhotoReadStatus = "queued" | "reading" | "read" | "failed" | "skipped";

export interface PhotoReadRow {
  id: string;
  conversation_id: string;
  user_id: string;
  name: string | null;
  n: number;
  path: string;
  status: PhotoReadStatus;
  attempts: number;
  lease_until: string | null;
  /** What the photo reader made of it (lib/photo-reader.ts): `kind` says what is in the photo. */
  result: { kind?: string; recipe?: { title?: string; [key: string]: unknown }; [key: string]: unknown } | null;
  /** The photos read together as one recipe, e.g. "3+4". */
  group_id: string | null;
  recipe: Record<string, unknown> | null;
  joined_to: number | null;
  split_from_prev: boolean;
  /** The tray item it was staged as. */
  tray_item_id: string | null;
  error: string | null;
  created_at: string;
  read_at: string | null;
  report_lease_until: string | null;
  reported_at: string | null;
}
