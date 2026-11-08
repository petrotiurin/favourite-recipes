// Optional Langfuse tracing for the chat (docs/chatbot-design.md 8.1), on the official Langfuse JS/TS SDK v6 (OpenTelemetry:
// @langfuse/tracing + @langfuse/otel; scores through @langfuse/client). Off unless LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL are all set.
//
// Shape of a trace (one per /chat request, i.e. one chat turn; the conversation id is the session):
//   chat (agent)                       the user's message in, the assistant's answer out
//   ├─ generate-response (generation)  one per model call: the messages it saw, its answer + tool calls, thinking, tokens, cost
//   ├─ search_recipes (retriever)      one per tool call, named after the tool: lookups are retrievers, everything else a tool
//   ├─ stage_create_recipe (tool)      (refused calls included, as WARNING)
//   ├─ tray-staged (event)             point-in-time events: tray changes, rate limits, out-of-credit
//   └─ suggest-replies (generation)    the cheap follow-up that asks only for reply chips
// Every observation carries the trace attributes (userId, sessionId, tags, trace name, version) through propagateAttributes.
//
// Langfuse gets its own TracerProvider (never registered globally), so it never mixes with other OpenTelemetry setups. Spans are
// batched and flushed when a trace finishes, through waitUntil, so the serverless function stays alive for the export without the
// response waiting on it. Tracing never throws into the chat: failures are logged once. Callers must never put tokens, IPs or emails
// into what they record here; the mask below is only the second line of defence.
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";
import { config } from "./config.js";

const MAX_TEXT = 40_000; // per string: as much as the model itself is given (the system prompt, the largest tool result), no more

export const langfuseEnabled = () => !!(config.langfusePublicKey && config.langfuseSecretKey && config.langfuseBaseUrl);

const DATA_URI = /^data:[\w/+.-]+;base64,/;

