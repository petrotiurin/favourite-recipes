import { assertConfigured } from "../lib/config.js";
import { verifyUploadToken } from "../lib/auth.js";
import { saveUploadedImage, pageUrl } from "../lib/recipes.js";

// A tiny page a person opens from the link create_image_upload_link returns.
// The browser downsizes the photo before upload (phone photos are often bigger
// than Vercel's 4.5MB request limit); the server normalises it again anyway.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Upload recipe photo</title>
<style>
  :root { color-scheme: light dark; --accent: #c2410c; }
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 0 auto; padding: 2rem 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  .pick { display: block; border: 2px dashed #9ca3af; border-radius: 12px; padding: 2rem 1rem; text-align: center; cursor: pointer; }
  .pick input { display: block; margin: 1rem auto 0; max-width: 100%; }
  img { display: none; width: 100%; border-radius: 12px; margin-top: 1rem; }
  button { margin-top: 1rem; width: 100%; padding: .9rem; font-size: 1rem; border: 0; border-radius: 10px; background: var(--accent); color: #fff; }
  button:disabled { opacity: .5; }
  .msg { margin-top: 1rem; }
  .err { color: #dc2626; }
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

export async function GET(request) {
  const token = new URL(request.url).searchParams.get("t");
  const claim = verifyUploadToken(token);
  if (!claim) return expired();
  return page(`
<h1>Photo for <em>${escapeHtml(claim.slug)}</em></h1>
<form id="f" method="post" enctype="multipart/form-data">
  <label class="pick">Choose or take a photo of the finished dish
    <input id="file" type="file" name="photo" accept="image/*" required>
  </label>
  <img id="preview" alt="Preview">
  <button id="go" type="submit">Upload photo</button>
  <p id="msg" class="msg"></p>
</form>
<script>
(() => {
  const MAX = 1600;
  const form = document.getElementById("f"), file = document.getElementById("file");
  const preview = document.getElementById("preview"), go = document.getElementById("go"), msg = document.getElementById("msg");
  file.addEventListener("change", () => {
    if (!file.files[0]) return;
    preview.src = URL.createObjectURL(file.files[0]);
    preview.style.display = "block";
  });
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!file.files[0]) return;
    go.disabled = true; msg.className = "msg"; msg.textContent = "Uploading…";
    const body = new FormData();
    body.append("photo", await shrink(file.files[0]), "photo.jpg");
    try {
      const res = await fetch(location.href, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      form.innerHTML = "<h2>✅ Uploaded</h2><p>Go back to your assistant and tell it the photo is uploaded.</p>";
    } catch (err) {
      msg.className = "msg err"; msg.textContent = err.message; go.disabled = false;
    }
  });
})();
</script>`);
}

export async function POST(request) {
  const wantsJson = (request.headers.get("accept") || "").includes("application/json");
  const reply = (status, payload) =>
    wantsJson
      ? Response.json(payload, { status })
      : page(status === 200 ? `<h1>✅ Uploaded</h1><p>Tell your assistant the photo is uploaded.</p>` : `<h1>Upload failed</h1><p class="err">${escapeHtml(payload.error)}</p>`, status);

  try {
    assertConfigured();
  } catch (err) {
    return reply(500, { error: err.message });
  }
  const claim = verifyUploadToken(new URL(request.url).searchParams.get("t"));
  if (!claim) return reply(403, { error: "This upload link is invalid or has expired. Ask your assistant for a new one." });

  let photo;
  try {
    photo = (await request.formData()).get("photo");
  } catch {
    return reply(400, { error: "Could not read the upload" });
  }
  if (!photo || typeof photo === "string" || !photo.size) return reply(400, { error: "No photo received" });

  try {
    const commit = await saveUploadedImage(claim.slug, Buffer.from(await photo.arrayBuffer()));
    return reply(200, { ok: true, commit: commit.url, page: pageUrl(claim.slug) });
  } catch (err) {
    console.error(err);
    return reply(400, { error: err.message });
  }
}
