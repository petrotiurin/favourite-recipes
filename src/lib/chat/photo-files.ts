// An editor's photos before they are sent (docs/chatbot-design.md, .claude/rules/chat.md "Photos"): each picked photo is decoded and redrawn on a
// canvas at most 1600px on the long edge as a JPEG (no EXIF leaves the phone, and the upload stays small); the server checks and re-encodes it again.
import type { Message } from "./clean.ts";

export const MAX_PHOTOS = 8;

/** A photo picked for the next message. state: uploading | done | failed | local ("local": the server has no upload route; it goes as data). */
export interface PendingPhoto {
  /** A local preview (an object URL). */
  url: string;
  /** The JPEG as a data URL. */
  data: string;
  state?: "uploading" | "done" | "failed" | "local";
  /** Where the upload put it (the message refers to it by this). */
  path?: string;
  promise?: Promise<void>;
}

/** The picked file redrawn as a JPEG of at most 1600px (smaller and rougher until it is under about 800 KB). */
export function downscale(file: Blob, doc: Document = document): Promise<PendingPhoto> {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return reject(new Error("size"));
      const attempts: [number, number][] = [[1600, 0.82], [1600, 0.68], [1280, 0.6], [1000, 0.55]];
      let data = "";
      for (const [edge, quality] of attempts) {
        const k = Math.min(1, edge / Math.max(w, h));
        const c = doc.createElement("canvas");
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        data = c.toDataURL("image/jpeg", quality);
        if (data.length < 1100000) break; // ~800 KB of JPEG: four of them stay under the request limit
      }
      resolve({ url: src, data });
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("decode"));
    };
    img.src = src;
  });
}

/** How many photos this chat already has (the next one picked is that + 1). */
export function chatPhotoCount(messages: Message[]): number {
  let n = 0;
  messages.forEach((m) => {
    if (m.role !== "user" || !m.images) return;
    const top = m.numbers && m.numbers.length ? m.numbers[m.numbers.length - 1] : 0;
    n = Math.max(n + m.images.length, top);
  });
  return n;
}

/** The note when more photos were picked than fit, or "" when they all fit. */
export function tooManyNote(picked: number, room: number): string {
  if (picked <= room) return "";
  return room ? `Only ${MAX_PHOTOS} photos per message; added the first ${room}.` : `That's ${MAX_PHOTOS} photos already, the most for one message: send these first, or remove one.`;
}
