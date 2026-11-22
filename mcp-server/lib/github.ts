import { config } from "./config.ts";
import { clearCache, registerClear } from "./cache.ts";
import { errorStatus } from "./errors.ts";
import type { Caller } from "./types/common.ts";

// The ONLY paths this server is ever allowed to write or delete. Everything
// else in the repo (including this server's own code, build.js, templates,
// workflows) is off limits. Every commit goes through assertAllowedPath.
const ALLOWED_PATHS = [
  /^recipes\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
  /^images\/recipes\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|jpeg|png|webp)$/,
  /^shopping-list\.json$/,
  /^data\/ingredients\.json$/,
];

export function isAllowedPath(path: string) {
  return ALLOWED_PATHS.some((re) => re.test(path));
}

export function assertAllowedPath(path: string) {
  if (!isAllowedPath(path)) {
    throw new Error(`Refusing to write "${path}": only recipes/<slug>.md, images/recipes/<slug>.<ext>, shopping-list.json and data/ingredients.json may be changed`);
  }
}

/**
 * Defence in depth (docs/chatbot-design.md 4.1 layer 3): everything that commits takes the caller and
 * checks the role itself, so a code path that skips the tool dispatcher still can't write for a public caller.
 */
export function assertCanCommit(caller: Caller | null | undefined) {
  if (!caller || (caller.role !== "editor" && caller.role !== "agent")) {
    console.warn(`Refused a commit: caller role "${caller?.role ?? "none"}" may not write`);
    throw new Error("Refusing to commit: only an editor or the MCP agent may change the site");
  }
}

const API = "https://api.github.com";

/** A failed GitHub call: the status is what the commit retry (422: someone pushed first) looks at. */
export class GitHubError extends Error {
  declare status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The parts of GitHub's JSON this server reads (https://docs.github.com/en/rest/git).
interface GitRef {
  object: { sha: string };
}
interface GitCommit {
  sha: string;
  html_url: string;
  tree: { sha: string };
}
interface GitSha {
  sha: string;
}
interface ContentEntry {
  type: string;
  name: string;
}
/** One entry of a tree being created: a blob to write, or `sha: null` to delete the path. */
interface TreeBlob {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

/** A change to commit: a file's new content, or `delete: true`. */
export type FileChange = { path: string; content: Buffer } | { path: string; delete: true };
/** What a commit resolves: its SHA and page. */
export interface CommitResult {
  sha: string;
  url: string;
}
/** What was read from the branch, kept per head SHA: path -> Promise<Buffer | null>, "dir:<path>" -> Promise<names>. */
export type ReadCache = Map<string, Promise<unknown>>;
/** The branch at one head SHA, for dry runs. */
export interface BranchSnapshot {
  sha: string;
  reads: ReadCache;
}

interface GhOptions {
  accept?: string;
  allow404?: boolean;
}
async function gh(method: string, path: string, body?: unknown, opts?: GhOptions & { allow404?: false }): Promise<Response>;
async function gh(method: string, path: string, body: unknown, opts: GhOptions & { allow404: true }): Promise<Response | null>;
async function gh(method: string, path: string, body?: unknown, { accept = "application/vnd.github+json", allow404 = false }: GhOptions = {}): Promise<Response | null> {
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
    throw new GitHubError(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  }
  return res;
}

/** Returns file contents as a Buffer, or null if it doesn't exist on the branch. */
export async function readFile(path: string, ref: string = config.branch): Promise<Buffer | null> {
  const res = await gh("GET", `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, null, {
    accept: "application/vnd.github.raw+json",
    allow404: true,
  });
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}

/** Lists file names in a directory on the branch. */
export async function listDir(path: string, ref: string = config.branch): Promise<string[]> {
  const res = await gh("GET", `/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, null, { allow404: true });
  if (!res) return [];
  const entries = (await res.json()) as ContentEntry[];
  return entries.filter((e) => e.type === "file").map((e) => e.name);
}

// A snapshot of the branch for dry runs (the plan tray's staging and view): ONE ref read per call, and everything read from the branch is
// kept per head SHA (and pinned to that SHA), so however many replays and polls happen, GitHub is read once per branch state, not once
// per recipe per replay. Cleared on our own commits. Save, clash detection and the commit never use it: they read fresh.
let snapshot: BranchSnapshot | null = null;
export async function branchSnapshot(): Promise<BranchSnapshot> {
  const ref = (await (await gh("GET", `/git/ref/heads/${config.branch}`)).json()) as GitRef;
  const sha = ref.object.sha;
  if (!snapshot || snapshot.sha !== sha) snapshot = { sha, reads: new Map() };
  return snapshot;
}
export const clearSnapshot = () => {
  snapshot = null;
};
registerClear(clearSnapshot);

/**
 * Creates one commit on the branch containing all the given changes.
 * changes: [{ path, content: Buffer }] to write, or [{ path, delete: true }] to remove.
 * Uses the Git Data API so a recipe + its image land atomically in one commit.
 */
export async function commitChanges(changes: FileChange[], message: string, caller: Caller | null | undefined): Promise<CommitResult> {
  assertCanCommit(caller);
  if (!changes.length) throw new Error("Nothing to commit");
  for (const c of changes) assertAllowedPath(c.path);

  const blobs: TreeBlob[] = await Promise.all(
    changes.map(async (c): Promise<TreeBlob> => {
      if ("delete" in c) return { path: c.path, mode: "100644", type: "blob", sha: null };
      const res = await gh("POST", "/git/blobs", { content: c.content.toString("base64"), encoding: "base64" });
      const { sha } = (await res.json()) as GitSha;
      return { path: c.path, mode: "100644", type: "blob", sha };
    })
  );

  // Retry if someone else pushed to the branch between our read and our ref update.
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = (await (await gh("GET", `/git/ref/heads/${config.branch}`)).json()) as GitRef;
    const parentSha = ref.object.sha;
    const parent = (await (await gh("GET", `/git/commits/${parentSha}`)).json()) as GitCommit;

    const tree = (await (await gh("POST", "/git/trees", { base_tree: parent.tree.sha, tree: blobs })).json()) as GitSha;
    const commit = (await (
      await gh("POST", "/git/commits", {
        message,
        tree: tree.sha,
        parents: [parentSha],
        author: { name: "Recipes MCP", email: "recipes-mcp@users.noreply.github.com" },
      })
    ).json()) as GitCommit;

    try {
      await gh("PATCH", `/git/refs/heads/${config.branch}`, { sha: commit.sha, force: false });
      clearSnapshot();
      clearCache(); // the cached recipe index no longer matches the branch
      return { sha: commit.sha, url: commit.html_url };
    } catch (err) {
      if (errorStatus(err) !== 422 || attempt === 3) throw err;
    }
  }
  throw new Error("unreachable: the last attempt returns or throws");
}

/**
 * Staged edits on top of the branch: reads see the staged version first, and nothing reaches
 * GitHub until commit(). Lets several tool operations land in one commit (= one site deploy).
 */
export class ChangeSet {
  declare staged: Map<string, Buffer | null>;
  declare reads: ReadCache | null;
  declare ref: string;
  /**
   * `reads` (optional): a Map shared between ChangeSets that caches what was read from the branch (path -> Promise<Buffer | null>, and
   * "dir:<path>" -> Promise<names>), so a dry run that replays the plan tray several times doesn't read every recipe from GitHub each time.
   * Only for short-lived, throwaway sets that never commit.
   */
  constructor({ reads, ref }: { reads?: ReadCache | null; ref?: string } = {}) {
    this.staged = new Map(); // path -> Buffer, or null for a deletion
    this.reads = reads || null;
    this.ref = ref || config.branch; // with `reads` from branchSnapshot(): the head SHA those reads are pinned to
  }

