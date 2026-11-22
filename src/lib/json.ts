/**
 * JSON for the inside of a `<script type="application/json">`: "<", ">", "&" and the two line separators are escaped, so no value
 * can close the script element or open a comment. `JSON.parse` reads it back as the original.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
