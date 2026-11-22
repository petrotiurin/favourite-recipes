// The tool registry's own types (lib/tools.ts): what a tool is, what it is handed, what it returns.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { ChatEvent } from "../../../shared/chat-events.ts";
import type { StageContext } from "../tray.ts";
import type { Caller } from "./common.ts";
import type { PhotoNumber } from "./rows.ts";

/** What a tool answers with: MCP's result (text and image content, `isError` for a refusal or a failure the model can read). */
export type ToolResult = CallToolResult;

/** "read" runs for anyone, "stage" fills the plan tray (chat editors), "write" commits (editors and the MCP agent). A tool without one counts as "write". */
export type ToolAccess = "read" | "stage" | "write";

/** What a chat turn hands its tools: the stream to tell the panel things on, the turn's trace and the conversation and photos it is about. */
export interface ChatContext {
  emit?: (event: ChatEvent) => void;
  trace?: StageContext["trace"];
  conversationTitle?: string | null;
  conversationId?: string;
  /** The photos on the user's latest message, in order. */
  attachments?: { path: string }[];
  /** Every photo of the conversation, numbered. */
  photos?: PhotoNumber[];
  /** The user's own words this turn. */
  userText?: string;
  /** The turn is one the server started (no words from the user). */
  followUp?: boolean;
}

/** What dispatch() is given besides the arguments: the transport's details. */
export interface DispatchContext {
  /** The server's own origin, for links in results. */
  origin?: string;
  /** Present only inside the chat. */
  chat?: ChatContext;
}

/** What a handler is given: the dispatch context and who is asking (set by dispatch(), never from request data). */
export interface ToolContext extends DispatchContext {
  caller: Caller;
}

/** A tool's context with the chat part there (needChat checks it). */
export type ChatToolContext = ToolContext & { chat: ChatContext };

/**
 * One entry of the registry. `handler` gets the arguments already parsed by `z.object(inputSchema)`; it is declared as a method so a handler
 * that takes its own parsed shape fits the registry's list of every shape.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: S;
  access?: ToolAccess;
  editorOnly?: boolean;
  chatOnly?: boolean;
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** An OpenAI-style function tool (what toolDefinitions hands the model). */
export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
