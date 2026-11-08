// Per-visitor rate limits for /chat (docs/chatbot-design.md section 8): counters live in Supabase
// (supabase/migrations/*_rate_limits.sql), reached with the service-role key through PostgREST. The visitor is identified
// by a salted hash of their IP: the raw IP is never stored, logged or traced.
import { createHmac } from "node:crypto";
import { config } from "./config.js";

/** A stable, non-reversible id for an IP address. */
export function hashIp(ip) {
  const salt = config.ipHashSalt || config.supabaseServiceKey || "favourite-recipes-chat";
  return createHmac("sha256", salt).update(String(ip || "unknown")).digest("hex").slice(0, 24);
}

/** The caller's IP as Vercel (or the dev harness) reports it. */
export function clientIp(request) {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

let warned = false;
// Visitors are limited per hashed IP, signed-in editors (generous) per Supabase user id.
const WINDOWS = {
  public: [
    { name: "hour", seconds: 3600, limit: () => config.chatPublicHourlyLimit, say: "You've sent a lot of messages in the last hour. Give it a little while and try again." },
    { name: "day", seconds: 86400, limit: () => config.chatPublicDailyLimit, say: "That's all the chat messages for today. Try again tomorrow." },
  ],
  editor: [
    { name: "hour", seconds: 3600, limit: () => config.chatEditorHourlyLimit, say: "You've sent a lot of messages in the last hour. Give it a little while and try again." },
    { name: "day", seconds: 86400, limit: () => config.chatEditorDailyLimit, say: "That's all the chat messages for today. Try again tomorrow." },
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

/**
 * Counts one message from this caller and says whether it may go ahead:
 * { ok: true } or { ok: false, retryAfter (seconds), message }.
 * Without SUPABASE_SERVICE_ROLE_KEY limiting is skipped (local dev), with a one-time warning. If Supabase itself fails
 * the message is let through and the failure logged: OpenRouter's credit limit is the hard stop (D3).
 */
export async function checkRateLimit(caller, { now = Date.now } = {}) {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    if (!warned) {
      warned = true;
      console.warn("Chat rate limiting is off: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
    }
    return { ok: true };
  }
  const windows = WINDOWS[caller.role] || WINDOWS.public;
  const who = caller.role === "editor" && caller.userId ? caller.userId : hashIp(caller.ip);
  const id = `${caller.role}:${who}`;
  let counts;
  try {
    counts = await Promise.all(windows.map((w) => hit(`${id}:${w.name}`, w.seconds)));
  } catch (err) {
    console.error("Rate limit check failed, letting the message through:", err.message);
    return { ok: true };
  }
  for (const [i, w] of windows.entries()) {
    if (counts[i] > w.limit()) {
      const retryAfter = Math.max(1, Math.ceil(w.seconds - ((now() / 1000) % w.seconds)));
      console.warn(`Chat rate limit (${w.name}) hit by ${caller.role} ${caller.role === "editor" ? caller.userId : hashIp(caller.ip)}`);
      return { ok: false, retryAfter, message: w.say };
    }
  }
  return { ok: true };
}

/** Test hook: lets a test see the one-time warning again. */
export function resetRateLimitWarning() {
  warned = false;
}
