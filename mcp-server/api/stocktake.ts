import { config, assertStocktakeConfigured } from "../lib/config.ts";
import { verifyEditor } from "../lib/auth.ts";
import { saveStocktake, StocktakeError } from "../lib/shopping-list.ts";
import { makeCaller } from "../lib/tools.ts";
import { errorMessage } from "../lib/errors.ts";

// The shopping page (on GitHub Pages) posts the stocktake here: which items are already at home,
// fully or partly. The editor is signed in with Supabase Auth on the page; only EDITORS
// may save. Saving commits shopping-list.json, so the site redeploys with the stocktake baked in.

function corsHeaders(request: Request): Record<string, string> {
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

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...headers, "Cache-Control": "no-store" } });
  try {
    assertStocktakeConfigured();
  } catch (err) {
    return reply({ error: errorMessage(err) }, 503);
  }
  const editor = await verifyEditor(request);
  if (editor.error !== undefined) return reply({ error: editor.error }, editor.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "Send JSON: { items: [{ name, quantity, have }] }" }, 400);
  }
  try {
    const { list, commit, counts } = await saveStocktake(body && typeof body === "object" && "items" in body ? body.items : undefined, makeCaller({ role: "editor", email: editor.email, userId: editor.userId }));
    return reply({ ok: true, stocktake: list.stocktake, counts, commit: commit.url });
  } catch (err) {
    if (err instanceof StocktakeError) return reply({ error: err.message }, err.status);
    console.error(err);
    return reply({ error: "Saving failed. Try again in a minute." }, 500);
  }
}
