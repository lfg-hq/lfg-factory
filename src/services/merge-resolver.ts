/**
 * Merge a ticket branch into its epic branch by handing the job to the SAME coding CLI
 * that built the ticket (Pi, or Claude Code) — running in the same sandbox, with the
 * same shell, on the same checkout.
 *
 * This file used to drive git itself: recreate the conflict, feed the agent a
 * file-editing tool, whitelist which paths it was allowed to touch, cap it at 20 files
 * and 24 steps, then judge the result. That scaffolding is what actually failed. A merge
 * blocked by a shallow clone ("refusing to merge unrelated histories") died inside a
 * 24-step budget spent reading conflict hunks — a problem any competent agent solves with
 * one `git fetch --unshallow`, if you let it run git and give it room.
 *
 * So: clear instructions, a real shell, no step cap. We keep exactly two things, because
 * neither is cleverness — credentials (the agent can't push without them) and the verdict
 * (the agent doesn't get to declare success; we check the remote).
 */
import { eq, and } from "drizzle-orm";
import { execOnWorkspace } from "./mags.ts";
import { db } from "../config/db.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys, profiles, applicationState } from "../db/schema/users.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { projectEnvironmentVariables } from "../db/schema/projects.ts";
import { decrypt } from "../ai/tools/env-tools.ts";
import { getProviderName, getProviderModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { startPiCli, streamPiToCompletion, isPiSupportedProvider, extractPiProgress } from "./pi-cli.ts";
import {
  startClaudeCli, pollOutput, parseJsonlEvents, isStreamComplete, extractExitCode,
} from "./claude-cli.ts";
import { getOpenAICodexAccessToken } from "./openai-codex-auth.ts";

export interface AgentMergeResult {
  merged: boolean;
  /** Target-branch sha on the REMOTE once the merge has actually landed. */
  sha?: string;
  /** The agent's own account: what was wrong, and what it did about it. */
  summary: string;
}

const MERGE_TIMEOUT_MS = 20 * 60_000;

/** The line that actually explains a git failure, for the log and the agent's prompt. */
export function gitFailureReason(error: string): string {
  const fatal = error.match(/fatal:[^\n]*/i)?.[0]
    ?? error.match(/error:[^\n]*/i)?.[0]
    ?? error.match(/CONFLICT[^\n]*/)?.[0];
  return (fatal ?? error.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 300);
}

/** Plain-English cause for the reasons we've actually seen bite, so the log says WHY. */
export function explainGitFailure(error: string): string {
  const r = gitFailureReason(error);
  if (/refusing to merge unrelated histories/i.test(error)) {
    return `${r} — this checkout is a shallow clone (cloned with --depth 1), so the commit both branches descend from was never downloaded. Git can't find a common ancestor it doesn't have. Unshallowing the repo fixes it.`;
  }
  if (/local changes.*would be overwritten|Your local changes/i.test(error)) {
    return `${r} — the sandbox checkout has uncommitted edits (preview setup rewrites config files on every run) and git won't switch branches over them.`;
  }
  if (/couldn't find remote ref|no such ref|unknown revision/i.test(error)) {
    return `${r} — the branch isn't on the remote, or wasn't fetched into this checkout.`;
  }
  if (/Authentication failed|could not read Username|403|401/i.test(error)) {
    return `${r} — the git credentials for this repo were rejected.`;
  }
  return r;
}

/** Which CLI to drive, resolved exactly the way the ticket builder resolves it. */
async function resolveCli(userId: string) {
  const [appState] = await db.select({ k: applicationState.builderModelKey, mode: applicationState.builderAuthMode })
    .from(applicationState).where(eq(applicationState.userId, userId)).limit(1);
  const LEGACY = "claude_4.5_sonnet";
  let modelKey = appState?.k && appState.k !== LEGACY ? appState.k : "";
  if (!modelKey) {
    const [sel] = await db.select({ m: modelSelections.selectedModel })
      .from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
    modelKey = sel?.m || DEFAULT_MODEL_KEY;
  }
  const provider = getProviderName(modelKey);
  const authMode = appState?.mode === "api_key" ? "api_key" : "subscription";
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, userId)).limit(1);
  const apiKey = provider
    ? ({
        anthropic: keys?.anthropicApiKey, openai: keys?.openaiApiKey, google: keys?.googleApiKey,
        kimi: keys?.kimiApiKey, deepseek: keys?.deepseekApiKey, glm: keys?.glmApiKey,
      } as Record<string, string | null | undefined>)[provider] ?? undefined
    : undefined;
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  const usesCodex = authMode === "subscription" && provider === "openai"
    && !!profile?.openaiCodexAuthenticated && !!profile.openaiCodexCredentials;
  // Minting the subscription token can fail (expired refresh token, auth workspace down).
  // Keep the REASON — swallowing it is how "Pi could not start: an API key or OAuth access
  // token is required" happened with a perfectly good API key sitting in the row.
  let credentialNote = "";
  const oauthAccessToken = usesCodex
    ? await getOpenAICodexAccessToken(userId).catch((e: Error) => {
        credentialNote = `OpenAI Codex subscription token unavailable (${e.message?.slice(0, 120)})`;
        return undefined;
      })
    : undefined;
  // ONE credential decision, and usePi is derived from IT — not from a key we then blank.
  // The old order asked "is there a key?" and passed "the key, unless Codex is connected",
  // which sent Pi nothing whenever the Codex token couldn't be minted.
  const piApiKey = oauthAccessToken ? undefined : apiKey;
  if (credentialNote && piApiKey) credentialNote += " — falling back to the stored API key";
  const usePi = !!provider && provider !== "anthropic" && isPiSupportedProvider(provider)
    && !!(piApiKey || oauthAccessToken);
  const claudeUsable = provider === "anthropic"
    && (!!keys?.anthropicApiKey || (!!profile?.claudeCodeAuthenticated && !!profile.claudeCodeCredentials));
  return {
    modelKey, provider, apiKey: piApiKey, oauthAccessToken, usePi, claudeUsable, credentialNote,
    anthropicApiKey: provider === "anthropic" && authMode === "api_key" ? keys?.anthropicApiKey ?? undefined : undefined,
    piModelId: getProviderModel(modelKey) ?? modelKey,
  };
}