  /** The staged edits as they are now, to put back with restore() if an operation fails half way. */
  snapshot(): Map<string, Buffer | null> {
    return new Map(this.staged);
  }

  restore(snapshot: Map<string, Buffer | null>) {
    this.staged = new Map(snapshot);
  }

  #fromBranch<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.reads) return load();
    if (!this.reads.has(key)) {
      const p = load();
      this.reads.set(key, p);
      p.catch(() => this.reads!.get(key) === p && this.reads!.delete(key)); // never keep a failed read
    }
    return this.reads.get(key) as Promise<T>;
  }

  get size() {
    return this.staged.size;
  }

  async read(path: string): Promise<Buffer | null> {
    return this.staged.has(path) ? (this.staged.get(path) ?? null) : this.#fromBranch(path, () => readFile(path, this.ref));
  }

  async list(dir: string): Promise<string[]> {
    const names = new Set(await this.#fromBranch(`dir:${dir}`, () => listDir(dir, this.ref)));
    for (const [path, content] of this.staged) {
      if (!path.startsWith(`${dir}/`) || path.slice(dir.length + 1).includes("/")) continue;
      const name = path.slice(dir.length + 1);
      if (content === null) names.delete(name);
      else names.add(name);
    }
    return [...names];
  }

  write(path: string, content: Buffer) {
    assertAllowedPath(path);
    this.staged.set(path, content);
  }

  remove(path: string) {
    assertAllowedPath(path);
    this.staged.set(path, null);
  }

  paths() {
    return [...this.staged.keys()];
  }

  async commit(message: string, caller: Caller | null | undefined): Promise<CommitResult> {
    assertCanCommit(caller);
    const changes: FileChange[] = [];
    for (const [path, content] of this.staged) {
      if (content !== null) changes.push({ path, content });
      // A file staged and then deleted again within one batch never existed on the branch: nothing to delete.
      else if (await readFile(path)) changes.push({ path, delete: true });
    }
    return commitChanges(changes, message, caller);
  }
}
