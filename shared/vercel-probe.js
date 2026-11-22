// TEMPORARY (docs/typescript-migration.md 5.1): checks whether the Vercel build of mcp-server/ can import files outside its root
// directory. Delete together with mcp-server/api/probe.js once the answer is in.
export const probe = "shared/ reached from mcp-server";
