// TEMPORARY (docs/typescript-migration.md 5.1): imports a file from the repo's top-level shared/ to see whether the Vercel build
// includes files outside mcp-server/. Delete together with shared/vercel-probe.js once the answer is in.
import { probe } from "../../shared/vercel-probe.js";

export function GET() {
  return new Response(JSON.stringify({ probe }), { headers: { "content-type": "application/json" } });
}
