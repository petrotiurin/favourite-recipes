import path from "node:path";
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import staticFiles from "./src/integrations/static-files.ts";

// BUILD_OUT_DIR lets tests and one-off builds write somewhere else, so a running dev site in dist/ is left alone.
const outDir = process.env.BUILD_OUT_DIR ? path.resolve(process.env.BUILD_OUT_DIR) : "./dist";

export default defineConfig({
  output: "static",
  site: "https://petrotiurin.github.io",
  base: "/favourite-recipes",
  outDir,
  // The pages are written by the renderers in templates/; keep their whitespace exactly.
  compressHTML: false,
  build: { format: "file" },
  integrations: [preact(), staticFiles()],
});
