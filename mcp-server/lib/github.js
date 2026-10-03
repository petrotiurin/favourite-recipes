import { config } from "./config.js";

// The ONLY paths this server is ever allowed to write or delete. Everything
// else in the repo (including this server's own code, build.js, templates,
// workflows) is off limits. Every commit goes through assertAllowedPath.
const ALLOWED_PATHS = [
  /^recipes\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
  /^images\/recipes\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|jpeg|png|webp)$/,
  /^shopping-list\.json$/,
];

export function isAllowedPath(path) {
  return ALLOWED_PATHS.some((re) => re.test(path));
}

export function assertAllowedPath(path) {
  if (!isAllowedPath(path)) {
    throw new Error(`Refusing to write "${path}": only recipes/<slug>.md, images/recipes/<slug>.<ext> and shopping-list.json may be changed`);
  }
}

const API = "https://api.github.com";

async function gh(method, path, body, { accept = "application/vnd.github+json", allow404 = false } = {}) {
  const res = await fetch(`${API}/repos/${config.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "favourite-recipes-mcp",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Returns file contents as a Buffer, or null if it doesn't exist on the branch. */
export async function readFile(path) {
  const res = await gh("GET", `/contents/${encodeURI(path)}?ref=${config.branch}`, null, {
    accept: "application/vnd.github.raw+json",
    allow404: true,
  });
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}

/** Lists file names in a directory on the branch. */
export async function listDir(path) {
  const res = await gh("GET", `/contents/${encodeURI(path)}?ref=${config.branch}`, null, { allow404: true });
  if (!res) return [];
  const entries = await res.json();
  return entries.filter((e) => e.type === "file").map((e) => e.name);
}

/**
 * Creates one commit on the branch containing all the given changes.
 * changes: [{ path, content: Buffer }] to write, or [{ path, delete: true }] to remove.
 * Uses the Git Data API so a recipe + its image land atomically in one commit.
 */
export async function commitChanges(changes, message) {
  if (!changes.length) throw new Error("Nothing to commit");
  for (const c of changes) assertAllowedPath(c.path);

  const blobs = await Promise.all(
    changes.map(async (c) => {
      if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
      const res = await gh("POST", "/git/blobs", { content: c.content.toString("base64"), encoding: "base64" });
      const { sha } = await res.json();
      return { path: c.path, mode: "100644", type: "blob", sha };
    })
  );

  // Retry if someone else pushed to the branch between our read and our ref update.
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await (await gh("GET", `/git/ref/heads/${config.branch}`)).json();
    const parentSha = ref.object.sha;
    const parent = await (await gh("GET", `/git/commits/${parentSha}`)).json();

    const tree = await (await gh("POST", "/git/trees", { base_tree: parent.tree.sha, tree: blobs })).json();
    const commit = await (
      await gh("POST", "/git/commits", {
        message,
        tree: tree.sha,
        parents: [parentSha],
        author: { name: "Recipes MCP", email: "recipes-mcp@users.noreply.github.com" },
      })
    ).json();

    try {
      await gh("PATCH", `/git/refs/heads/${config.branch}`, { sha: commit.sha, force: false });
      return { sha: commit.sha, url: commit.html_url };
    } catch (err) {
      if (err.status !== 422 || attempt === 3) throw err;
    }
  }
}
