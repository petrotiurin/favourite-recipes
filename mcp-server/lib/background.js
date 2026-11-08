// Work that carries on after the response has gone (staged photos): handed to Vercel's waitUntil so the function stays alive for it,
// and tracked here so tests (and the dev harness) can wait for it. Never throws.
const pending = new Set();
let waitUntilFn;

async function loadWaitUntil() {
  if (waitUntilFn !== undefined) return waitUntilFn;
  try {
    waitUntilFn = (await import("@vercel/functions")).waitUntil;
  } catch {
    waitUntilFn = null;
  }
  return waitUntilFn;
}

/** Starts `promise` (or the result of calling `fn`) in the background. Errors are logged, not thrown. */
export function background(job) {
  const promise = (typeof job === "function" ? Promise.resolve().then(job) : Promise.resolve(job)).catch((err) => console.error("Background job failed:", err?.message || err));
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  loadWaitUntil().then((waitUntil) => waitUntil?.(promise)).catch(() => {});
  return promise;
}

/** Resolves when every background job started so far (and any they started) has finished. */
export async function backgroundIdle() {
  while (pending.size) await Promise.allSettled([...pending]);
}
