// Serves the original recipe photos (still published at /images/recipes/ for the chat's recipe cards, whose photo links the backend gives, and for outside
// links; the pages use Astro's sized copies, src/components/Photo.astro) exactly as they are (no hashing): the dev server answers them and the build copies
// them into dist/ next to the pages.
import fs from "node:fs";
import path from "node:path";
import type { AstroIntegration } from "astro";

const ROOT = process.cwd();

const mime: Record<string, string> = {
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
                  // Ahead of Vite's own handling, so the files are served as they are.
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
