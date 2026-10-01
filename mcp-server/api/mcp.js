import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { assertConfigured } from "../lib/config.js";
import { isAuthorized } from "../lib/auth.js";
import { buildServer } from "../lib/server.js";

// Stateless Streamable HTTP: a fresh server + transport per request, which is
// what serverless functions want (no session affinity, no Redis).
async function handle(request) {
  try {
    assertConfigured();
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const origin = host ? `https://${host}` : new URL(request.url).origin;
  const server = buildServer({ origin });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