/** Long strings are cut so one tool result can't bloat a trace. Photos (base64 data URIs) are kept whole: the SDK uploads them as media. */
export function clip(value, max = MAX_TEXT) {
  if (typeof value === "string" && DATA_URI.test(value)) return value;
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value;
  if (Array.isArray(value)) return value.map((v) => clip(v, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  return value;
}

// --- masking (defence in depth) ----------------------------------------------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g; // Supabase access tokens
const BEARER = /\bBearer\s+[\w.~+/-]{12,}=*/gi;
const KEYS = /\b(?:sk-or-v1-[0-9a-f]{16,}|sk-lf-[\w-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g;

/** Redacts emails, bearer tokens, JWTs and API keys in a string. */
export function maskText(text) {
  return text.replace(JWT, "[token]").replace(BEARER, "Bearer [token]").replace(KEYS, "[key]").replace(EMAIL, "[email]");
}

/** The span processor's mask: runs on every observation's input, output and metadata before export (data may be any JSON value). */
export function mask({ data }) {
  if (typeof data === "string") return maskText(data);
  if (data && typeof data === "object") {
    const json = JSON.stringify(data);
    const masked = maskText(json);
    return masked === json ? data : JSON.parse(masked);
  }
  return data;
}

// --- SDK setup (lazy: config is read when tracing is first used, and again if the keys change) ----------------------------------

let state = null; // { key, processor, client }
let testExporter = null;
let contextReady = false;
let warned = false;
const pending = new Set(); // flushes in flight, so tests (and shutdown) can wait for them

const warnOnce = (what, err) => {
  if (warned) return;
  warned = true;
  console.warn(`Langfuse ${what} failed (further failures are not logged): ${err?.message || err}`);
};

/** The deployment's environment and release, so preview and local traces stay out of production dashboards. */
function environment() {
  const env = (process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.VERCEL_ENV || "development").toLowerCase();
  return /^[a-z0-9-_]{1,40}$/.test(env) && !env.startsWith("langfuse") ? env : "development";
}
const release = () => process.env.LANGFUSE_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || undefined;

function sdk() {
  const key = `${config.langfuseBaseUrl}|${config.langfusePublicKey}|${config.langfuseSecretKey}|${testExporter ? "test" : ""}`;
  if (state?.key === key) return state;
  // Child observations are created inside context.with(...) so they pick up the propagated trace attributes: that needs a real
  // context manager. Registering one is a no-op when the runtime already has one.
  if (!contextReady) contextReady = context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()) || true;
  const credentials = { publicKey: config.langfusePublicKey, secretKey: config.langfuseSecretKey, baseUrl: config.langfuseBaseUrl };
  const processor = new LangfuseSpanProcessor({
    ...credentials,
    ...(testExporter ? { exporter: testExporter } : {}),
    exportMode: "batched", // one export per finished trace (forceFlush below), not one request per observation
    environment: environment(),
    release: release(),
    mask,
    // Photos in a generation's input (editors' attachments, as data URIs) are uploaded as Langfuse media and shown in the trace,
    // so a bad recipe import can be checked against what the model saw (design 8.1). The default, spelled out.
    mediaUploadEnabled: true,
  });
  const provider = new BasicTracerProvider({ resource: resourceFromAttributes({ "service.name": "favourite-recipes-mcp" }), spanProcessors: [processor] });
  setLangfuseTracerProvider(provider); // isolated: never the global provider
  const old = state;
  state = { key, processor, client: new LangfuseClient(credentials) };
  old?.processor.shutdown().catch(() => {});
  return state;
}

/** Test hook: export spans to this exporter (e.g. an InMemorySpanExporter) instead of Langfuse. null goes back to the real one. */
export function useTestExporter(exporter) {
  testExporter = exporter;
  state = null;
}

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

/** Exports everything finished so far; never throws. Kept alive with waitUntil on Vercel. */
function flushSoon() {
  if (!state) return;
  const flushing = state.processor.forceFlush().catch((err) => warnOnce("export", err));
  pending.add(flushing);
  flushing.finally(() => pending.delete(flushing));
  loadWaitUntil().then((waitUntil) => waitUntil?.(flushing)).catch(() => {});
}

/** Resolves when every flush started so far has finished. */
export const idle = () => Promise.allSettled([...pending]);

// --- traces ------------------------------------------------------------------------------------------------------------------------

const NOOP_OBS = { end() {} };
const NOOP = {
  enabled: false,
  traceId: undefined,
  generation: () => NOOP_OBS,
  span: () => NOOP_OBS,
  event() {},
  finish() {},
};

const OPENAI_USAGE_DETAILS = { prompt_tokens_details: ["cached_tokens", "audio_tokens"], completion_tokens_details: ["reasoning_tokens", "audio_tokens"] };

/**
 * OpenRouter's usage in Langfuse's OpenAI usage schema (only the OpenAI keys: an extra key such as `cost` would turn off the mapping
 * and the cached / reasoning subtraction), plus the real charged cost as costDetails.
 */
export function usageFor(usage) {
  if (!usage || typeof usage !== "object") return {};
  const usageDetails = {};
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) if (Number.isFinite(usage[k])) usageDetails[k] = usage[k];
  for (const [group, keys] of Object.entries(OPENAI_USAGE_DETAILS)) {
    const picked = Object.fromEntries(keys.filter((k) => Number.isFinite(usage[group]?.[k]) && usage[group][k] > 0).map((k) => [k, usage[group][k]]));
    if (Object.keys(picked).length) usageDetails[group] = picked;
  }
  return {
    usageDetails: Object.keys(usageDetails).length ? usageDetails : undefined,
    costDetails: Number.isFinite(usage.cost) ? { total: usage.cost } : undefined,
  };
}

/**
 * Starts a trace. Returns an object with generation(), span(), event() and finish(output); everything is a no-op when tracing is
 * off, and nothing here ever throws. finish() ends the root observation and flushes in the background.
 * opts: { name, sessionId, userId, tags, version, metadata, input }
 */
export function startTrace(opts = {}) {
  if (!langfuseEnabled()) return NOOP;
  try {
    sdk();
    const name = opts.name || "chat";
    // The trace attributes go on every observation (Langfuse filters observations by user, session and tags).
    const ctx = propagateAttributes(
      { traceName: name, userId: opts.userId, sessionId: opts.sessionId, tags: opts.tags, version: opts.version },
      () => context.active()
    );
    const inTrace = (fn) => context.with(ctx, fn);
    const root = inTrace(() => startObservation(name, { input: clip(opts.input), metadata: clip(opts.metadata) }, { asType: "agent" }));
    const child = (childName, attributes, asType) => inTrace(() => root.startObservation(childName, attributes, { asType }));
    const safe = (fn) => {
      try {
        return fn();
      } catch (err) {
        warnOnce("tracing", err);
        return NOOP_OBS;
      }
    };
    let finished = false;

    return {
      enabled: true,
      traceId: root.traceId,
      /**
       * A model call. input: the messages it was sent. end({ output, usage (OpenRouter's), finishReason, error, completionStartTime }).
       * output: an OpenAI-style assistant message ({ role, content, tool_calls, reasoning }) or plain text.
       */
      generation({ name: genName, model, input, modelParameters, metadata }) {
        return safe(() => {
          const gen = child(genName, { model, input: clip(input), modelParameters, metadata: clip(metadata) }, "generation");
          return {
            end({ output, usage, finishReason, error, completionStartTime, metadata: extra } = {}) {
              safe(() =>
                gen
                  .update({
                    output: clip(output),
                    ...usageFor(usage),
                    ...(completionStartTime ? { completionStartTime } : {}),
                    level: error ? "ERROR" : finishReason === "length" ? "WARNING" : "DEFAULT",
                    statusMessage: error || (finishReason === "length" ? "cut off at max_tokens" : undefined),
                    metadata: { ...extra, finishReason: finishReason ?? null },
                  })
                  .end()
              );
            },
          };
        });
      },
      /** A tool call. type: "tool" (default) or "retriever" (a lookup). end({ output, error, refused }). */
      span({ name: spanName, input, metadata, type = "tool" }) {
        return safe(() => {
          const obs = child(spanName, { input: clip(input), metadata: clip(metadata) }, type);
          return {
            end({ output, error, refused } = {}) {
              safe(() =>
                obs
                  .update({
                    output: clip(output),
                    level: refused ? "WARNING" : error ? "ERROR" : "DEFAULT",
                    statusMessage: refused ? "refused" : error ? "tool error" : undefined,
                    metadata: { refused: !!refused },
                  })
                  .end()
              );
            },
          };
        });
      },
      /** A point-in-time event: rate-limit hits, out-of-credit, tray changes. */
      event({ name: eventName, metadata, level = "DEFAULT" }) {
        safe(() => child(eventName, { metadata: clip(metadata), level }, "event"));
      },
      /** Ends the trace. metadata: what else the user was shown (cards, chips, a question), next to the text output. */
      finish(output, metadata) {
        if (finished) return;
        finished = true;
        safe(() => root.update({ output: clip(output), ...(metadata ? { metadata: clip(metadata) } : {}) }).end());
        flushSoon();
      },
    };
  } catch (err) {
    warnOnce("tracing", err);
    return NOOP;
  }
}

// --- scores (editors' thumbs up / down) ------------------------------------------------------------------------------

function client() {
  return langfuseEnabled() ? sdk().client : null;
}

/**
 * Records (or overwrites) the score `user-feedback` on a trace: 1 = up, 0 = down. The id is fixed per turn, so sending it again
 * replaces the earlier score. Resolves true when Langfuse accepted it; false when tracing is off or Langfuse failed (never throws).
 */
export async function setScore({ id, traceId, value, comment }) {
  const lf = client();
  if (!lf || !traceId) return false;
  try {
    const res = await lf.api.scores.create([
      { id, traceId, name: "user-feedback", value, dataType: "NUMERIC", comment: comment ? maskText(clip(comment, 500)) : undefined, environment: environment() },
    ]);
    if (res && "rejected" in res && res.rejected > 0) throw new Error(JSON.stringify(res.errors).slice(0, 300));
    return true;
  } catch (err) {
    console.warn(`Langfuse score failed: ${err.message}`);
    return false;
  }
}

/** Deletes a score set with setScore (the editor took their thumb back). Never throws. */
export async function deleteScore(id) {
  const lf = client();
  if (!lf) return false;
  try {
    await lf.api.scores.delete(id);
    return true;
  } catch (err) {
    if (err?.statusCode === 404) return true;
    console.warn(`Langfuse score delete failed: ${err.message}`);
    return false;
  }
}
