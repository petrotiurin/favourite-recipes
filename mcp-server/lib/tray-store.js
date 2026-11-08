// The household plan tray's storage (docs/chatbot-design.md D5, 7.1): one row in Supabase `trays` (supabase/migrations/*_trays.sql) and
// the staged photos in the private Storage bucket `tray-photos` (<tray id>/<slug>.jpg). Server-only, with the service-role key: RLS is on
// with no policies and the bucket is private, so the browser can't read either. Photos are shown through short-lived signed URLs.
//
// A tray row is { id, status, items (jsonb array), list_hash, version, created_at, expires_at, updated_at, updated_by }. Writes are
// optimistic: patchTray() only succeeds when `version` is still what the caller read, so two editors (or a background photo job and an
// editor) adding at the same moment never overwrite each other; callers re-read and retry (see lib/tray.js mutate()).
import { config } from "./config.js";
import { rest, q, clock, StoreError } from "./chat-store.js";

export const TRAY_DAYS = 7;
export const TRAY_TTL_MS = TRAY_DAYS * 24 * 60 * 60 * 1000;
export const PHOTO_BUCKET = "tray-photos";
export const SIGNED_URL_SECONDS = 600;

/** The active tray row, or null. There is at most one (a unique index on the table). */
export async function readTray() {
  const rows = await rest("trays", { query: q({ select: "*", limit: "1" }) });
  return rows[0] || null;
}

/** Starts the household's tray with its first items; expires 7 days from now. Returns the row, or null if one was created meanwhile. */
export async function createTray({ items, listHash = null, status = "collecting", updatedBy }) {
  const now = clock.now();
  try {
    const rows = await rest("trays", {
      method: "POST",
      prefer: "return=representation",
      body: { items, list_hash: listHash, status, version: 0, created_at: new Date(now).toISOString(), expires_at: new Date(now + TRAY_TTL_MS).toISOString(), updated_at: new Date(now).toISOString(), updated_by: updatedBy ?? null },
    });
    return rows[0];
  } catch (err) {
    if (/ 409:/.test(err.message)) return null; // the unique index: someone else started the tray first
    throw err;
  }
}

/** Writes `patch` (items, list_hash, status) if the row is still at `version`; returns the new row, or null when it changed under us. */
export async function patchTray(id, version, patch, updatedBy) {
  const rows = await rest("trays", {
    method: "PATCH",
    prefer: "return=representation",
    query: q({ id: `eq.${id}`, version: `eq.${version}` }),
    body: { ...patch, version: version + 1, updated_at: new Date(clock.now()).toISOString(), ...(updatedBy ? { updated_by: updatedBy } : {}) },
  });
  return rows[0] || null;
}

export async function deleteTrayRow(id) {
  await rest("trays", { method: "DELETE", query: q({ id: `eq.${id}` }) });
}

// --- Storage ----------------------------------------------------------------------------------------------------------

export async function storage(path, { method = "GET", body, headers = {}, json = false } = {}) {
  let res;
  try {
    res = await fetch(`${config.supabaseUrl}/storage/v1/${path}`, {
      method,
      headers: { apikey: config.supabaseServiceKey, Authorization: `Bearer ${config.supabaseServiceKey}`, ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json ? JSON.stringify(body) : body,
    });
  } catch (err) {
    throw new StoreError(`Supabase Storage unreachable: ${err.message}`);
  }
  return res;
}

export const objectPath = (path) => path.split("/").map(encodeURIComponent).join("/");

/** Stores (or replaces) a staged photo. `path` is "<tray id>/<slug>.jpg". */
export async function uploadPhoto(path, bytes) {
  const res = await storage(`object/${PHOTO_BUCKET}/${objectPath(path)}`, { method: "POST", body: bytes, headers: { "Content-Type": "image/jpeg", "x-upsert": "true", "Cache-Control": "max-age=60" } });
  if (!res.ok) throw new StoreError(`Storage upload answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/** The staged photo's bytes, or null when it isn't there. */
export async function downloadPhoto(path) {
  const res = await storage(`object/${PHOTO_BUCKET}/${objectPath(path)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new StoreError(`Storage download answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Deletes staged photos (best effort per call: a missing one is not an error). */
export async function removePhotos(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return;
  const res = await storage(`object/${PHOTO_BUCKET}`, { method: "DELETE", json: true, body: { prefixes: list } });
  if (!res.ok) throw new StoreError(`Storage delete answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/** Deletes everything under a tray's folder (the tray was saved, expired or emptied). */
export async function removeTrayPhotos(trayId) {
  const res = await storage(`object/list/${PHOTO_BUCKET}`, { method: "POST", json: true, body: { prefix: trayId, limit: 200 } });
  if (!res.ok) throw new StoreError(`Storage list answered ${res.status}`);
  const names = (await res.json()).map((o) => `${trayId}/${o.name}`);
  await removePhotos(names);
}

/** A signed URL (valid SIGNED_URL_SECONDS) the editor's browser can show the staged photo with, or null. */
export async function signedPhotoUrl(path, seconds = SIGNED_URL_SECONDS) {
  const res = await storage(`object/sign/${PHOTO_BUCKET}/${objectPath(path)}`, { method: "POST", json: true, body: { expiresIn: seconds } });
  if (!res.ok) return null;
  const { signedURL } = await res.json();
  return signedURL ? `${config.supabaseUrl}/storage/v1${signedURL.startsWith("/") ? "" : "/"}${signedURL}` : null;
}
