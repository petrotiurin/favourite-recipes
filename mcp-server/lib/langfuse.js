// Optional Langfuse tracing for the chat (docs/chatbot-design.md 8.1), over Langfuse's public ingestion HTTP API:
// plain fetch, no SDK. Off unless LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are all set.
// One trace per /chat request, a generation per model call, a span per tool call (refused ones included).
// Sending never blocks the response and never throws: errors are swallowed and logged once. Callers must never put
// tokens, IPs or emails into what they record here.
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const MAX_TEXT = 4000;

export const langfuseEnabled = () => !!(config.langfusePublicKey && config.langfuseSecretKey && config.langfuseBaseUrl);

/** Long strings are cut so one tool result can't bloat a trace. */
export function clip(value, max = MAX_TEXT) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value;
  if (Array.isArray(value)) return value.map((v) => clip(v, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  return value;
}

let warned = false;
const pending = new Set(); // sends in flight, so tests (and shutdown) can wait for them

/** Resolves when every trace send started so far has finished. */
export const idle = () => Promise.allSettled([...pending]);

let waitUntilFn; // @vercel/functions' waitUntil, if it can be loaded
async function loadWaitUntil() {
  if (waitUntilFn !== undefined) return waitUntilFn;
  try {
    waitUntilFn = (await import("@vercel/functions")).waitUntil;
  } catch {
    waitUntilFn = null;
  }
  return waitUntilFn;
}

async function send(batch) {
  try {
    const res = await fetch(`${config.langfuseBaseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString("base64")}`,
      },
      body: JSON.stringify({ batch }),
    });
    if (!res.ok && res.status !== 207) throw new Error(`Langfuse answered ${res.status}`);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`Langfuse tracing failed (further failures are not logged): ${err.message}`);
    }
  }
}

const NOOP_SPAN = { end() {} };
const NOOP = {
  enabled: false,
  generation: () => NOOP_SPAN,
  span: () => NOOP_SPAN,
  event() {},
  finish() {},
};

/**
 * Starts a trace. Returns an object with generation(), span(), event() and finish(output); everything is a no-op when
 * tracing is off. finish() queues one batched send, hands it to waitUntil so the serverless function stays alive
 * for it, and returns immediately.
 * opts: { name, sessionId, userId, tags, metadata, input }
 */
export function startTrace(opts = {}) {
  if (!langfuseEnabled()) return NOOP;
  const traceId = randomUUID();
  const batch = [];
  const add = (type, body) => batch.push({ id: randomUUID(), type, timestamp: new Date().toISOString(), body });
  const started = new Date().toISOString();

  return {
    enabled: true,
    traceId,
    /** A model call. end({ output, usage: { prompt_tokens, completion_tokens, total_tokens, cost }, finishReason, error }). */
    generation({ name, model, input, metadata }) {
      const startTime = new Date().toISOString();
      return {
        end({ output, usage, finishReason, error } = {}) {
          add("generation-create", {
            id: randomUUID(),
            traceId,
            name,
            model,
            startTime,
            endTime: new Date().toISOString(),
            input: clip(input),
            output: clip(output),
            usageDetails: usage ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, total: usage.total_tokens ?? 0 } : undefined,
            costDetails: typeof usage?.cost === "number" ? { total: usage.cost } : undefined,
            level: error ? "ERROR" : "DEFAULT",
            statusMessage: error,
            metadata: { ...metadata, finishReason },
          });
        },
      };
    },
    /** A tool call. end({ output, error, refused }). */
    span({ name, input, metadata }) {
      const startTime = new Date().toISOString();
      return {
        end({ output, error, refused } = {}) {
          add("span-create", {
            id: randomUUID(),
            traceId,
            name,
            startTime,
            endTime: new Date().toISOString(),
            input: clip(input),
            output: clip(output),
            level: refused ? "WARNING" : error ? "ERROR" : "DEFAULT",
            statusMessage: refused ? "refused" : error ? "tool error" : undefined,
            metadata: { ...metadata, refused: !!refused },
          });
        },
      };
    },
    /** A point-in-time event: rate-limit hits, out-of-credit. */
    event({ name, metadata, level = "DEFAULT" }) {
      add("event-create", { id: randomUUID(), traceId, name, startTime: new Date().toISOString(), level, metadata });
    },
    finish(output) {
      add("trace-create", {
        id: traceId,
        name: opts.name || "chat",
        timestamp: started,
        sessionId: opts.sessionId,
        userId: opts.userId,
        tags: opts.tags,
        metadata: opts.metadata,
        input: clip(opts.input),
        output: clip(output),
      });
      const sending = send(batch.splice(0));
      pending.add(sending);
      sending.finally(() => pending.delete(sending));
      loadWaitUntil().then((waitUntil) => waitUntil?.(sending)).catch(() => {});
    },
  };
}

// --- scores (editors' thumbs up / down) ------------------------------------------------------------------------------

/**
 * Records (or overwrites) the score `user-feedback` on a trace: 1 = up, 0 = down. The id is fixed per turn, so sending it again
 * replaces the earlier score. Resolves true when it was sent; false when tracing is off or Langfuse failed (never throws).
 */
export async function setScore({ id, traceId, value, comment }) {
  if (!langfuseEnabled() || !traceId) return false;
  try {
    const res = await fetch(`${config.langfuseBaseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString("base64")}` },
      body: JSON.stringify({
        batch: [{ id: randomUUID(), type: "score-create", timestamp: new Date().toISOString(), body: { id, traceId, name: "user-feedback", value, dataType: "NUMERIC", comment: comment ? clip(comment, 500) : undefined } }],
      }),
    });
    return res.ok || res.status === 207;
  } catch (err) {
    console.warn(`Langfuse score failed: ${err.message}`);
    return false;
  }
}

/** Deletes a score set with setScore (the editor took their thumb back). Never throws. */
export async function deleteScore(id) {
  if (!langfuseEnabled()) return false;
  try {
    const res = await fetch(`${config.langfuseBaseUrl}/api/public/scores/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString("base64")}` },
    });
    return res.ok || res.status === 404;
  } catch (err) {
    console.warn(`Langfuse score delete failed: ${err.message}`);
    return false;
  }
}
