/**
 * GitHub Reader
 *
 * Read-only access to a repository via the GitHub REST API — no clone, no VM.
 * Backs the in-process codebase-query agent (see codebase-query-api.ts):
 *  - getRepoInfo   → default branch
 *  - getRepoTree   → full file list (one call), used to build a repo map
 *  - readFile      → raw file contents on demand
 *  - searchCode    → keyword search (grep-equivalent) over the default branch
 *
 * All calls authenticate with the user's stored GitHub OAuth token.
 */

const API = "https://api.github.com";

function ghHeaders(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "LFG-codebase-reader",
  };
}

export interface RepoFile {
  path: string;
  size: number;
}

export interface RepoTree {
  /** blob (file) entries only — directories are omitted */
  files: RepoFile[];
  /** GitHub truncates trees for very large repos; grep is the fallback then */
  truncated: boolean;
  ref: string;
}

/**
 * Get the current commit SHA for a ref (branch/tag/sha) — a tiny request used
 * to cheaply detect whether a cached repo map is still current. Uses the
 * `.sha` media type so the response is just the SHA string, not the commit.
 * Returns null on error (caller falls back to rebuilding).
 */
export async function getRefSha(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<string | null> {
  try {
    const resp = await fetch(
      `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      { headers: ghHeaders(token, "application/vnd.github.sha") }
    );
    if (!resp.ok) return null;
    return (await resp.text()).trim() || null;
  } catch {
    return null;
  }
}

/** Resolve repo metadata; primarily used to find the default branch. */
export async function getRepoInfo(
  owner: string,
  repo: string,
  token: string
): Promise<{ defaultBranch: string; private: boolean } | null> {
  const resp = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { default_branch: string; private: boolean };
  return { defaultBranch: data.default_branch, private: data.private };
}

/**
 * Fetch the full file tree for a ref (branch/tag/sha) in a single call.
 * Returns blob entries with sizes; directories and submodules are dropped.
 */
export async function getRepoTree(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<RepoTree> {
  const resp = await fetch(
    `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: ghHeaders(token) }
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch repo tree (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    tree: Array<{ path: string; type: string; size?: number }>;
    truncated: boolean;
  };
  const files = data.tree
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, size: t.size ?? 0 }));
  return { files, truncated: !!data.truncated, ref };
}

/** Read a single file's raw text. Returns null if missing. `maxBytes` caps output. */
export async function readFile(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string,
  maxBytes = 100_000
): Promise<string | null> {
  const resp = await fetch(
    `${API}/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
    { headers: ghHeaders(token, "application/vnd.github.raw+json") }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Failed to read ${path} (${resp.status})`);
  }
  const text = await resp.text();
  return text.length > maxBytes
    ? text.slice(0, maxBytes) + `\n… [truncated at ${maxBytes} bytes]`
    : text;
}

/**
 * Keyword search across the repo (default branch only — a GitHub code-search
 * limitation). Returns matching file paths. Best-effort: returns [] on error.
 */
export async function searchCode(
  owner: string,
  repo: string,
  query: string,
  token: string,
  limit = 20
): Promise<string[]> {
  const q = `${query} repo:${owner}/${repo}`;
  const resp = await fetch(
    `${API}/search/code?q=${encodeURIComponent(q)}&per_page=${limit}`,
    { headers: ghHeaders(token, "application/vnd.github.text-match+json") }
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as { items?: Array<{ path: string }> };
  return (data.items ?? []).map((i) => i.path);
}

/**
 * Render a compact repo map from a tree: a plain path listing grouped by
 * directory. This becomes the stable, cacheable prefix the model reasons over
 * before deciding which files to actually read.
 */
export function renderRepoMap(tree: RepoTree, maxFiles = 1500): string {
  const files = tree.files;
  const shown = files.slice(0, maxFiles);
  const lines = shown.map((f) => f.path);
  let out = lines.join("\n");
  if (files.length > maxFiles) {
    out += `\n… ${files.length - maxFiles} more files not shown (use grep to find them)`;
  }
  if (tree.truncated) {
    out += `\n[repo tree was truncated by GitHub — grep to locate files not listed]`;
  }
  return out;
}
