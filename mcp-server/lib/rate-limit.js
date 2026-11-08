// Per-visitor rate limits for /chat (docs/chatbot-design.md section 8): counters live in Supabase
// (supabase/migrations/*_rate_limits.sql), reached with the service-role key through PostgREST. The visitor is identified
// by a salted hash of their IP: the raw IP is never stored, logged or traced.
import { createHmac } from "node:crypto";
import net from "node:net";
import { config } from "./config.js";

/**
 * What a visitor is counted as: an IPv4 address as is, an IPv6 address by its /64 (one household or one rented block, so rotating
 * the low 64 bits buys nothing).
 */
export function visitorKey(ip) {
  const s = String(ip || "unknown").trim().toLowerCase();
  if (net.isIPv6(s)) {
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return mapped[1];
    const [head, tail = ""] = s.replace(/%.*$/, "").split("::");
    const first = head ? head.split(":") : [];
    const last = tail ? tail.split(":") : [];
    const groups = s.includes("::") ? [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill("0"), ...last] : first;
    return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
  }
  return s;
}

/** A stable, non-reversible id for a visitor's address (IPv6 by /64). */
export function hashIp(ip) {
  const salt = config.ipHashSalt || config.supabaseServiceKey || "favourite-recipes-chat";
  return createHmac("sha256", salt).update(visitorKey(ip)).digest("hex").slice(0, 24);
}

