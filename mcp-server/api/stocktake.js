import { config, assertStocktakeConfigured } from "../lib/config.js";
import { verifyEditor } from "../lib/auth.js";
import { saveStocktake, StocktakeError } from "../lib/shopping-list.js";

// The shopping page (on GitHub Pages) posts the stocktake here: which items are already at home,
// fully or partly. The editor is signed in with Supabase Auth on the page; only SHOPPING_EDITORS
// may save. Saving commits shopping-list.json, so the site redeploys with the stocktake baked in.

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

export async function POST(request) {
  const headers = corsHeaders(request);
  const reply = (body, status = 200) => Response.json(body, { status, headers: { ...headers, "Cache-Control": "no-store" } });
  try {
    assertStocktakeConfigured();
  } catch (err) {
    return reply({ error: err.message }, 503);
  }
  const editor = await verifyEditor(request);
  if (editor.error) return reply({ error: editor.error }, editor.status);

  let body;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "Send JSON: { items: [{ name, quantity, have }] }" }, 400);
  }
  try {
    const { list, commit, counts } = await saveStocktake(body?.items);
    return reply({ ok: true, stocktake: list.stocktake, counts, commit: commit.url });
  } catch (err) {
    if (err instanceof StocktakeError) return reply({ error: err.message }, err.status);
    console.error(err);
    return reply({ error: "Saving failed. Try again in a minute." }, 500);
  }
}
