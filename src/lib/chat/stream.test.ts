// The /chat stream (Server-Sent Events): every event of shared/chat-events.ts, events split across chunks anywhere, \r\n line ends, bad data,
// the server's error, and a stream cut before `done`.
import { describe, expect, it } from "vitest";
import { chatEventSchema, type ChatEventName } from "../../../shared/chat-events.ts";
import { Dropped, parseEvent, readChatStream, type StreamEvent } from "./stream.ts";

const enc = new TextEncoder();
const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
/** A body that hands out the text in the given pieces (bytes, so a piece may end inside a multi-byte character). */
function body(pieces: (string | Uint8Array)[], fail?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < pieces.length) {
        const p = pieces[i++];
        c.enqueue(typeof p === "string" ? enc.encode(p) : p);
      } else if (fail) c.error(fail);
      else c.close();
    },
  });
}
async function read(pieces: (string | Uint8Array)[], fail?: Error) {
  const events: StreamEvent[] = [];
  let error: unknown = null;
  await readChatStream(body(pieces, fail), (e) => events.push(e)).catch((e) => (error = e));
  return { events, error };
}

/** One sample of every event the server sends (each valid against the shared schema). */
const SAMPLES: Record<ChatEventName, Record<string, unknown>> = {
  meta: { conversation_id: "11111111-2222-4333-8444-555555555555", turn_id: "t1" },
  text: { delta: "Hello **there**" },
  status: { text: "Looking through the recipes…" },
  suggestions: { replies: ["More like this", { label: "Open next week", url: "https://site.test/favourite-recipes/next-week.html" }, { label: "Save", action: "apply_plan" }] },
  question: { question: "Ready?", options: ["Promote it", "Not yet"], multi: false },
  review: { drafts: [{ slug: "pea-soup", title: "Pea Soup", image: "", url: "https://site.test/favourite-recipes/recipes/pea-soup.html", meta: "20 min", also_next: false }] },
  optional: { items: [{ item: "sesame-seeds", name: "Sesame seeds", quantity: "", recipes: [{ slug: "satay-salmon", title: "Satay Salmon", image: "" }] }] },
  tray: { added: ["abcdef12"], label: "Test Pasta" },
  cards: { cards: [{ slug: "soup", title: "Soup", image: "", kicker: { kind: "this", label: "This week" }, meta: "10 min", url: "https://site.test/favourite-recipes/recipes/soup.html" }] },
  navigation: { label: "Open Soup", url: "https://site.test/favourite-recipes/recipes/soup.html" },
  title: { conversation_id: "11111111-2222-4333-8444-555555555555", title: "Quick dinners" },
  photos: { numbers: [1, 2] },
  done: { suggestions: true },
  error: { message: "The chat is resting. Try again later." },
};

describe("parseEvent", () => {
  it("reads the name and the JSON data; data on several lines is joined; a block without event: is a message", () => {
    expect(parseEvent('event: text\ndata: {"delta":"hi"}')).toEqual({ name: "text", data: { delta: "hi" } });
    expect(parseEvent('event: text\ndata: {"delta":\ndata: "hi"}')).toEqual({ name: "text", data: { delta: "hi" } });
    expect(parseEvent('data: {"a":1}')).toEqual({ name: "message", data: { a: 1 } });
    expect(parseEvent("event:status\ndata:{\"text\":\"x\"}")).toEqual({ name: "status", data: { text: "x" } });
    expect(parseEvent(": a comment\nevent: done\ndata: {}")).toEqual({ name: "done", data: {} });
  });
  it("is null when the data isn't JSON, and reads data that isn't an object as an empty one", () => {
    expect(parseEvent("event: text\ndata: {nope")).toBeNull();
    expect(parseEvent("event: text")).toBeNull();
    expect(parseEvent("event: text\ndata: null")).toEqual({ name: "text", data: {} });
    expect(parseEvent("event: text\ndata: 5")).toEqual({ name: "text", data: {} });
  });
});

describe("readChatStream", () => {
  it("hands every event of the shared schema over in order, typed by name", async () => {
    const names = Object.keys(SAMPLES) as ChatEventName[];
    for (const n of names) expect(chatEventSchema.safeParse({ type: n, ...SAMPLES[n] }).success, n).toBe(true);
    const order: ChatEventName[] = [...names.filter((n) => n !== "error" && n !== "done"), "done"];
    const { events, error } = await read(order.map((n) => sse(n, SAMPLES[n])));
    expect(error).toBeNull();
    expect(events.map((e) => e.name)).toEqual(order);
    for (const e of events) expect(e.data).toEqual(SAMPLES[e.name as ChatEventName]);
  });

  it("puts events back together however the chunks split them, multi-byte characters included", async () => {
    const text = sse("meta", SAMPLES.meta) + sse("text", { delta: "Crème fraîche · 20 min" }) + sse("status", SAMPLES.status) + sse("done", SAMPLES.done);
    const bytes = enc.encode(text);
    const whole = await read([text]);
    for (const size of [1, 2, 3, 7, 50]) {
      const pieces: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.slice(i, i + size));
      const { events, error } = await read(pieces);
      expect(error, `chunks of ${size}`).toBeNull();
      expect(events, `chunks of ${size}`).toEqual(whole.events);
    }
    expect((whole.events[1].data as { delta: string }).delta).toBe("Crème fraîche · 20 min");
  });

  it("reads \\r\\n line ends", async () => {
    const { events, error } = await read([sse("text", { delta: "a" }).replace(/\n/g, "\r\n") + sse("done", {}).replace(/\n/g, "\r\n")]);
    expect(error).toBeNull();
    expect(events.map((e) => e.name)).toEqual(["text", "done"]);
  });

  it("skips a block whose data isn't JSON and carries on", async () => {
    const { events, error } = await read(["event: text\ndata: {broken\n\n", sse("text", { delta: "ok" }), sse("done", {})]);
    expect(error).toBeNull();
    expect(events.map((e) => [e.name, e.data])).toEqual([["text", { delta: "ok" }], ["done", {}]]);
  });

  it("rejects with the server's error message (after handing over what came before it, and after it)", async () => {
    const { events, error } = await read([sse("text", { delta: "half" }), sse("error", SAMPLES.error), sse("done", {})]);
    expect(events.map((e) => e.name)).toEqual(["text", "error", "done"]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The chat is resting. Try again later.");
    const blank = await read([sse("error", {})]);
    expect((blank.error as Error).message).toBe("Something went wrong with the chat.");
  });

  it("rejects with Dropped when the stream ends without done (a provider timeout, a cut connection), even with a half event left", async () => {
    const { events, error } = await read([sse("text", { delta: "hal" }), "event: text\ndata: {\"del"]);
    expect(events.length).toBe(1);
    expect(error).toBeInstanceOf(Dropped);
    expect((error as Error).name).toBe("Dropped");
    expect((await read([])).error).toBeInstanceOf(Dropped);
  });

  it("rejects with the browser's own error when the read fails (the phone switched apps: a TypeError)", async () => {
    const { events, error } = await read([sse("text", { delta: "a" })], new TypeError("network error"));
    expect(events.length).toBe(1);
    expect((error as Error).name).toBe("TypeError");
  });

  it("a handler that throws stops the read with its error", async () => {
    let error: unknown = null;
    await readChatStream(body([sse("text", {}), sse("done", {})]), () => {
      throw new Error("boom");
    }).catch((e) => (error = e));
    expect((error as Error).message).toBe("boom");
  });
});
