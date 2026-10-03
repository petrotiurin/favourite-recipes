import { assertConfigured } from "../lib/config.js";
import { verifyUploadToken } from "../lib/auth.js";
import { saveUploadedImage, pageUrl } from "../lib/recipes.js";

// A tiny page a person opens from the link create_image_upload_link returns. One link
// can cover several recipes: the page lists them all, and each photo uploads as soon as
// it's picked (one request per photo keeps every request under Vercel's 4.5MB limit and
// lets one failed photo be retried on its own). The browser downsizes each photo first;
// the server normalises it again anyway.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Upload recipe photos</title>
<style>
  :root { color-scheme: light dark; --accent: #c2410c; }
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 0 auto; padding: 2rem 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .75rem; }
  .item { border: 1px solid #d1d5db; border-radius: 14px; padding: 1rem; margin-top: 1.25rem; }
  .item.done { border-color: #16a34a; }
  .pick { display: block; border: 2px dashed #9ca3af; border-radius: 12px; padding: 1.25rem 1rem; text-align: center; cursor: pointer; }
  .pick input { display: block; margin: 1rem auto 0; max-width: 100%; }
  .js .pick input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .js .go { display: none; }
  .item.done .pick { border-style: solid; }
  img { display: none; width: 100%; max-height: 14rem; object-fit: cover; border-radius: 12px; margin-top: 1rem; }
  button { margin-top: 1rem; width: 100%; padding: .9rem; font-size: 1rem; border: 0; border-radius: 10px; background: var(--accent); color: #fff; }
  button:disabled { opacity: .5; }
  .msg { margin: .75rem 0 0; }
  .msg:empty { display: none; }
  .err { color: #dc2626; }
  .ok { color: #16a34a; }
  #summary { margin-top: 1.5rem; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

function expired() {
  return page(`<h1>Link expired</h1><p>This upload link is invalid or has expired. Ask your assistant for a new one.</p>`, 403);
}

function itemForm({ slug, label }, i, many) {
  return `
<form class="item" method="post" enctype="multipart/form-data">
  <input type="hidden" name="slug" value="${escapeHtml(slug)}">
  <h2>${many ? `${i + 1}. ` : ""}${escapeHtml(label)}</h2>
  <label class="pick"><span class="pick-text">📷 Choose or take a photo of the finished dish</span>
    <input class="file" type="file" name="photo" accept="image/*" required>
  </label>
  <img class="preview" alt="">
  <button class="go" type="submit">Upload photo</button>
  <p class="msg" role="status"></p>
</form>`;
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get("t");
  const claim = verifyUploadToken(token);
  if (!claim) return expired();
  const n = claim.items.length;
  return page(`
<h1>${n === 1 ? "Upload the recipe photo" : `Upload ${n} recipe photos`}</h1>
<p>Pick a photo of each finished dish. Each one uploads as soon as you pick it${n === 1 ? "" : ", in any order"}.</p>
${claim.items.map((item, i) => itemForm(item, i, n > 1)).join("")}
<p id="summary" role="status"></p>
<script>
(() => {
  document.documentElement.classList.add("js");
  const MAX = 1600;
  const forms = [...document.querySelectorAll("form.item")];
  const summary = document.getElementById("summary");
  let queue = Promise.resolve(); // one upload at a time: each is its own commit to the repo

  function updateSummary() {
    const done = forms.filter((f) => f.classList.contains("done")).length;
    summary.className = done === forms.length ? "ok" : "";
    summary.textContent = done === forms.length
      ? (forms.length === 1 ? "✅ Uploaded. " : "✅ All " + forms.length + " photos uploaded. ") + "Go back to your assistant and tell it they're done."
      : forms.length > 1 ? done + " of " + forms.length + " uploaded" : "";
  }

  async function shrink(f) {
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9)) || f;
    } catch { return f; }
  }

  for (const form of forms) {
    const file = form.querySelector(".file"), preview = form.querySelector(".preview");
    const msg = form.querySelector(".msg"), pickText = form.querySelector(".pick-text");
    const status = (text, cls) => { msg.className = "msg " + (cls || ""); msg.textContent = text; };

    async function upload(chosen) {
      status("Uploading…");
      const body = new FormData();
      body.append("slug", form.elements.slug.value);
      body.append("photo", await shrink(chosen), "photo.jpg");
      try {
        const res = await fetch(location.href, { method: "POST", body, headers: { Accept: "application/json" } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Upload failed");
        form.classList.add("done");
        status("✅ Uploaded", "ok");
        pickText.textContent = "Replace photo";
      } catch (err) {
        form.classList.remove("done");
        status(err.message + " Pick the photo again to retry.", "err");
      }
      updateSummary();
    }

    file.addEventListener("change", () => {
      const chosen = file.files[0];
      if (!chosen) return;
      preview.src = URL.createObjectURL(chosen);
      preview.style.display = "block";
      form.classList.remove("done");
      status("Waiting…");
      queue = queue.then(() => upload(chosen));
      file.value = ""; // picking the same file again retries it
    });
    form.addEventListener("submit", (e) => e.preventDefault());
  }
  updateSummary();
})();
</script>`);
}

export async function POST(request) {
  const wantsJson = (request.headers.get("accept") || "").includes("application/json");
  const back = `<p><a href="${escapeHtml(request.url)}">Back to the upload page</a></p>`;
  const reply = (status, payload) =>
    wantsJson
      ? Response.json(payload, { status })
      : page(
          status === 200
            ? `<h1>✅ Uploaded</h1><p>Upload any other photos, then tell your assistant they're uploaded.</p>${back}`
            : `<h1>Upload failed</h1><p class="err">${escapeHtml(payload.error)}</p>${back}`,
          status
        );

  try {
    assertConfigured();
  } catch (err) {
    return reply(500, { error: err.message });
  }
  const claim = verifyUploadToken(new URL(request.url).searchParams.get("t"));
  if (!claim) return reply(403, { error: "This upload link is invalid or has expired. Ask your assistant for a new one." });

  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: "Could not read the upload" });
  }
  // The link only covers the recipes it was made for; a single-recipe link doesn't need the field.
  const slug = form.get("slug") || (claim.items.length === 1 ? claim.items[0].slug : null);
  if (!claim.items.some((i) => i.slug === slug)) return reply(403, { error: "This link doesn't cover that recipe." });
  const photo = form.get("photo");
  if (!photo || typeof photo === "string" || !photo.size) return reply(400, { error: "No photo received" });

  try {
    const commit = await saveUploadedImage(slug, Buffer.from(await photo.arrayBuffer()));
    return reply(200, { ok: true, slug, commit: commit.url, page: pageUrl(slug) });
  } catch (err) {
    console.error(err);
    return reply(400, { error: err.message });
  }
}
