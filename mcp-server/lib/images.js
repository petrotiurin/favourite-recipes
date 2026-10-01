import sharp from "sharp";
import { MAX_IMAGE_EDGE } from "./config.js";

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Normalises any incoming photo into the site's image format:
 * EXIF-rotated, long edge <= 1600px, metadata stripped, progressive JPEG.
 * Always producing .jpg keeps paths predictable: images/recipes/<slug>.jpg
 */
export async function normalizeImage(buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new Error("That file isn't a readable image (supported: JPEG, PNG, WebP, AVIF, GIF, TIFF)");
  }
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  if (Math.min(meta.width, meta.height) < 300) {
    throw new Error(`Image is too small (${meta.width}x${meta.height}); use a photo at least 300px on the short edge`);
  }
  const out = await sharp(buffer)
    .rotate()
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, ext: "jpg" };
}

export async function downloadImage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid image URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Image URL must be http(s)");

  const res = await fetch(parsed, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; favourite-recipes-mcp)", Accept: "image/*" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Downloading image failed: HTTP ${res.status} from ${parsed.host}`);
  const type = res.headers.get("content-type") || "";
  if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream")) {
    throw new Error(`URL did not return an image (content-type: ${type}). Pass a direct link to the image file.`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error("Image is larger than 25MB");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error("Image is larger than 25MB");
  return buf;
}

export function decodeBase64Image(data) {
  const cleaned = data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const buf = Buffer.from(cleaned, "base64");
  if (!buf.length) throw new Error("image_base64 is empty or not valid base64");
  return buf;
}
