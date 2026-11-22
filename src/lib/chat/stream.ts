// The /chat answer stream: Server-Sent Events (`event: <name>` + `data: <json>`, a blank line between events), as mcp-server/api/chat.js
// writes them. The events and their data are typed by shared/chat-events.ts (types only: no zod in the browser); the data is still untrusted,
// and the panel cleans what it keeps (src/lib/chat/clean.ts).
import type { ChatEventDataMap, ChatEventName } from "../../../shared/chat-events.ts";

/** One event off the wire. The data of a known event is typed after the schema, but every field may be missing or of another type. */
export type StreamEvent = { [K in ChatEventName]: { name: K; data: Partial<ChatEventDataMap[K]> } }[ChatEventName] | { name: "message" | (string & {}); data: Record<string, unknown> };

/** One event block (the lines between two blank lines), or null when its data isn't JSON. */
export function parseEvent(block: string): StreamEvent | null {
  let name = "message";
  const data: string[] = [];
  block.split("\n").forEach((line) => {
    if (line.indexOf("event:") === 0) name = line.slice(6).trim();
    else if (line.indexOf("data:") === 0) data.push(line.slice(5).replace(/^ /, ""));
  });
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    // data that isn't an object (`null`, a number) is read as an empty one: every field is then missing
    return { name, data: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} } as StreamEvent;
  } catch {
    return null;
  }
}

/** The stream ended without the server's `done` (and without an error): the connection was cut, not finished. */
export class Dropped extends Error {
  constructor() {
    super("dropped");
    this.name = "Dropped";
  }
}

/**
 * Reads the answer to its end, calling `onEvent` for every event in order (chunks may split an event anywhere). Resolves once the stream has
 * ended after `done`; rejects with the server's `error` message (an Error) or with `Dropped` when it ended without either. A failed read (the
 * browser's "network error") rejects with the browser's own error.
 */
export async function readChatStream(body: ReadableStream<Uint8Array>, onEvent: (ev: StreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failed: string | null = null;
  let ended = false;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buffer += decoder.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const ev = parseEvent(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
      if (!ev) continue;
      if (ev.name === "error") failed = String((ev.data as { message?: unknown }).message || "Something went wrong with the chat.");
      else if (ev.name === "done") ended = true;
      onEvent(ev);
    }
  }
  if (failed) throw new Error(failed);
  if (!ended) throw new Dropped();
}
