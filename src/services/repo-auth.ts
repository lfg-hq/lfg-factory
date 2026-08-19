import { db } from "../config/db.ts";
import { githubTokens } from "../db/schema/users.ts";
import { eq } from "drizzle-orm";
import { getValidGitlabToken } from "./gitlab-token.ts";

/**
 * Repo provider + authenticated remote for a project.
 *
 * Extracted from ticket-executor so non-worker code (epics, promotion to main)
 * can resolve the same credentials without importing the worker — which would
 * be circular, since the worker now depends on the epic service.
 */
export interface RepoAuth {
  provider: "github" | "gitlab";
  owner: string;
  repo: string;
  repoUrl: string; // https, no creds, ends .git
  authUrl: string; // https with embedded credential
  token: string;
  tokenUser: string; // "x-access-token" (GitHub) | "oauth2" (GitLab)
}

export interface RepoProject {
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  repoProvider?: string | null;
  stack?: string | null;
}

export function extractRepoUrl(stack: string): string | null {
  const match = stack.match(/https?:\/\/[^\s]+\.git|https?:\/\/github\.com\/[^\s]+/);
  return match?.[0] ?? null;
}

/**
 * Resolve the project's repo provider + a correctly-authenticated remote URL.
 * Supports BOTH GitHub (x-access-token) and GitLab (oauth2). Provider is inferred
 * from the repo URL host (dual-provider apps), falling back to repoProvider.
 * Returns null if there's no connected repo or no valid token for its provider.
 */
export async function resolveRepoAuth(
  project: RepoProject,
  ownerId: string,
): Promise<RepoAuth | null> {
  const columnProvider = (project.repoProvider || "github").toLowerCase();
  let repoUrl = (project.repoUrl || extractRepoUrl(project.stack ?? "") || "").trim();
  let owner = project.repoOwner ?? "";
  let repo = project.repoName ?? "";
  if ((!owner || !repo) && repoUrl) {
    const m = repoUrl.match(/(?:github|gitlab)\.com[:/]+([^/]+)\/([^/.]+)/i);
    if (m) { owner = owner || m[1]!; repo = repo || m[2]!; }
  }
  const provider: "github" | "gitlab" = /gitlab\.com|\/gitlab\b/i.test(repoUrl) ? "gitlab"
    : /github\.com/i.test(repoUrl) ? "github" : (columnProvider === "gitlab" ? "gitlab" : "github");
  const host = provider === "gitlab" ? "gitlab.com" : "github.com";
  if (!repoUrl && owner && repo) repoUrl = `https://${host}/${owner}/${repo}.git`;
  if (!repoUrl || !owner || !repo) return null;
  repoUrl = repoUrl.replace(/^git@([^:]+):/, "https://$1/").replace(/\/+$/, "").replace(/\.git$/, "") + ".git";
  const token = provider === "gitlab"
    ? (await getValidGitlabToken(ownerId)) || ""
    : (await db.select().from(githubTokens).where(eq(githubTokens.userId, ownerId)).limit(1))[0]?.accessToken || "";
  if (!token) return null;
  const tokenUser = provider === "gitlab" ? "oauth2" : "x-access-token";
  return { provider, owner, repo, repoUrl, authUrl: repoUrl.replace("https://", `https://${tokenUser}:${token}@`), token, tokenUser };
}