async function projectEnv(projectId: string): Promise<Record<string, string>> {
  try {
    const rows = await db.select({ key: projectEnvironmentVariables.key, v: projectEnvironmentVariables.encryptedValue })
      .from(projectEnvironmentVariables)
      .where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.hasValue, true)));
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = decrypt(r.v);
    return out;
  } catch { return {}; }
}

async function buildCmdFor(projectId: string): Promise<string | undefined> {
  try {
    const [env] = await db.select({ m: projectEnvironments.setupManifest })
      .from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId)).limit(1);
    return env?.m ? (JSON.parse(env.m) as { buildCmd?: string }).buildCmd : undefined;
  } catch { return undefined; }
}

/**
 * Merge `featureBranch` into `targetBranch` and push, using the coding CLI in the
 * sandbox. Handles both cases the old code split apart — content conflicts and
 * everything-else (shallow clone, dirty tree, missing ref) — because from the agent's
 * side they're one job: get the merge through.
 */
export async function mergeWithAgent(o: {
  projectId: string;
  userId: string;
  workspaceId: string;
  projectDir: string;      // "/data/project"
  featureBranch: string;
  targetBranch: string;
  /** Token-embedded remote URL, so the push works on a private repo. */
  authUrl: string;
  /** What git said when we tried it ourselves. */
  error?: string;
  /** Paths git reported unmerged, when it was a content conflict. */
  conflictFiles?: string[];
  onLog?: (line: string) => void;
}): Promise<AgentMergeResult> {
  const log = o.onLog ?? (() => {});
  const dirName = o.projectDir.replace(/^\/(root|data)\//, "").replace(/^\//, "");

  const sh = async (script: string, timeout = 120_000) => {
    const b64 = Buffer.from(script).toString("base64");
    const r = await execOnWorkspace(o.workspaceId, `echo ${b64} | base64 -d | sh`, { timeout })
      .catch((e) => ({ output: `EXEC_FAILED: ${(e as Error).message}`, exitCode: 1 }));
    return { output: r.output ?? "", exitCode: r.exitCode ?? 0 };
  };

  if (o.error) log(`Why the merge failed: ${explainGitFailure(o.error)}`);
  log(`Handing the merge to the coding agent in the sandbox — it has the repo, a shell, and the error.`);

  // Credentials and permission. Not strategy — the agent cannot push without these.
  await sh(`
git config --global --add safe.directory '*' 2>/dev/null || true
cd "${o.projectDir}" 2>/dev/null || exit 0
git config user.email "agent@lfg.dev" 2>/dev/null || true
git config user.name "LFG Agent" 2>/dev/null || true
git remote set-url origin "${o.authUrl}" 2>/dev/null || git remote add origin "${o.authUrl}" 2>/dev/null || true
git merge --abort 2>/dev/null || true`);

  const buildCmd = await buildCmdFor(o.projectId);
  const prompt = `Merge the branch \`${o.featureBranch}\` into \`${o.targetBranch}\` in the git repository at ${o.projectDir}, and push \`${o.targetBranch}\` to origin.

${o.error ? `## We tried it and git said\n\`\`\`\n${o.error.slice(0, 1500)}\n\`\`\`\n` : ""}${o.conflictFiles?.length ? `## Conflicting files\n${o.conflictFiles.join("\n")}\n` : ""}
## What you should know about this checkout
- \`origin\` is already set to an authenticated URL — push works, don't change the remote.
- This is a DISPOSABLE sandbox clone, not anyone's workstation. Uncommitted edits and untracked files in it are throwaway (preview setup rewrites config files like appsettings.json on every run), so you may stash, clean, reset or re-checkout freely to get a workable tree.
- The repo was cloned with \`--depth 1\`, so it is SHALLOW. If git says "refusing to merge unrelated histories", that is why: the commit both branches descend from was never downloaded. Fix it by fetching the real history — \`git fetch --unshallow origin\` (or \`git fetch --deepen=500 origin\`), then fetch both branches — NOT by deleting \`.git/shallow\`, which removes the marker without downloading anything.

## Rules
- Do NOT change the CONTENT of either branch to make the merge easier: no reverting the feature work, no force-push, no dropping commits, no \`-X ours\`/\`-X theirs\` to sidestep a real conflict.
- If there are genuine content conflicts, resolve them by hand keeping BOTH sides' intent, then commit the merge.
${buildCmd ? `- Before pushing, confirm the merged tree still builds: \`${buildCmd}\`. If it doesn't, fix the merge until it does.\n` : ""}- Finish by pushing \`${o.targetBranch}\` to origin, and verify with \`git ls-remote\` that origin actually has it.

## When you're done
Reply with 2-4 plain sentences: what was actually wrong with the merge, and what you did about it.`;

  const cli = await resolveCli(o.userId);
  let account = "";

  if (cli.credentialNote) log(cli.credentialNote);

  if (cli.usePi && cli.provider) {
    log(`Merging with Pi (${cli.provider}/${cli.piModelId})…`);
    try {
      const pi = await startPiCli({
        workspaceId: o.workspaceId, prompt, projectDir: dirName,
        provider: cli.provider, modelId: cli.piModelId,
        apiKey: cli.apiKey, oauthAccessToken: cli.oauthAccessToken,
        envVars: await projectEnv(o.projectId),
      });
      let lastLog = 0;
      const res = await streamPiToCompletion({
        workspaceId: o.workspaceId, outputFile: pi.outputFile, backgroundPid: pi.backgroundPid,
        timeoutMs: MERGE_TIMEOUT_MS, progressMaxLen: 200,
        onProgress: (m) => { const n = Date.now(); if (n - lastLog < 3_000) return; lastLog = n; log(`  ${m}`); },
      });
      account = (extractPiProgress(res.tail || "", 1200) || "").replace(/^Agent:\s*/, "").trim();
      if (res.fatalError) log(`Pi stopped: ${res.fatalError.slice(0, 200)}`);
    } catch (e) {
      log(`Pi could not start: ${(e as Error).message?.slice(0, 200)}`);
    }
  } else if (cli.claudeUsable) {
    log(`Merging with Claude Code…`);
    try {
      const run = await startClaudeCli({
        workspaceId: o.workspaceId, prompt, projectDir: dirName,
        userId: o.userId, maxTurns: 80, anthropicApiKey: cli.anthropicApiKey,
        envVars: await projectEnv(o.projectId),
      });
      let offset = 0, all = "", done = false, errs = 0, lastLog = 0;
      const deadline = Date.now() + MERGE_TIMEOUT_MS;
      while (Date.now() < deadline && !done) {
        await new Promise((r) => setTimeout(r, 5_000));
        let poll;
        try { poll = await pollOutput(o.workspaceId, run.outputFile, offset, run.backgroundPid); errs = 0; }
        catch { if (++errs >= 6) break; continue; }
        offset = poll.newOffset;
        if (poll.data) {
          all += poll.data;
          const now = Date.now();
          if (now - lastLog > 3_000) {
            lastLog = now;
            const ev = parseJsonlEvents(poll.data);
            const last = ev[ev.length - 1];
            if (last) log(`  ${JSON.stringify(last).slice(0, 200)}`);
          }
          if (isStreamComplete(ev0(all))) done = true;
        }
        if (!poll.alive && poll.alive !== undefined && poll.alive === false) done = true;
      }
      extractExitCode(all);
      account = lastAssistantText(all);
    } catch (e) {
      log(`Claude Code could not start: ${(e as Error).message?.slice(0, 200)}`);
    }
  } else {
    const why = cli.credentialNote
      || `no usable credential for ${cli.provider ?? "the selected model"} (${cli.modelKey})`;
    log(`No coding agent is available for this merge — ${why}.`);
    return { merged: false, summary: `No coding agent available to run the merge — ${why}.` };
  }

  // OUR verdict, not the agent's: does the target on the REMOTE actually contain the
  // feature branch now? Nothing else counts as merged.
  const check = await sh(`
cd "${o.projectDir}"
git remote set-url origin "${o.authUrl}" 2>/dev/null || true
git fetch --no-tags --force origin "+refs/heads/${o.targetBranch}:refs/remotes/origin/${o.targetBranch}" "+refs/heads/${o.featureBranch}:refs/remotes/origin/${o.featureBranch}" >/dev/null 2>&1
if git merge-base --is-ancestor "origin/${o.featureBranch}" "origin/${o.targetBranch}" 2>/dev/null; then
  echo "MERGED:$(git rev-parse origin/${o.targetBranch})"
else
  echo "NOT_MERGED"
fi`, 120_000);

  const sha = check.output.match(/MERGED:([a-f0-9]{40})/)?.[1];
  if (sha) {
    log(`Merged. ${account || "(the agent gave no account)"}\n\n${o.targetBranch} is now at ${sha.slice(0, 7)} and contains ${o.featureBranch}.`);
    return { merged: true, sha, summary: account || "the agent completed the merge" };
  }
  log(`The agent could not get the merge through.${account ? `\n\n${account}` : ""}`);
  return { merged: false, summary: account || "The agent could not complete the merge — needs a human." };
}

/** Events parsed from the whole stream so far (cheap enough at these sizes). */
function ev0(all: string) { return parseJsonlEvents(all); }

/** The agent's closing message from a Claude JSONL stream, or "". */
function lastAssistantText(all: string): string {
  try {
    const events = parseJsonlEvents(all);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i] as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
      if (e.type === "result" && typeof e.result === "string" && e.result.trim()) return e.result.trim().slice(0, 1200);
      const text = e.message?.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text) return text.slice(0, 1200);
    }
  } catch { /* fall through */ }
  return "";
}
