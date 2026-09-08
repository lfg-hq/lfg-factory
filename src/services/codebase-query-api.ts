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
import { abortable, readingBudget, withRepositorySignal, ReadingError } from './reading-budget.ts';
import { currentSubscription } from '../ai/subscription-context.ts';
import { createPiSubscriptionModel } from '../ai/pi-subscription-model.ts';

// Each answer costs roughly two steps per hop (grep → read), so 12 is only ~6
// hops — enough for a small repo, not for a monorepo where finding "the story
// entity" means walking backend/, a module folder, then the entity file. When the
// budget runs out mid-hop the loop returns NO text (see below), so too small a
// number doesn't degrade the answer, it erases it.
const MAX_STEPS = parseInt(process.env.CODEBASE_QUERY_MAX_STEPS || "20", 10);

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
  abortSignal?: AbortSignal;
  requestCache?: Map<string, Response>;
  /** Turn-local callback, never a user-wide broadcast. */
  onProgress?: (message: string, warning?: boolean) => void;
}

export interface CodebaseQueryResult {
  answer: string;
  branch: string;
  /** Set when the loop produced no answer, explaining WHY so the caller can adapt
   *  its question instead of retrying the same one against silence. */
  incomplete?: string;
}

/** The files a read loop actually opened — useful context for "I ran out of steps". */
function filesTouched(steps: Array<{ toolCalls?: Array<{ toolName?: string; input?: unknown }> }>): string {
  const paths: string[] = [];
  for (const s of steps) {
    for (const c of s.toolCalls ?? []) {
      const input = c.input as { path?: string; query?: string; prefix?: string } | undefined;
      const v = input?.path ?? input?.query ?? input?.prefix;
      if (v && !paths.includes(v)) paths.push(v);
    }
  }
  return paths.slice(0, 6).join(", ");
}

export interface QueryStep {
  text?: string;
  toolCalls?: Array<{ toolName?: string; input?: unknown }>;
}

export function recoverCodebaseQuery(reason: unknown, partialText: string, steps: QueryStep[], branch = 'default'): CodebaseQueryResult {
  const incomplete = reason instanceof ReadingError ? `${reason.code}: ${reason.message}`
    : `Repository investigation failed: ${reason instanceof Error ? reason.message : 'unknown error'}`;
  const answer = deriveAnswer(partialText, steps, MAX_STEPS).answer;
  const touched = filesTouched(steps);
  return { answer: answer || (touched ? `Inspection was interrupted after attempting these file/search operations: ${touched}. No final conclusion was reached.` : ''), branch, incomplete };
}

/**
 * Turn a finished read loop into an answer — or into an honest reason there isn't one.
 *
 * `streamText().text` is, in the SDK's own words, "the full text generated by the LAST
 * step". A loop that runs out of steps ends ON A TOOL CALL, so that last step has no
 * text and the whole query resolves to "". Handing that to the caller as an empty
 * answer is what produced "the codebase query came back empty" — which reads as "your
 * repo has nothing" when the truth was "I ran out of budget three files in".
 */
export function deriveAnswer(
  finalText: string,
  steps: QueryStep[],
  maxSteps: number,
): { answer: string; incomplete?: string } {
  if (finalText.trim()) return { answer: finalText };

  // The model may well have said something useful in an earlier step; don't bin it.
  const fromSteps = steps.map((s) => s.text ?? "").filter((t) => t.trim()).join("\n\n").trim();
  if (fromSteps) return { answer: fromSteps };

  const usedAll = steps.length >= maxSteps;
  const looked = filesTouched(steps);
  return {
    answer: "",
    incomplete: usedAll
      ? `The read loop used all ${maxSteps} of its steps without reaching an answer` +
        `${looked ? ` (it got as far as: ${looked})` : ""}. Ask a narrower question, or name the folder/file to look in — ` +
        `e.g. "in backend/src/jira-stories, what fields does the story entity have?"`
      : `The model returned no answer for this question. Try rephrasing it, or name the folder to look in.`,
  };
}

export async function queryCodebaseInProcess(
  opts: CodebaseQueryOptions
): Promise<CodebaseQueryResult> {
  const budget = readingBudget(opts.abortSignal);
  const collected: QueryStep[] = [];
  let partialText = '';
  const progress = (message: string, warning?: boolean) => {
    if (budget.signal.aborted) return;
    budget.activity();
    opts.onProgress?.(message, warning);
  };
  try {
    return await abortable(withRepositorySignal(budget.signal, () => runCodebaseQuery({
      ...opts, abortSignal: budget.signal, onProgress: progress,
    }, collected, text => { partialText += text; }), () => progress('Fetched repository data'), opts.requestCache), budget.signal);
  } catch (error) {
    if (opts.abortSignal?.aborted) throw opts.abortSignal.reason;
    const reason = budget.signal.aborted ? budget.signal.reason : error;
    const recovered = recoverCodebaseQuery(reason, partialText, collected, opts.branch);
    opts.onProgress?.(recovered.incomplete!, true);
    return recovered;
  } finally { budget.dispose(); }
}