/** The caller's IP as Vercel (or the dev harness) reports it. */
export function clientIp(request) {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

let warned = false;
let warnedFallback = false;
// Visitors are limited per hashed IP (and all together), signed-in editors (generous) per Supabase user id.
// `fallback` is the (small) limit used by the in-memory limiter when Supabase isn't there.
const WINDOWS = {
  public: [
    { name: "hour", seconds: 3600, limit: () => config.chatPublicHourlyLimit, fallback: 10, say: "You've sent a lot of messages in the last hour. Give it a little while and try again." },
    { name: "day", seconds: 86400, limit: () => config.chatPublicDailyLimit, fallback: 30, say: "That's all the chat messages for today. Try again tomorrow." },
    { name: "hour", seconds: 3600, shared: "public:all", limit: () => config.chatPublicTotalHourlyLimit, fallback: 100, say: "The chat is very busy right now. Try again a bit later." },
  ],
  editor: [
    { name: "hour", seconds: 3600, limit: () => config.chatEditorHourlyLimit, fallback: 100, say: "You've sent a lot of messages in the last hour. Give it a little while and try again." },
    { name: "day", seconds: 86400, limit: () => config.chatEditorDailyLimit, fallback: 500, say: "That's all the chat messages for today. Try again tomorrow." },
  ],
};

async function hit(key, seconds) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/rate_limit_hit`, {
    method: "POST",
    headers: {
      apikey: config.supabaseServiceKey,
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_key: key, p_window_seconds: seconds }),
  });
  if (!res.ok) throw new Error(`rate_limit_hit failed: ${res.status}`);
  return Number(await res.json());
}

// The fallback when Supabase is missing or failing: fixed windows kept in this instance's memory. Not shared between instances, but a
// failing database no longer means "no limits".
const memory = new Map(); // "key|window" -> count
function memoryHit(key, seconds, now) {
  const window = Math.floor(now() / 1000 / seconds);
  const k = `${key}|${window}`;
  if (memory.size > 5000) for (const old of [...memory.keys()].slice(0, 2500)) memory.delete(old);
  memory.set(k, (memory.get(k) || 0) + 1);
  return memory.get(k);
}
const supabaseUp = () => !!(config.supabaseUrl && config.supabaseServiceKey);

/** Counts hits for [{ key, seconds, fallback }], in Supabase when it works, else in memory (with the small fallback limits). */
async function count(entries, now) {
  if (supabaseUp()) {
    try {
      return { counts: await Promise.all(entries.map((e) => hit(e.key, e.seconds))), limits: null };
    } catch (err) {
      console.error("Rate limit check failed, using the in-memory limiter:", err.message);
    }
  } else if (!warned) {
    warned = true;
    console.warn("Chat rate limiting uses the in-memory fallback: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  }
  if (!warnedFallback && supabaseUp()) {
    warnedFallback = true;
    console.warn("Chat rate limiting is on its in-memory fallback because Supabase failed.");
  }
  return { counts: entries.map((e) => memoryHit(e.key, e.seconds, now)), limits: entries.map((e) => e.fallback) };
}

/**
 * Counts one message from this caller and says whether it may go ahead:
 * { ok: true } or { ok: false, retryAfter (seconds), message }.
 * Visitors count per address (IPv6 per /64) and against one cap shared by every visitor. If Supabase isn't configured or fails, a small
 * per-instance in-memory limiter applies instead (never "everything goes through"); OpenRouter's credit limit is the last stop (D3).
 */
export async function checkRateLimit(caller, { now = Date.now } = {}) {
  const windows = WINDOWS[caller.role] || WINDOWS.public;
  const who = caller.role === "editor" && caller.userId ? caller.userId : hashIp(caller.ip);
  const id = `${caller.role}:${who}`;
  const entries = windows.map((w) => ({ key: `${w.shared || id}:${w.name}`, seconds: w.seconds, fallback: w.fallback }));
  const { counts, limits } = await count(entries, now);
  for (const [i, w] of windows.entries()) {
    if (counts[i] > (limits ? limits[i] : w.limit())) {
      const retryAfter = Math.max(1, Math.ceil(w.seconds - ((now() / 1000) % w.seconds)));
      console.warn(`Chat rate limit (${w.shared ? "all visitors" : w.name}) hit by ${caller.role} ${caller.role === "editor" ? caller.userId : hashIp(caller.ip)}`);
      return { ok: false, retryAfter, message: w.say };
    }
  }
  return { ok: true };
}

/**
 * The panel's own requests (GET /chat/plan, /chat/status, dropping an item, a new photo) per editor: generous (config.chatPanelHourlyLimit, 600/hour),
 * so polling and normal use never trip it, but a loop can't turn into unbounded work. { ok: true } or { ok: false, retryAfter }.
 */
export async function checkPanelLimit(userId, { now = Date.now } = {}) {
  const { counts, limits } = await count([{ key: `panel:${userId}:hour`, seconds: 3600, fallback: 1200 }], now);
  if (counts[0] > (limits ? limits[0] : config.chatPanelHourlyLimit)) {
    console.warn(`Panel rate limit hit by editor ${userId}`);
    return { ok: false, retryAfter: Math.max(1, Math.ceil(3600 - ((now() / 1000) % 3600))) };
  }
  return { ok: true };
}

// --- failed sign-in checks ------------------------------------------------------------------------------------------------------
// Every request with a token makes /chat ask Supabase who it is. Failures are counted per visitor, and once a visitor has failed too
// often this hour /chat refuses (429) before asking Supabase again. The count is kept in memory per instance and seeded from the
// shared counter, which is also what the logs and audits look at. Only a hashed address is ever logged, never the token.
const failures = new Map(); // "key|hour" -> count

export function authBlocked(ip, { now = Date.now } = {}) {
  return (failures.get(`${hashIp(ip)}|${Math.floor(now() / 3600_000)}`) || 0) >= config.authFailureHourlyLimit;
}

export async function recordAuthFailure(ip, { now = Date.now, reason = "bad token" } = {}) {
  const key = `${hashIp(ip)}|${Math.floor(now() / 3600_000)}`;
  let n = (failures.get(key) || 0) + 1;
  if (failures.size > 5000) failures.clear();
  if (supabaseUp()) {
    try {
      n = Math.max(n, await hit(`authfail:${hashIp(ip)}:hour`, 3600));
    } catch {
      // the in-memory count still applies
    }
  }
  failures.set(key, n);
  console.warn(`Failed sign-in check (${reason}) from visitor ${hashIp(ip)}: ${n} this hour`);
}

/** Test hook: lets a test see the one-time warnings again and clears the in-memory counters. */
export function resetRateLimitWarning() {
  warned = false;
  warnedFallback = false;
  memory.clear();
  failures.clear();
}
