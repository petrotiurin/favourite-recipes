// Every /chat event the tests read must match the wire shape described in shared/chat-events.ts (the browser's chat.cjs reads the same events).
import assert from "node:assert/strict";
import { chatEventData } from "../../shared/chat-events.ts";

export function checkEvent(event: any) {
  const schema = (chatEventData as Record<string, any>)[event.name];
  assert.ok(schema, `unknown /chat event "${event.name}"`);
  const parsed = schema.strict().safeParse(event.data);
  assert.ok(parsed.success, `/chat event "${event.name}" doesn't match shared/chat-events.ts: ${parsed.error?.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")} in ${JSON.stringify(event.data)}`);
  return event;
}
