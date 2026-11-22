// A tiny in-memory cache for reads from GitHub (the recipe index behind search_recipes and the chat catalogue).
// Per serverless instance, short-lived, and cleared whenever this instance commits, so it never hides our own writes.
export const CACHE_TTL_MS = 60_000;

const entries = new Map(); // key -> { at, value }

/** Returns the cached value for key if it is younger than ttl, else runs load() (concurrent callers share one load). */
export async function cached(key: any, load: any, { ttl = CACHE_TTL_MS, now = Date.now }: any = {}) {
  const hit = entries.get(key);
  if (hit && now() - hit.at < ttl) return hit.value;
  const value = load();
  entries.set(key, { at: now(), value });
  try {
    return await value;
  } catch (err: any) {
    if (entries.get(key)?.value === value) entries.delete(key); // never cache a failure
    throw err;
  }
}

const onClear: any[] = [];
/** Other short-lived read caches (the branch snapshot in lib/github.ts) register here so one clearCache() drops them all. */
export const registerClear = (fn: any) => onClear.push(fn);

export function clearCache() {
  entries.clear();
  for (const fn of onClear) fn();
}
