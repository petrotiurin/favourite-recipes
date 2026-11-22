// The pages the backend serves carry inline browser scripts inside template literals; the TypeScript checker can't see into them, so a
// type annotation that leaks in (`catch (err: any)`) only shows up as a SyntaxError in the browser. This parses each one as plain JavaScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

process.env.GITHUB_TOKEN = "gh-test";
process.env.MCP_AUTH_TOKEN = "secret";

test("every inline <script> the backend serves parses as plain JavaScript", async () => {
  const { createUploadToken } = await import("../lib/auth.ts");
  const upload = await import("../api/upload.ts");
  const token = createUploadToken([{ slug: "a-recipe", label: "A recipe" }]);
  const pages = [await upload.GET(new Request(`https://mcp.test/upload?t=${encodeURIComponent(token)}`))];
  let scripts = 0;
  for (const res of pages) {
    const html = await res.text();
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      scripts++;
      assert.doesNotThrow(() => new vm.Script(m[1]), "inline script must be plain JavaScript");
    }
  }
  assert.ok(scripts > 0, "the upload page has a script");
});
