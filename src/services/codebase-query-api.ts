/**
 * In-process codebase query (no sandbox).
 *
 * Answers questions about a repo by running a small agentic loop directly in
 * the Node process: the model gets a compact repo map up front, then reads
 * files / greps on demand via the GitHub API (see github-reader.ts). No Mags
 * VM, no `git clone`, and — unlike the Claude Code CLI path — it works with
 * ANY provider through the AI SDK.
 *
 * Cost control:
 *  - Runs on the provider's LITE model with reasoning dialed down (navigating a
 *    codebase doesn't need deep chain-of-thought; low effort is faster/cheaper).
 *  - The repo map lives in the SYSTEM prompt so it's a stable, cacheable prefix
 *    reused across questions (Anthropic explicit breakpoints; automatic else).
 *  - The repo map is cached per-repo keyed on the current commit SHA, so it's
 *    only rebuilt when the branch actually changes.
 */

import { streamText, stepCountIs, tool, zodSchema } from "ai";
import { z } from "zod";
import { getLiteModel, getProviderName, type ProviderName } from "../ai/provider.ts";
import { withCaching } from "../ai/prompt-cache.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { getRepoReader, type RepoReader, type RepoTree } from "./repo-reader.ts";
import type { UserApiKeys } from "../ai/provider.ts";

const MAX_STEPS = 12;
const QUERY_TIMEOUT_MS = 180_000; // 3 min ceiling for the whole read loop

// ── Repo-map cache (per process) ──────────────────────────────────────
// Keyed by owner/repo@ref → { sha, tree, repoMap }. A cheap getRefSha() call
// decides whether the cached map is still current; only a changed SHA triggers
// a full (recursive) tree rebuild. Cleared on restart — upgrade to a DB table
// if cross-restart persistence is needed.
interface RepoMapEntry {
  sha: string;
  tree: RepoTree;
  repoMap: string;
}
const repoMapCache = new Map<string, RepoMapEntry>();

