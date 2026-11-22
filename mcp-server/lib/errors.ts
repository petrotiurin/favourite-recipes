// Errors as `unknown`: what a `catch (err)` has. Never `any`, so a thrown string or a bare object is handled, not trusted to have a `.message`.

/** The message of whatever was thrown: an Error's, an object's `message`, else the value as text. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** The HTTP status an error carries (a GitHubError's, a StocktakeError's), or undefined. */
export function errorStatus(err: unknown): number | undefined {
  const status = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}
