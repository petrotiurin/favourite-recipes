import { config, assertChatConfigured } from "../lib/config.js";
import { verifyUser } from "../lib/auth.js";
import { makeCaller } from "../lib/tools.js";
import { checkRateLimit, clientIp, hashIp } from "../lib/rate-limit.js";
import { runChat, sanitizeMessages, ChatError } from "../lib/chat.js";
import { startTrace } from "../lib/langfuse.js";

// POST /chat: the site's chat widget (templates/chat.js) talks to this. Streams the answer as Server-Sent Events:
//   event: text         data: { delta }
//   event: status       data: { text }        what the bot is doing, in plain words
//   event: suggestions  data: { replies }     tappable suggested replies: strings, or { label, url } chips that open a site page
//   event: cards        data: { cards }       recipe cards built from our own data (show_recipes)
//   event: navigation   data: { label, url }  a button that opens one site page (offer_navigation); never navigates by itself
//   event: done         data: { suggestions }
//   event: error        data: { message }     safe to show the visitor
// Phase 1 is anonymous: the caller is always role "public" (read tools only). A bearer token, if sent, is checked
// (bad or expired -> 401, never downgraded) but doesn't change the role yet. The role is never read from the body.

const MAX_BODY_BYTES = 100_000;

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(config.siteUrl).origin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/** The page context the client reports, reduced to plain values (the server re-resolves anything that matters). */
function pageFrom(raw) {
  if (!raw || typeof raw !== "object") return {};
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
  return {
    page: str(raw.page, 30),
    slug: str(raw.slug, 120),
    servings: Number.isInteger(raw.servings) ? raw.servings : undefined,
    filter: str(raw.filter, 30),
    search: str(raw.search, 200),
    dismissed: raw.dismissed === true,
  };
}

export async function POST(request) {
  const headers = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

  try {
    assertChatConfigured();
  } catch (err) {
    console.error(err.message);
    return reply({ error: "The chat isn't available right now." }, 503);
  }

  // Who is calling, decided once from the request (design 4.1): a verified token or nothing, never the body.
  if (request.headers.get("authorization")) {
    const user = await verifyUser(request);
    if (user.error) return reply({ error: user.error }, user.status);
    // A valid token is still a visitor in this phase; the editor role arrives with phase 3.
  }
  const ip = clientIp(request);
  const caller = makeCaller({ role: "public", ip });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return reply({ error: "That message is too long." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: "Send JSON: { messages: [{ role, content }], page }" }, 400);
  }
  const messages = sanitizeMessages(body?.messages);
  if (!messages.length) return reply({ error: "Send a message to start the chat." }, 400);

  const limit = await checkRateLimit(caller);
  if (!limit.ok) return reply({ error: limit.message }, 429, { "Retry-After": String(limit.retryAfter) });

  const page = pageFrom(body?.page);
  const conversationId = typeof body?.conversation_id === "string" ? body.conversation_id.replace(/[^\w-]/g, "").slice(0, 64) : undefined;
  const trace = startTrace({
    name: "chat",
    sessionId: conversationId,
    userId: `public:${hashIp(ip)}`,
    tags: ["public"],
    metadata: { mode: "public", model: config.chatPublicModel, page: page.page === "recipe" ? { page: "recipe", slug: page.slug } : { page: page.page } },
    input: messages[messages.length - 1].content,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const emit = ({ type, ...data }) => send(type, data);
      let output;
      try {
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
        const result = await runChat({ caller, messages, page, emit, trace, signal: request.signal, origin: host ? `https://${host}` : new URL(request.url).origin });
        output = result.reply;
      } catch (err) {
        if (err?.name !== "AbortError") {
          if (!(err instanceof ChatError)) console.error(err);
          else if (err.kind === "out-of-credit") trace.event({ name: "out-of-credit", level: "ERROR" });
          const message = err instanceof ChatError ? err.message : "Something went wrong with the chat. Try again in a moment.";
          send("error", { message });
          output = `error: ${message}`;
        }
      } finally {
        trace.finish(output);
        closed = true;
        try {
          controller.close();
        } catch {
          // the client already went away
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