async function runCodebaseQuery(opts: CodebaseQueryOptions, collected: QueryStep[], onText: (text: string) => void): Promise<CodebaseQueryResult> {
  const { owner, repo, question, githubToken, modelKey, userApiKeys, allowEnvFallback, userId } = opts;
  const reader = getRepoReader(opts.provider);
  const progress = opts.onProgress ?? (() => {});
  progress("Fetching repository information");

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
  progress("Fetching repository file map");
  const { tree, repoMap } = await loadRepoMap(reader, owner, repo, ref, githubToken);
  progress("Inspecting repository files");

  const { selectedSubscriptionModel } = await import("./subscription-execution.ts");
  const inherited = currentSubscription();
  const subscription = inherited
    ? createPiSubscriptionModel('gpt-5.6-luna', inherited.getAccessToken)
    : userId ? await selectedSubscriptionModel(userId, undefined, 'gpt-5.6-luna') : null;
  const { model, modelKey: liteKey } = subscription
    ? { model: subscription, modelKey: `chatgpt/${subscription.modelId}` }
    : getLiteModel(modelKey, userApiKeys, { allowEnvFallback });
  progress(`Reading with ${subscription ? subscription.modelId : liteKey}`);
  const reads = new Map<string, Promise<string | null>>();
  const searches = new Map<string, Promise<string[]>>();

  // On-demand retrieval tools, backed by the GitHub API.
  const tools = {
    read_file: tool({
      description: "Read the full contents of a file in the repository by its path.",
      inputSchema: zodSchema(
        z.object({ path: z.string().describe("Repo-relative file path, e.g. src/index.ts") })
      ),
      execute: async ({ path }: { path: string }) => {
        progress(`Reading ${path}`);
        try {
          if (!reads.has(path)) reads.set(path, reader.readFile(owner, repo, path, ref!, githubToken, 40000));
          const content = await reads.get(path);
          if (content == null) {
            progress(`File not found: ${path}`, true);
            return { error: `File not found: ${path}` };
          }
          return { path, content };
        } catch (err) {
          progress(`Could not read ${path}`, true);
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
        progress(`Searching repository for ${query}`);
        const key = query.trim().toLowerCase();
        if (!searches.has(key)) searches.set(key, reader.searchCode(owner, repo, query, githubToken));
        const paths = await searches.get(key);
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
        progress(`Listing files in ${prefix || 'repository'}`);
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
    `Start with relevant folders and targeted reads, not a broad scan. Do not repeat failed searches. ` +
    `After inspecting useful evidence, state brief findings before investigating further so partial results survive interruption. ` +
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
    abortSignal: opts.abortSignal,
    onStepFinish: step => { collected.push(step as QueryStep); },
    ...(providerOptions ? { providerOptions } : {}),
  });

  try {
    // Stream assistant text to the user as it arrives (mirrors the old CLI UX).
    {
      let lastModelProgress = 0;
      for await (const event of result.fullStream) {
        if (event.type === "error") throw event.error;
        if (event.type === "text-delta") onText(event.text);
        if ((event.type === "reasoning-delta" || event.type === "text-delta") && Date.now() - lastModelProgress >= 5000) {
          progress(event.type === "text-delta" ? "Preparing codebase answer" : "Analysing repository");
          lastModelProgress = Date.now();
        }
        if (event.type === "text-delta") {
          const text = (event as any).text ?? (event as any).textDelta ?? "";
          if (text && userId) broadcastToUser(userId, { type: "codebase_query_chunk", text });
        }
      }
    }

    // `result.text` is "the full text generated by the LAST step" (the SDK's own
    // words). When the loop ends on a TOOL CALL — which is exactly what happens
    // when it runs out of steps mid-investigation — that last step has no text and
    // this comes back EMPTY. The caller then reports "the codebase query came back
    // empty", which reads like "your repo has nothing in it" rather than "I ran out
    // of budget three files in". So: fall back to whatever the model said in
    // earlier steps, and if there is genuinely nothing, say WHY.
    const steps = (await Promise.resolve(result.steps).catch(() => [])) as QueryStep[];
    const derived = deriveAnswer(await result.text, steps, MAX_STEPS);
    progress(derived.incomplete ? "Repository scan ended without an answer" : "Repository scan finished", !!derived.incomplete);

    if (userId) {
      broadcastToUser(userId, { type: "codebase_query_status", status: "complete" });
    }

    return { answer: derived.answer, branch: ref, ...(derived.incomplete ? { incomplete: derived.incomplete } : {}) };
  } catch (err) {
    if (userId) {
      broadcastToUser(userId, { type: "codebase_query_status", status: "complete" });
    }
    throw err;
  }
}