async function loadRepoMap(
  reader: RepoReader,
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<{ tree: RepoTree; repoMap: string }> {
  const key = `${owner}/${repo}@${ref}`;
  const sha = await reader.getRefSha(owner, repo, ref, token);
  const cached = repoMapCache.get(key);
  if (cached && sha && cached.sha === sha) {
    return { tree: cached.tree, repoMap: cached.repoMap };
  }
  const tree = await reader.getRepoTree(owner, repo, ref, token);
  const repoMap = reader.renderRepoMap(tree);
  if (sha) repoMapCache.set(key, { sha, tree, repoMap });
  return { tree, repoMap };
}

// Dial reasoning down for the read loop — enough to navigate, not so much it's
// slow/expensive. Only providers with a supported knob are set; others no-op.
function lowReasoningOptions(provider: ProviderName | null): Record<string, any> | undefined {
  switch (provider) {
    case "openai":
      return { openai: { reasoningEffort: "low" } };
    case "google":
      return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    default:
      return undefined;
  }
}

export interface CodebaseQueryOptions {
  owner: string;
  repo: string;
  question: string;
  /** The user's OAuth token for the repo's provider (GitHub or GitLab). */
  githubToken: string;
  /** "github" (default) or "gitlab" — selects which API/reader to use. */
  provider?: string;
  modelKey: string;
  userApiKeys?: UserApiKeys;
  allowEnvFallback?: boolean;
  branch?: string;
  /** When set, assistant text + status are streamed to this user over WS. */
  userId?: string;
}

export interface CodebaseQueryResult {
  answer: string;
  branch: string;
}

export async function queryCodebaseInProcess(
  opts: CodebaseQueryOptions
): Promise<CodebaseQueryResult> {
  const { owner, repo, question, githubToken, modelKey, userApiKeys, allowEnvFallback, userId } = opts;
  const reader = getRepoReader(opts.provider);

  // Resolve the ref: explicit branch, else the repo's default branch.
  let ref = opts.branch;
  if (!ref) {
    const info = await reader.getRepoInfo(owner, repo, githubToken);
    ref = info?.defaultBranch ?? "main";
  }

  if (userId) {
    broadcastToUser(userId, {
      type: "codebase_query_status",
      status: "searching",
      message: "Reading codebase…",
    });
  }

  // Build (or reuse, when the commit SHA is unchanged) the repo map.
  const { tree, repoMap } = await loadRepoMap(reader, owner, repo, ref, githubToken);

  const { model, modelKey: liteKey } = getLiteModel(modelKey, userApiKeys, { allowEnvFallback });

  // On-demand retrieval tools, backed by the GitHub API.
  const tools = {
    read_file: tool({
      description: "Read the full contents of a file in the repository by its path.",
      inputSchema: zodSchema(
        z.object({ path: z.string().describe("Repo-relative file path, e.g. src/index.ts") })
      ),
      execute: async ({ path }: { path: string }) => {
        try {
          const content = await reader.readFile(owner, repo, path, ref!, githubToken);
          if (content == null) return { error: `File not found: ${path}` };
          return { path, content };
        } catch (err) {
          return { error: `Failed to read ${path}: ${(err as Error).message}` };
        }
      },
    }),
    grep: tool({
      description:
        "Search the repository for a keyword/symbol and return matching file paths. " +
        "Use when a file isn't visible in the repo map or to locate where something is defined/used.",
      inputSchema: zodSchema(
        z.object({ query: z.string().describe("Keyword, symbol, or short phrase to search for") })
      ),
      execute: async ({ query }: { query: string }) => {
        const paths = await reader.searchCode(owner, repo, query, githubToken);
        return { query, matches: paths };
      },
    }),
    list_files: tool({
      description:
        "List repository file paths, optionally filtered by a path prefix (e.g. 'src/services'). " +
        "Useful for large repos where the initial map was truncated.",
      inputSchema: zodSchema(
        z.object({ prefix: z.string().optional().describe("Path prefix filter") })
      ),
      execute: async ({ prefix }: { prefix?: string }) => {
        const paths = tree.files
          .map((f) => f.path)
          .filter((p) => (prefix ? p.startsWith(prefix) : true))
          .slice(0, 500);
        return { count: paths.length, paths };
      },
    }),
  };

  // The repo map goes in the SYSTEM prompt (not the user message) so the whole
  // stable prefix — instructions + map + tools — is cached and reused across
  // every question about this repo; only the question varies per turn.
  const system =
    `You are a codebase analysis assistant answering questions about the ` +
    `${opts.provider === "gitlab" ? "GitLab" : "GitHub"} repository ` +
    `${owner}/${repo} (branch: ${ref}).\n\n` +
    `Use the read_file, grep, and list_files tools to inspect only the files you actually ` +
    `need — do not guess. Answer the user's question precisely and concisely, citing exact ` +
    `file paths (and line references where helpful). If the answer isn't in the code, say so.\n\n` +
    `--- Repository file map ---\n${repoMap}`;

  const cached = withCaching(liteKey, {
    system,
    messages: [{ role: "user", content: question }],
  });

  const providerOptions = lowReasoningOptions(getProviderName(liteKey));

  // Bound the whole read loop so a stuck model turn can't hang forever. The
  // provider fetch no longer imposes Bun's default timeout (see llmFetch), so
  // this abortSignal is the single, explicit ceiling.
  const result = streamText({
    model,
    system: cached.system,
    messages: cached.messages as any,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    ...(providerOptions ? { providerOptions } : {}),
  });

  try {
    // Stream assistant text to the user as it arrives (mirrors the old CLI UX).
    if (userId) {
      for await (const event of result.fullStream) {
        if (event.type === "text-delta") {
          const text = (event as any).text ?? (event as any).textDelta ?? "";
          if (text) broadcastToUser(userId, { type: "codebase_query_chunk", text });
        }
      }
    }

    const answer = await result.text;

    if (userId) {
      broadcastToUser(userId, { type: "codebase_query_status", status: "complete" });
    }

    return { answer, branch: ref };
  } catch (err) {
    if (userId) {
      broadcastToUser(userId, { type: "codebase_query_status", status: "complete" });
    }
    const aborted =
      (err as any)?.name === "TimeoutError" || (err as any)?.name === "AbortError";
    if (aborted) {
      throw new Error(
        `Codebase query timed out after ${Math.round(QUERY_TIMEOUT_MS / 1000)}s. The model took too long — try a faster model or a more specific question.`
      );
    }
    throw err;
  }
}
