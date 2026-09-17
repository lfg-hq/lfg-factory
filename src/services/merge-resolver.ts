import { resolveLlmGrants, teamApiKeys } from "./llm-access.ts";
import { projects } from "../db/schema/projects.ts";
/** Coding repair edits a local candidate; publication belongs to the validated Git service. */
import { eq } from "drizzle-orm";
import { execOnWorkspace } from "./mags.ts";
import { db } from "../config/db.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { profiles, applicationState } from "../db/schema/users.ts";
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
async function resolveCli(userId: string, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("Project not found");
  const grants = await resolveLlmGrants(project, userId);
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
  const authMode = !grants.canUseKey ? "subscription" : !grants.canUsePersonalSubscription ? "api_key" : appState?.mode === "api_key" ? "api_key" : "subscription";
  if (authMode === "subscription" && !grants.canUsePersonalSubscription) throw new Error("Personal subscriptions are disabled");
  const keys = authMode === "api_key" ? await teamApiKeys(userId, projectId) : undefined;
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
    && (!!keys?.anthropicApiKey || (authMode === "subscription" && !!profile?.claudeCodeAuthenticated && !!profile.claudeCodeCredentials));
  return {
    modelKey, provider, apiKey: piApiKey, oauthAccessToken, usePi, claudeUsable, credentialNote,
    anthropicApiKey: provider === "anthropic" && authMode === "api_key" ? keys?.anthropicApiKey ?? undefined : undefined,
    piModelId: getProviderModel(modelKey) ?? modelKey,
  };
}

export async function runValidationRepair(o: {
  projectId: string; userId: string; workspaceId: string; projectDir: string;
  prompt: string; resourceRecovery?:boolean; timeoutMs?:number; envVars?: Record<string,string>; onLog?: (line:string)=>void; cancelled?: () => boolean;
}): Promise<string> {
  const log = o.onLog ?? (() => {});
  const dirName = o.projectDir.replace(/^\/(root|data)\//, "").replace(/^\//, "");
  const prompt = o.prompt;
  const cli = await resolveCli(o.userId, o.projectId);
  let account = "";

  if (cli.credentialNote) log(cli.credentialNote);

  if (cli.usePi && cli.provider) {
    log(`Repairing with Pi (${cli.provider}/${cli.piModelId})…`);
    try {
      const pi = await startPiCli({
        workspaceId: o.workspaceId, prompt, projectDir: dirName,
        controlDir:o.resourceRecovery ? "/tmp/lfg-pi-recovery" : undefined,
        provider: cli.provider, modelId: cli.piModelId,
        apiKey: cli.apiKey, oauthAccessToken: cli.oauthAccessToken,
        envVars: o.envVars ?? {},
      });
      let lastLog = 0;
      const res = await streamPiToCompletion({
        workspaceId: o.workspaceId, outputFile: pi.outputFile, backgroundPid: pi.backgroundPid,
        timeoutMs: (o.timeoutMs ?? MERGE_TIMEOUT_MS), progressMaxLen: 200, shouldCancel: o.cancelled,
        onProgress: (m) => { const n = Date.now(); if (n - lastLog < 3_000) return; lastLog = n; log(`  ${m}`); },
      });
      account = (extractPiProgress(res.tail || "", 1200) || "").replace(/^Agent:\s*/, "").trim();
      if (res.fatalError) throw new Error(res.fatalError);
    } catch (e) {
      throw new Error(`Pi repair failed: ${(e as Error).message}`);
    }
  } else if (cli.claudeUsable) {
    log(`Repairing with Claude Code…`);
    try {
      const run = await startClaudeCli({
        workspaceId: o.workspaceId, prompt, projectDir: dirName,
        userId: o.userId, maxTurns: 80, anthropicApiKey: cli.anthropicApiKey,
        envVars: o.envVars ?? {},
      });
      let offset = 0, all = "", done = false, errs = 0, lastLog = 0;
      const deadline = Date.now() + (o.timeoutMs ?? MERGE_TIMEOUT_MS);
      while (Date.now() < deadline && !done && !o.cancelled?.()) {
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
      if (!done && run.backgroundPid && /^\d+$/.test(String(run.backgroundPid))) {
        await execOnWorkspace(o.workspaceId, `pkill -TERM -P ${run.backgroundPid} 2>/dev/null; kill -TERM ${run.backgroundPid} 2>/dev/null; true`).catch(()=>{});
        throw new Error(o.cancelled?.() ? "Validation repair cancelled" : "Validation repair timed out");
      }
      extractExitCode(all);
      account = lastAssistantText(all);
    } catch (e) {
      throw new Error(`Claude Code repair failed: ${(e as Error).message}`);
    }
  } else {
    const why = cli.credentialNote
      || `no usable credential for ${cli.provider ?? "the selected model"} (${cli.modelKey})`;
    log(`No coding agent is available for this merge — ${why}.`);
    throw new Error(`No coding agent available for validation repair — ${why}.`);
  }

  if (o.cancelled?.()) throw new Error("Validation repair cancelled");
  return account;
}

export async function mergeWithAgent(o: {
  projectId: string; userId: string; workspaceId: string; projectDir: string;
  featureBranch: string; targetBranch: string; authUrl: string;
  error?: string; conflictFiles?: string[]; onLog?: (line:string)=>void;
}): Promise<AgentMergeResult> {
  // Recovery uses the same server-owned candidate gate. The agent never publishes.
  const { mergeToAnchor } = await import("./git.ts");
  const url = new URL(o.authUrl);
  const token = decodeURIComponent(url.password); const tokenUser = decodeURIComponent(url.username);
  url.password = ""; url.username = "";
  try {
    const result = await mergeToAnchor({ ...o, repoUrl: url.toString(), githubToken: token, tokenUser,
      validation: { projectId: o.projectId, userId: o.userId, onLog: o.onLog } });
    return { merged: true, sha: result.sha, summary: "Merged and validated the exact integration commit." };
  } catch(e) { return { merged: false, summary: (e as Error).message }; }
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

/** Persist one RPC process across runtime verification feedback. */
export async function createRuntimeRepairSession(o:{projectId:string;userId:string;workspaceId:string;projectDir:string;runId:string;deadline:number;envVars:Record<string,string>;onLog?:(line:string)=>void;cancelled?:()=>boolean}) {
 const [{PiRepairSession},{validationShell},{runtimeToolPolicySource}]=await Promise.all([import('./pi-rpc.ts'),import('./validation-sandbox.ts'),import('./runtime-tool-policy.ts')]);
 const cli=await resolveCli(o.userId,o.projectId);
 if(!cli.usePi || !cli.provider)throw new Error('Continuous ticket repair requires a configured Pi provider: '+(cli.credentialNote || 'no usable Pi credential'));
 const dir='/tmp/lfg-pi-recovery/'+o.runId;
 return new PiRepairSession(dir+'/input.fifo',o.deadline,{
  start:()=>startPiCli({workspaceId:o.workspaceId,prompt:'',projectDir:o.projectDir.replace(/^\/(root|data)\//,''),provider:cli.provider!,modelId:cli.piModelId,apiKey:cli.apiKey,oauthAccessToken:cli.oauthAccessToken,envVars:o.envVars,controlDir:'/tmp/lfg-pi-recovery',rpc:{fifo:dir+'/input.fifo',sessionFile:dir+'/session.jsonl',extensionSource:runtimeToolPolicySource}}),
  exec:script=>validationShell(o.workspaceId,script,15_000),wait:()=>new Promise(r=>setTimeout(r,2000)),now:()=>Date.now(),cancelled:o.cancelled,log:o.onLog,
 });
}
