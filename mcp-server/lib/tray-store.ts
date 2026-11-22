// The household plan tray's storage (docs/chatbot-design.md D5, 7.1): one row in Supabase `trays` (supabase/migrations/*_trays.sql) and
// the staged photos in the private Storage bucket `tray-photos` (<tray id>/<slug>.jpg). Server-only, with the service-role key: RLS is on
// with no policies and the bucket is private, so the browser can't read either. Photos are shown through short-lived signed URLs.
//
// A tray row is { id, status, items (jsonb array), list_hash, version, created_at, expires_at, updated_at, updated_by }. Writes are
// optimistic: patchTray() only succeeds when `version` is still what the caller read, so two editors (or a background photo job and an
// editor) adding at the same moment never overwrite each other; callers re-read and retry (see lib/tray.ts mutate()).
import { config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { rows, rest, q, clock, StoreError } from "./chat-store.ts";
import type { TrayItem, TrayRow, TrayStatus } from "./types/tray.ts";

export const TRAY_DAYS = 7;
export const TRAY_TTL_MS = TRAY_DAYS * 24 * 60 * 60 * 1000;
export const PHOTO_BUCKET = "tray-photos";
export const SIGNED_URL_SECONDS = 600;

/** The active tray row, or null. There is at most one (a unique index on the table). */
export async function readTray(): Promise<TrayRow | null> {
  const found = await rows<TrayRow>("trays", { query: q({ select: "*", limit: "1" }) });
  return found[0] || null;
}

/** Starts the household's tray with its first items; expires 7 days from now. Returns the row, or null if one was created meanwhile. */
export async function createTray({ items, listHash = null, status = "collecting", updatedBy }: { items: TrayItem[]; listHash?: string | null; status?: TrayStatus; updatedBy?: string }): Promise<TrayRow | null> {
  const now = clock.now();
  try {
    const created = await rows<TrayRow>("trays", {
      method: "POST",
      prefer: "return=representation",
      body: { items, list_hash: listHash, status, version: 0, created_at: new Date(now).toISOString(), expires_at: new Date(now + TRAY_TTL_MS).toISOString(), updated_at: new Date(now).toISOString(), updated_by: updatedBy ?? null },
    });
    return created[0];
  } catch (err) {
    if (/ 409:/.test(errorMessage(err))) return null; // the unique index: someone else started the tray first
    throw err;
  }
}

/** What a tray write sets (the version and the times are added). */
export interface TrayPatch {
  items: TrayItem[];
  list_hash: string | null;
  status: TrayStatus;
}

/** Writes `patch` (items, list_hash, status) if the row is still at `version`; returns the new row, or null when it changed under us. */
export async function patchTray(id: string, version: number, patch: TrayPatch, updatedBy?: string): Promise<TrayRow | null> {
  const patched = await rows<TrayRow>("trays", {
    method: "PATCH",
    prefer: "return=representation",
    query: q({ id: `eq.${id}`, version: `eq.${version}` }),
    body: { ...patch, version: version + 1, updated_at: new Date(clock.now()).toISOString(), ...(updatedBy ? { updated_by: updatedBy } : {}) },
  });
  return patched[0] || null;
}

export async function deleteTrayRow(id: string) {
  await rest("trays", { method: "DELETE", query: q({ id: `eq.${id}` }) });
}

// --- Storage ----------------------------------------------------------------------------------------------------------

export interface StorageOptions {
  method?: "GET" | "POST" | "DELETE";
  /** Bytes, or with `json` an object to send as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  json?: boolean;
}

export async function storage(path: string, { method = "GET", body, headers = {}, json = false }: StorageOptions = {}): Promise<Response> {
  let res;
  try {
    res = await fetch(`${config.supabaseUrl}/storage/v1/${path}`, {
      method,
      headers: { apikey: config.supabaseServiceKey as string, Authorization: `Bearer ${config.supabaseServiceKey}`, ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json ? JSON.stringify(body) : (body as BodyInit | undefined),
    });
  } catch (err) {
    throw new StoreError(`Supabase Storage unreachable: ${errorMessage(err)}`);
  }
  return res;
}

export const objectPath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** Stores (or replaces) a staged photo. `path` is "<tray id>/<slug>.jpg". */
export async function uploadPhoto(path: string, bytes: Buffer) {
  const res = await storage(`object/${PHOTO_BUCKET}/${objectPath(path)}`, { method: "POST", body: bytes, headers: { "Content-Type": "image/jpeg", "x-upsert": "true", "Cache-Control": "max-age=60" } });
  if (!res.ok) throw new StoreError(`Storage upload answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/** The staged photo's bytes, or null when it isn't there. */
export async function downloadPhoto(path: string): Promise<Buffer | null> {
  const res = await storage(`object/${PHOTO_BUCKET}/${objectPath(path)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new StoreError(`Storage download answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Deletes staged photos (best effort per call: a missing one is not an error). */
export async function removePhotos(paths: (string | null | undefined)[]) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return;
  const res = await storage(`object/${PHOTO_BUCKET}`, { method: "DELETE", json: true, body: { prefixes: list } });
  if (!res.ok) throw new StoreError(`Storage delete answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/** Deletes everything under a tray's folder (the tray was saved, expired or emptied). */
export async function removeTrayPhotos(trayId: string) {
  const res = await storage(`object/list/${PHOTO_BUCKET}`, { method: "POST", json: true, body: { prefix: trayId, limit: 200 } });
  if (!res.ok) throw new StoreError(`Storage list answered ${res.status}`);
  const names = ((await res.json()) as { name: string }[]).map((o) => `${trayId}/${o.name}`);
  await removePhotos(names);
}

/** A signed URL (valid SIGNED_URL_SECONDS) the editor's browser can show the staged photo with, or null. */
export async function signedPhotoUrl(path: string, seconds = SIGNED_URL_SECONDS): Promise<string | null> {
  const res = await storage(`object/sign/${PHOTO_BUCKET}/${objectPath(path)}`, { method: "POST", json: true, body: { expiresIn: seconds } });
  if (!res.ok) return null;
  const { signedURL } = (await res.json()) as { signedURL?: string };
  return signedURL ? `${config.supabaseUrl}/storage/v1${signedURL.startsWith("/") ? "" : "/"}${signedURL}` : null;
}
