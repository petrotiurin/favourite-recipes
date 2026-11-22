// The chat agent's own shapes (lib/chat.ts, api/chat.ts, lib/langfuse.ts): the OpenRouter chat-completions request and stream pieces, the
// messages of a turn's thread, what the tools get as `ctx.chat`, the Langfuse trace, and the request bodies the /chat handler reads.
// The events the stream carries are NOT redefined here: they are `ChatEvent` of shared/chat-events.ts, which the browser reads too.
import type { ChatEvent, ChatEventDataMap, ChatEventName, RecipeCard, Suggestion } from "../../../shared/chat-events.ts";
import type { Caller } from "./common.ts";
import type { MessageUi, PhotoNumber, StoredAssistantMessage, StoredToolMessage, ToolCall } from "./rows.ts";

export type { ChatEvent, ChatEventDataMap, ChatEventName, RecipeCard, Suggestion };

/** What writes an event onto the stream (or, in a follow-up turn, nowhere). */
export type EmitEvent = (event: ChatEvent) => void;

// --- OpenRouter: the request ---------------------------------------------------------------------------------------------

/** A tool as the model is offered it (OpenAI function-calling style, plain JSON Schema). */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** One message of the thread the model is sent. */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: "tool"; tool_call_id: string; content: string };

/** What a turn starts from: the conversation so far (no system message: the loop adds its own). */
export type HistoryMessage = Exclude<ChatMessage, { role: "system" }>;

/** What a turn adds to the thread, and what is stored for an editor: the assistant's messages and the tool results. */
export type TurnMessage = StoredAssistantMessage | StoredToolMessage;

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  stream: true;
  stream_options: { include_usage: true };
  usage: { include: true };
  temperature: number;
  max_tokens: number;
}

// --- OpenRouter: the stream ------------------------------------------------------------------------------------------------

/** OpenRouter's usage block (only what is read here). */
export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** What was really charged. */
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

export interface StreamToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: StreamToolCallDelta[];
}

/** One `data:` event of the streamed answer. */
export interface StreamChunk {
  /** Present when the provider failed mid-stream. */
  error?: unknown;
  usage?: OpenRouterUsage;
  choices?: { finish_reason?: string | null; delta?: StreamDelta }[];
}

/** A tool call the model made, its arguments still the model's own JSON text. */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** `length`: stopped at max_tokens; `dropped`: the stream ended with no finish reason; null: a normal end. */
export type CutReason = "length" | "dropped";

export interface CompletionResult {
  text: string;
  toolCalls: ModelToolCall[];
  usage: OpenRouterUsage | undefined;
  finishReason: string | undefined;
  cut: CutReason | null;
  ms: number;
  reasoning: string;
  firstTokenAt: Date | undefined;
}

// --- the turn --------------------------------------------------------------------------------------------------------------

/** The page the client reports, reduced to plain values by the handler (api/chat.ts pageFrom). */
export interface PageState {
  page?: string;
  slug?: string;
  servings?: number;
  filter?: string;
  search?: string;
  dismissed?: boolean;
}

/** A photo attached to this message: where it is stored and its number in the conversation. */
export interface Attachment {
  path: string;
  n: number;
  width?: number;
  height?: number;
}

/** The conversation an editor's turn belongs to. */
export interface ConversationRef {
  id: string;
  title: string | null | undefined;
}

/** What the stage tools get as `ctx.chat` (lib/tools.ts) when the model calls one. */
export interface ChatToolContext {
  emit: EmitEvent;
  trace: Trace;
  conversationTitle: string | null | undefined;
  conversationId: string | undefined;
  attachments: Attachment[];
  photos: PhotoNumber[];
  userText: string;
  followUp: boolean;
}

export interface RunChatOptions {
  caller: Caller;
  /** Already reduced to plain text for a visitor; an editor's own stored history plus the new message. */
  messages: HistoryMessage[];
  /** The client's page context (untrusted; see pageNote). */
  page: PageState;
  emit: EmitEvent;
  trace: Trace;
  signal?: AbortSignal;
  attachments?: Attachment[];
  photos?: PhotoNumber[];
  userText?: string;
  followUp?: boolean;
  model?: string;
  apiKey?: string;
  origin?: string;
  extraNote?: string;
  conversation?: ConversationRef;
  maxTokens?: number;
}

export interface RunChatResult {
  reply: string;
  suggestions: boolean;
  /** This turn's new model messages, the panel extras on the last assistant one: ready to be stored for an editor. */
  produced: TurnMessage[];
  shown: Record<string, unknown> | undefined;
}

export type { MessageUi };

// --- Langfuse (lib/langfuse.ts) ------------------------------------------------------------------------------------------

export interface TraceOptions {
  name?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  version?: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
}

export interface GenerationStart {
  name: string;
  model: string;
  /** The messages the model was sent. */
  input: unknown;
  modelParameters?: Record<string, string | number>;
  metadata?: Record<string, unknown>;
}

export interface GenerationEnd {
  /** An OpenAI-style assistant message, or plain text. */
  output?: unknown;
  usage?: OpenRouterUsage;
  finishReason?: string;
  error?: string;
  completionStartTime?: Date;
  metadata?: Record<string, unknown>;
}

export interface SpanStart {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  /** "tool" (default) or "retriever" (a lookup). */
  type?: "tool" | "retriever";
}

export interface SpanEnd {
  output?: unknown;
  error?: boolean;
  refused?: boolean;
}

export interface TraceEvent {
  name: string;
  metadata?: Record<string, unknown>;
  /** DEFAULT, WARNING or ERROR (anything else is recorded as DEFAULT). */
  level?: string;
}

/** Something that can be ended: a generation or a tool call of a trace. */
export interface Observation<E> {
  end(args?: E): void;
}

/** A trace as lib/langfuse.ts hands it out (a no-op when tracing is off). */
export interface Trace {
  enabled: boolean;
  traceId: string | undefined;
  generation(args: GenerationStart): Observation<GenerationEnd>;
  span(args: SpanStart): Observation<SpanEnd>;
  event(args: TraceEvent): void;
  finish(output?: unknown, metadata?: Record<string, unknown>): void;
}

// --- the request bodies the handler reads (api/chat.ts) ----------------------------------------------------------------------

/** Every body is parsed as JSON and then treated as a bag of unknowns: nothing in it is trusted until it is checked. */
export type RequestBody = Record<string, unknown>;

/** The reply helper of a request: JSON with the CORS and no-store headers. */
export type Reply = (body: unknown, status?: number, extra?: Record<string, string>) => Response;

/** A refused token or a refused request: the status to answer with and the line to show. */
export interface Refusal {
  status: number;
  error: string;
}

/** What a tool call answers with (MCP's shape): text blocks, `isError` when it failed. */
export interface ToolOutput {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}
