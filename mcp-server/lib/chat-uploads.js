// Photos an editor attaches in the chat (docs/chatbot-design.md D3 "Images"). Editors only: /chat refuses them for everyone else.
// Every upload is untrusted bytes from a browser: size-checked, sniffed (sharp reads the real format, the claimed type is ignored),
// decoded and RE-ENCODED as a plain JPEG (EXIF-rotated, long edge <= 1600px, all metadata dropped) before anything stores it or
// shows it to a model. Stored in the private Storage bucket `chat-uploads` as <conversation>/<uuid>.jpg; the message row keeps
// only the path. Server-only, with the service-role key.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { MAX_IMAGE_EDGE } from "./config.js";
import { q, rest, isUuid, StoreError } from "./chat-store.js";
import { storage, objectPath, SIGNED_URL_SECONDS } from "./tray-store.js";
import { config } from "./config.js";

export const UPLOAD_BUCKET = "chat-uploads";
export const MAX_IMAGES = 4; // per message
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // per image, as sent by the browser (it downscales first, so this is generous)
export const MAX_UPLOAD_PIXELS = 40_000_000; // refuses decompression bombs
const FORMATS = new Set(["jpeg", "png", "webp", "gif", "heif", "avif"]);

export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Validates the `images` field of an editor's request ([ "data:image/jpeg;base64,...", ... ]) and re-encodes each image.
 * Returns [{ buffer (JPEG), width, height }]; throws UploadError with a message that is safe to show.
 */
export async function sanitizeUploads(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UploadError("Photos must be a list.");
  if (raw.length > MAX_IMAGES) throw new UploadError(`At most ${MAX_IMAGES} photos per message.`);
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new UploadError("A photo wasn't sent properly.");
    const m = item.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) throw new UploadError("A photo wasn't sent properly.");
    const bytes = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
    if (!bytes.length) throw new UploadError("A photo was empty.");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError("A photo is too big (3 MB at most).", 413);
    let meta;
    try {
      meta = await sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS }).metadata();
    } catch {
      throw new UploadError("One of the files isn't a readable photo.");
    }
    if (!FORMATS.has(meta.format) || !meta.width || !meta.height) throw new UploadError("One of the files isn't a supported photo (JPEG, PNG, WebP).");
    try {
      const { data, info } = await sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS, pages: 1 })
        .rotate()
        .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      out.push({ buffer: data, width: info.width, height: info.height });
    } catch {
      throw new UploadError("One of the files isn't a readable photo.");
    }
  }
  return out;
}

export const dataUrl = (buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`;

/** Stores the sanitized images under the conversation. Returns [{ path, width, height }]. */
export async function storeUploads(conversationId, images) {
  if (!isUuid(conversationId)) throw new StoreError("bad conversation id");
  const stored = [];
  try {
    for (const img of images) {
      const path = `${conversationId}/${randomUUID()}.jpg`;
      const res = await storage(`object/${UPLOAD_BUCKET}/${objectPath(path)}`, { method: "POST", body: img.buffer, headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" } });
      if (!res.ok) throw new StoreError(`Upload storage answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      stored.push({ path, width: img.width, height: img.height });
    }
  } catch (err) {
    await removeUploads(stored.map((s) => s.path)).catch(() => {});
    throw err;
  }
  return stored;
}

const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i;
export const isUploadPath = (p) => typeof p === "string" && PATH.test(p);

/** The stored photo's bytes, or null when it's gone. */
export async function downloadUpload(path) {
  if (!isUploadPath(path)) return null;
  const res = await storage(`object/${UPLOAD_BUCKET}/${objectPath(path)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new StoreError(`Upload download answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A short-lived URL the editor's browser can show the photo with, or null. */
export async function signedUploadUrl(path, seconds = SIGNED_URL_SECONDS) {
  if (!isUploadPath(path)) return null;
  const res = await storage(`object/sign/${UPLOAD_BUCKET}/${objectPath(path)}`, { method: "POST", json: true, body: { expiresIn: seconds } });
  if (!res.ok) return null;
  const { signedURL } = await res.json();
  return signedURL ? `${config.supabaseUrl}/storage/v1${signedURL.startsWith("/") ? "" : "/"}${signedURL}` : null;
}

export async function removeUploads(paths) {
  const list = [...new Set(paths.filter(isUploadPath))];
  if (!list.length) return;
  const res = await storage(`object/${UPLOAD_BUCKET}`, { method: "DELETE", json: true, body: { prefixes: list } });
  if (!res.ok) throw new StoreError(`Upload delete answered ${res.status}`);
}

/** Deletes every photo of one conversation (the editor deleted the chat). Never throws. */
export async function removeConversationUploads(conversationId) {
  if (!isUuid(conversationId)) return;
  try {
    const res = await storage(`object/list/${UPLOAD_BUCKET}`, { method: "POST", json: true, body: { prefix: conversationId, limit: 200 } });
    if (!res.ok) return;
    await removeUploads((await res.json()).map((o) => `${conversationId}/${o.name}`));
  } catch (err) {
    console.error("Deleting a chat's photos failed:", err.message);
  }
}

let lastSweep = 0;
/**
 * Deletes the photos of chats that no longer exist (expired by purge_old_chats, or deleted): lists the bucket's folders (one per conversation),
 * asks which conversations still exist and removes the rest. At most once an hour per instance; never throws.
 */
export async function sweepOrphans({ now = Date.now(), force = false } = {}) {
  if (!force && now - lastSweep < 60 * 60 * 1000) return 0;
  lastSweep = now;
  try {
    const res = await storage(`object/list/${UPLOAD_BUCKET}`, { method: "POST", json: true, body: { prefix: "", limit: 1000 } });
    if (!res.ok) return 0;
    const folders = (await res.json()).map((o) => o.name).filter(isUuid).slice(0, 200);
    if (!folders.length) return 0;
    const alive = new Set((await rest("conversations", { query: q({ select: "id", id: `in.(${folders.join(",")})` }) })).map((r) => r.id));
    let removed = 0;
    for (const id of folders.filter((f) => !alive.has(f))) {
      await removeConversationUploads(id);
      removed++;
    }
    return removed;
  } catch (err) {
    console.error("Sweeping chat photos failed:", err.message);
    return 0;
  }
}
export const resetSweepThrottle = () => { lastSweep = 0; };
