// Serves the site's browser scripts that are not islands yet (templates/*, until steps 7 and 8 of docs/typescript-migration.md) and the original recipe photos (still published at /images/recipes/ for the chat's cards and outside links; the pages use Astro's sized copies, src/components/Photo.astro) exactly as they are (no bundling, no hashing):
// the dev server answers them and the build copies them into dist/ next to the pages. Which scripts go in depends on the same
// env vars as before: auth.js only with SUPABASE_URL + SUPABASE_ANON_KEY, chat.js only with CHAT_API_URL.
import fs from "node:fs";
import path from "node:path";
import type { AstroIntegration } from "astro";

const ROOT = process.cwd();

const mime: Record<string, string> = {
  ".js": "text/javascript",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
};

/** Published path (relative to the site root) -> source file. */
function staticFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const add = (publishedPath: string, source: string) => files.set(publishedPath, path.join(ROOT, source));
  add("shopping.js", "templates/shopping.js");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) add("auth.js", "templates/auth.cjs");
  if (process.env.CHAT_API_URL) add("chat.js", "templates/chat.cjs");
  const images = path.join(ROOT, "images");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.posix.join("images", path.relative(images, full).split(path.sep).join("/")), full);
    }
  };
  if (fs.existsSync(images)) walk(images);
  return files;
}

export default function staticFilesIntegration(): AstroIntegration {
  let base = "/";
  return {
    name: "static-files",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        base = config.base.replace(/\/?$/, "/");
        updateConfig({
          vite: {
            plugins: [
              {
                name: "static-files-dev",
                configureServer(server) {
                  server.middlewares.use((req, res, next) => {
                    const url = (req.url ?? "").split("?")[0];
                    // The base is already stripped when this runs (it is kept if the order ever changes).
                    const rel = url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, "");
                    const source = staticFiles().get(decodeURIComponent(rel));
                    if (!source || !fs.existsSync(source)) return next();
                    res.setHeader("Content-Type", mime[path.extname(rel).toLowerCase()] ?? "application/octet-stream");
                    fs.createReadStream(source).pipe(res);
                  });
                  // Ahead of Vite's own handling of .js, so the scripts are served as they are.
                  const stack = (server.middlewares as unknown as { stack: unknown[] }).stack;
                  stack.unshift(stack.pop());
                },
              },
            ],
          },
        });
      },
      "astro:build:done": ({ dir }) => {
        const out = new URL(dir).pathname;
        for (const [published, source] of staticFiles()) {
          const target = path.join(out, published);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
        }
      },
    },
  };
}
