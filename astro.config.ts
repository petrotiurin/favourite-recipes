import path from "node:path";
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import { satteri } from "@astrojs/markdown-satteri";
import staticFiles from "./src/integrations/static-files.ts";

// BUILD_OUT_DIR lets tests and one-off builds write somewhere else, so a running dev site in dist/ is left alone.
const outDir = process.env.BUILD_OUT_DIR ? path.resolve(process.env.BUILD_OUT_DIR) : "./dist";

export default defineConfig({
  output: "static",
  site: "https://petrotiurin.github.io",
  base: "/favourite-recipes",
  outDir,
  // Keep the whitespace of the components' markup as written (inline elements next to each other matter).
  compressHTML: false,
  // Recipe bodies are Markdown as written (Astro's own Markdown processor, GitHub-flavoured): no curly quotes or dashes added, as `marked` never did.
  markdown: { processor: satteri({ features: { smartPunctuation: false } }) },
  build: { format: "file" },
  integrations: [preact(), staticFiles()],
});
