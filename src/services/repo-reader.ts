/**
 * Repo reader dispatcher — returns the GitHub or GitLab reader based on the
 * project's repo provider. Both modules export the same function signatures.
 */
import * as githubReader from "./github-reader.ts";
import * as gitlabReader from "./gitlab-reader.ts";
import type { RepoTree, RepoFile } from "./github-reader.ts";

export type { RepoTree, RepoFile };

export interface RepoReader {
  getRefSha(owner: string, repo: string, ref: string, token: string): Promise<string | null>;
  getRepoInfo(
    owner: string,
    repo: string,
    token: string
  ): Promise<{ defaultBranch: string; private: boolean } | null>;
  getRepoTree(owner: string, repo: string, ref: string, token: string): Promise<RepoTree>;
  readFile(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    token: string,
    maxBytes?: number
  ): Promise<string | null>;
  searchCode(
    owner: string,
    repo: string,
    query: string,
    token: string,
    limit?: number
  ): Promise<string[]>;
  renderRepoMap(tree: RepoTree, maxFiles?: number): string;
}

export function getRepoReader(provider: string | null | undefined): RepoReader {
  return provider === "gitlab" ? (gitlabReader as RepoReader) : (githubReader as RepoReader);
}
