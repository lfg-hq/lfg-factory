/**
 * GitLab Reader
 *
 * Read-only access to a GitLab repository via the GitLab REST API (v4) — the
 * GitLab counterpart of github-reader.ts. Same function signatures so the two
 * are interchangeable behind repo-reader.ts.
 *
 * GitLab addresses a repo by URL-encoded "namespace/project" path (nested
 * groups allowed), not owner+repo path params. Auth uses the user's stored
 * GitLab OAuth token as a Bearer token.
 */

import { env } from "../config/env.ts";
import { renderRepoMap } from "./github-reader.ts";
import type { RepoTree } from "./github-reader.ts";

export { renderRepoMap };
export type { RepoTree, RepoFile } from "./github-reader.ts";

function apiBase(): string {
  return `${(env.GITLAB_BASE_URL || "https://gitlab.com").replace(/\/$/, "")}/api/v4`;
}

function glHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "User-Agent": "LFG-codebase-reader" };
}

/** GitLab project id = URL-encoded "namespace/project" path. */
function projectId(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

export async function getRefSha(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<string | null> {
  try {
    const resp = await fetch(
      `${apiBase()}/projects/${projectId(owner, repo)}/repository/commits/${encodeURIComponent(ref)}`,
      { headers: glHeaders(token) }
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

export async function getRepoInfo(
  owner: string,
  repo: string,
  token: string
): Promise<{ defaultBranch: string; private: boolean } | null> {
  const resp = await fetch(`${apiBase()}/projects/${projectId(owner, repo)}`, {
    headers: glHeaders(token),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { default_branch?: string; visibility?: string };
  return {
    defaultBranch: data.default_branch ?? "main",
    private: (data.visibility ?? "private") !== "public",
  };
}

export async function getRepoTree(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<RepoTree> {
  const id = projectId(owner, repo);
  const files: Array<{ path: string; size: number }> = [];
  let truncated = false;
  let page = 1;

  // GitLab paginates the tree (max 100/page); follow x-next-page until done.
  for (;;) {
    const resp = await fetch(
      `${apiBase()}/projects/${id}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`,
      { headers: glHeaders(token) }
    );
    if (!resp.ok) {
      if (page === 1) {
        throw new Error(
          `Failed to fetch repo tree (${resp.status}): ${(await resp.text()).slice(0, 200)}`
        );
      }
      break;
    }
    const data = (await resp.json()) as Array<{ path: string; type: string }>;
    for (const t of data) {
      if (t.type === "blob") files.push({ path: t.path, size: 0 });
    }
    const next = resp.headers.get("x-next-page");
    if (!next || data.length === 0) break;
    page = parseInt(next, 10) || page + 1;
    if (page > 60) {
      // ~6000 files — treat as truncated and let grep handle the rest.
      truncated = true;
      break;
    }
  }

  return { files, truncated, ref };
}

export async function readFile(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string,
  maxBytes = 100_000
): Promise<string | null> {
  const resp = await fetch(
    `${apiBase()}/projects/${projectId(owner, repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
    { headers: glHeaders(token) }
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

export async function searchCode(
  owner: string,
  repo: string,
  query: string,
  token: string,
  limit = 20
): Promise<string[]> {
  try {
    const resp = await fetch(
      `${apiBase()}/projects/${projectId(owner, repo)}/search?scope=blobs&search=${encodeURIComponent(query)}&per_page=${limit}`,
      { headers: glHeaders(token) }
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as Array<{ path?: string }>;
    const seen = new Set<string>();
    for (const item of data) {
      if (item.path) seen.add(item.path);
    }
    return [...seen];
  } catch {
    return [];
  }
}
