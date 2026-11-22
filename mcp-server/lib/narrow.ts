// Small helpers for reading untrusted JSON (a model's answer, an API's body, a fetched page's JSON-LD) without trusting its shape.

/** The value as a plain object (not an array), or undefined: the first step of reading a key out of `unknown`. */
export const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** A list as JSON-LD and models give it: an array stays, a truthy single value becomes a one-item list, anything falsy is no items. */
export const toList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);

/** True for the errors a timeout or an abort signal throws. */
export const isTimeoutError = (err: unknown): boolean => {
  const name = asRecord(err)?.name;
  return name === "TimeoutError" || name === "AbortError";
};
