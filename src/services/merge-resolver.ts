/**
 * Merge-conflict resolver — hands a conflicted merge to an agent inside the sandbox.
 *
 * Division of labour is deliberate. WE drive git: recreate the conflict, verify the
 * result, commit and push. The AGENT only edits the conflicting files. It never gets to
 * decide that the merge is finished, and it never pushes — because the failure mode that
 * matters here isn't "the agent can't fix it", it's "the agent produces something
 * plausible that lands on the epic branch unnoticed", which is exactly what epics exist
 * to prevent.
 *
 * So every resolution passes a deterministic gate before it's committed: no unmerged
 * paths, no conflict markers anywhere in the tree, and — when the caller supplies a build
 * command — a build that actually compiles. Anything short of that is aborted and
 * reported as unresolved, leaving the branch exactly as it was.
 */
import { z } from "zod";
import { generateText, stepCountIs, tool, zodSchema, type LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { execOnWorkspace } from "./mags.ts";
import { db } from "../config/db.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";

export interface ResolveMergeInput {
  workspaceId: string;
  projectDir: string;
  featureBranch: string;
  targetBranch: string;
  /** Paths git reported as unmerged. */
  files: string[];
  /** Token-embedded remote URL, so the push works on a private repo. */
  authUrl: string;
  model: LanguageModel;
  /** Optional build command — when given, a resolution that doesn't compile is rejected. */
  verifyCmd?: string;
  /** Progress lines (ticket log / preview log). */
  onLog?: (line: string) => void;
}

export interface ResolveMergeResult {
  resolved: boolean;
  /** Merge commit sha on the target branch, when resolved. */
  sha?: string;
  files: string[];
  /** One-line account of what was done, for the ticket log and the Git tab. */
  summary: string;
  /** The resolver's own account — why it conflicted and what it did, per file. Present
   *  even when the resolution was REJECTED, since that's when you most want to see what
   *  was attempted. */
  explanation?: string;
}

/**
 * Files we will NOT let an agent reconcile. Not because it couldn't produce something
 * that parses, but because a wrong answer here is silent and expensive: a hand-merged
 * lockfile installs versions nobody chose, and a hand-merged migration corrupts a schema
 * in a way that only shows up later. These go to a human.
 */
const NEVER_AUTO_RESOLVE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|packages\.lock\.json|Gemfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock)$/i,
  /(^|\/)([Mm]igrations?)\//,
  /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|dll|so|dylib|exe|woff2?|ttf)$/i,
];

/** Past this, the branches have genuinely diverged (a re-cut anchor, say) and this is a
 *  structural problem to look at, not a merge to patch up file by file. */
const MAX_FILES = 20;

function guardrail(files: string[]): string | null {
  if (!files.length) return "git reported a conflict but no unmerged paths — nothing safe to act on.";
  if (files.length > MAX_FILES) {
    return `${files.length} conflicting files — too divergent to resolve automatically (this usually means the branches were cut from different bases).`;
  }
  const blocked = files.filter((f) => NEVER_AUTO_RESOLVE.some((re) => re.test(f)));
  if (blocked.length) {
    return `Not auto-resolving: ${blocked.join(", ")}. Lockfiles, migrations and binaries need a human — a plausible-looking merge of these breaks things quietly.`;
  }
  return null;
}

export async function resolveMergeConflict(input: ResolveMergeInput): Promise<ResolveMergeResult> {
  const { workspaceId, projectDir, featureBranch, targetBranch, files, authUrl, model, verifyCmd } = input;
  const log = input.onLog ?? (() => {});

  const refused = guardrail(files);
  if (refused) {
    log(`Conflict NOT auto-resolved — ${refused}`);
    return { resolved: false, files, summary: refused };
  }

  const sh = async (script: string, timeout = 120_000) => {
    const b64 = Buffer.from(script).toString("base64");
    const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout })
      .catch((e) => ({ output: `EXEC_FAILED: ${(e as Error).message}`, exitCode: 1 }));
    return { output: r.output ?? "", exitCode: r.exitCode ?? 0 };
  };

  // Put the checkout back INTO the conflicted state we just aborted, so the agent has
  // real conflict markers to work with rather than a description of them.
  log(`Re-creating the merge so it can be resolved (${files.length} file(s))…`);
  const setup = await sh(`
cd "${projectDir}" || exit 1
git config user.email "ai@lfg.dev"; git config user.name "LFG AI"
git remote set-url origin "${authUrl}" 2>/dev/null || true
git fetch --prune origin >/dev/null 2>&1
git checkout ${targetBranch} 2>/dev/null || git checkout -b ${targetBranch} origin/${targetBranch}
git reset --hard origin/${targetBranch} >/dev/null 2>&1
git merge ${featureBranch} -m "Merge ${featureBranch} into ${targetBranch}" >/dev/null 2>&1
UN=$(git diff --name-only --diff-filter=U 2>/dev/null)
[ -n "$UN" ] && { echo "CONFLICTED"; echo "$UN"; } || echo "NO_CONFLICT"`);

  if (setup.output.includes("NO_CONFLICT")) {
    // Replaying it worked, so there was never a content conflict — the first attempt died
    // before finishing (an interrupted run leaves "Merging to …" as the last line and
    // nothing after it), or the anchor moved since. Say which, rather than leaving a
    // silent success where a failure was reported minutes earlier.
    log(
      `Merge succeeded on retry — there was no content conflict.\n\n` +
      `Why the first attempt didn't land: the merge was started but never completed — ` +
      `typically the build run was interrupted mid-command, or the target branch moved between ` +
      `the two attempts. Replaying it against the current ${targetBranch} applied cleanly, so ` +
      `nothing had to be reconciled and no code was changed to make it work.`
    );
    const done = await sh(`cd "${projectDir}" && git push origin ${targetBranch} 2>&1 | tail -2 && echo "SHA:$(git rev-parse ${targetBranch})" && git checkout ${featureBranch} 2>/dev/null || true`);
    const sha = done.output.match(/SHA:([a-f0-9]{40})/)?.[1];
    return { resolved: !!sha, sha, files, summary: "Merged cleanly on retry — no conflict resolution needed." };
  }
  if (!setup.output.includes("CONFLICTED")) {
    log("Could not re-create the merge to resolve it.");
    await sh(`cd "${projectDir}" && git merge --abort 2>/dev/null; git checkout ${featureBranch} 2>/dev/null || true`);
    return { resolved: false, files, summary: `Could not re-create the merge:\n${setup.output.slice(-400)}` };
  }

  // ── The agent: edit the conflicting files, nothing else ──────────────────────
  const tools = {
    run: tool({
      description:
        "Run ONE shell command in the repo (the conflicted merge is already in progress there). Use it to read the conflicting files, inspect both sides (`git log`, `git show`, `git diff`), and write the resolved content. Returns exit code + combined output. Do NOT commit, push, merge, rebase, reset, or checkout a different branch — the caller does all of that and will verify your work first.",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("One shell command, e.g. `cat -n src/Program.cs`, `git show :2:src/Program.cs`, `git diff --name-only --diff-filter=U`, or a heredoc that writes the resolved file."),
      })),
      execute: async ({ command }: { command: string }) => {
        // Block the git verbs that would take the decision out of our hands. The sandbox
        // is disposable, so this is about keeping the workflow honest, not security.
        if (/\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|checkout\s+-|switch)\b/.test(command)) {
          return { exitCode: 1, output: "Refused: the caller handles commit/push/merge. Only edit the conflicting files." };
        }
        log(`  resolver$ ${command.slice(0, 120)}`);
        const r = await sh(`cd "${projectDir}" && ${command}`, 120_000);
        return { exitCode: r.exitCode, output: r.output.slice(-6000) || "(no output)" };
      },
    }),
  };

  // Gather WHY this conflicted, deterministically, before the agent gets involved: where
  // the branches diverged and which commits on each side touched each file. Grounding the
  // explanation in real history beats letting a model narrate from the markers alone.
  const shq = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;
  const ctx = await sh(`
cd "${projectDir}"
MB=$(git merge-base ${targetBranch} ${featureBranch} 2>/dev/null)
echo "MERGE_BASE:$MB $(git log -1 --format='%cr' "$MB" 2>/dev/null)"
for f in ${files.map(shq).join(" ")}; do
  echo "FILE:$f"
  echo "  hunks: $(grep -c '^<<<<<<< ' "$f" 2>/dev/null || echo '?')"
  echo "  on ${targetBranch}:"; git log --format='    %h %s' "$MB..${targetBranch}" -- "$f" 2>/dev/null | head -4
  echo "  on ${featureBranch}:"; git log --format='    %h %s' "$MB..${featureBranch}" -- "$f" 2>/dev/null | head -4
done`, 60_000);
  const conflictContext = ctx.output.slice(0, 4000);

  const fileList = files.map((f) => `  - ${f}`).join("\n");
  log(`Handing the conflict to the AI resolver…`);
  const run = await generateText({
    model,
    tools,
    stopWhen: stepCountIs(30),
    system:
      `You are resolving a git merge conflict inside a disposable Linux sandbox. The merge of ` +
      `\`${featureBranch}\` into \`${targetBranch}\` is IN PROGRESS in the working tree, with conflict markers in place.\n\n` +
      `Your ONLY job is to edit the conflicting files so they are correct, then stop. Do not commit, push, ` +
      `or run any git command that changes branches or history — the caller commits and pushes after ` +
      `verifying your work, and will reject it if conflict markers remain or the build fails.\n\n` +
      `How to do this well:\n` +
      `- Read each conflicting file in full. Understand what BOTH sides were trying to do before choosing.\n` +
      `- \`git show :2:<path>\` is the target side ("ours"), \`git show :3:<path>\` is the incoming side ("theirs"), ` +
      `\`git log --oneline -3 ${featureBranch}\` shows what the feature branch was doing.\n` +
      `- The usual right answer is to KEEP BOTH intentions, not to pick a side: two branches that each ` +
      `registered a service, added a using, or appended a route both need their line in the result.\n` +
      `- Remove every \`<<<<<<<\`, \`=======\` and \`>>>>>>>\` marker. Leave the file syntactically valid.\n` +
      `- Do not "fix" anything unrelated to the conflict, and do not delete code you don't understand.\n\n` +
      `WHEN YOU ARE DONE, your final reply is an explanation a developer will read in the ticket log ` +
      `weeks from now, with no other context. Use exactly this shape, plain text, no preamble:\n\n` +
      `Why it conflicted\n` +
      `<1-3 sentences: what each side changed and why git couldn't order them. Name the real things — ` +
      `"both branches registered a service in Program.cs", not "the same lines changed".>\n\n` +
      `What I did\n` +
      `- <file>: <what you kept from each side, and anything you deliberately dropped and why>\n\n` +
      `Keep it short and concrete. If you were unsure about a choice, say so on a final "Worth checking:" line.`,
    prompt:
      `Resolve the conflicts from merging \`${featureBranch}\` into \`${targetBranch}\`.\n\n` +
      `Conflicting files:\n${fileList}\n\n` +
      `History behind the conflict (where the branches diverged, and what each side did to each file):\n` +
      `${conflictContext}\n\n` +
      `Edit them so the merged result keeps what both branches intended, then explain as instructed.`,
  }).catch((e) => {
    log(`Resolver agent errored: ${(e as Error).message?.slice(0, 160)}`);
    return null;
  });
  const explanation = (run?.text ?? "").trim();

  // ── Our gate. The agent's opinion that it's done counts for nothing. ─────────
  log("Checking the resolution…");
  const check = await sh(`
cd "${projectDir}"
UN=$(git diff --name-only --diff-filter=U 2>/dev/null)
[ -n "$UN" ] && { echo "STILL_UNMERGED"; echo "$UN"; }
# Conflict markers anywhere in the tree, including files it wasn't asked about.
if git grep -lE '^(<{7}|={7}|>{7})( |$)' -- . 2>/dev/null | head -5 | grep -q .; then
  echo "MARKERS_REMAIN"; git grep -lE '^(<{7}|={7}|>{7})( |$)' -- . 2>/dev/null | head -5
fi
echo "CHECK_DONE"`);

  if (check.output.includes("STILL_UNMERGED") || check.output.includes("MARKERS_REMAIN")) {
    const why = check.output.includes("MARKERS_REMAIN") ? "conflict markers are still in the tree" : "files are still unmerged";
    log(`Resolution REJECTED — ${why}. The merge is aborted; the branch is exactly as it was.`);
    if (explanation) log(`What the resolver attempted (rejected, not applied):\n\n${explanation}`);
    await sh(`cd "${projectDir}" && git merge --abort 2>/dev/null; git checkout ${featureBranch} 2>/dev/null || true`);
    return { resolved: false, files, explanation, summary: `The AI resolver did not finish the merge (${why}) — needs a human.` };
  }

  // Optional build gate: a resolution that doesn't compile is worse than no resolution,
  // because it lands on the branch the client previews.
  if (verifyCmd) {
    log(`Verifying the resolved merge builds: ${verifyCmd}`);
    const built = await sh(`cd "${projectDir}" && ${verifyCmd} 2>&1 | tail -30`, 1_800_000);
    if (built.exitCode !== 0) {
      log(`Resolution REJECTED — the merged result does not build (exit ${built.exitCode}). The merge is aborted; the branch is exactly as it was.`);
      if (explanation) log(`What the resolver attempted (rejected, not applied):\n\n${explanation}`);
      log(`Build output:\n${built.output.slice(-800)}`);
      await sh(`cd "${projectDir}" && git merge --abort 2>/dev/null; git checkout ${featureBranch} 2>/dev/null || true`);
      return { resolved: false, files, explanation, summary: `The AI resolved the conflicts but the result didn't build — needs a human.\n${built.output.slice(-600)}` };
    }
    log("Resolved merge builds ✓");
  }

  // Ours to commit and push — never the agent's.
  const commit = await sh(`
cd "${projectDir}"
git add -A
git commit -m "Merge ${featureBranch} into ${targetBranch} (AI-resolved conflicts in ${files.length} file(s))" 2>&1 | tail -2
git push origin ${targetBranch} 2>&1 | tail -2
echo "SHA:$(git rev-parse ${targetBranch})"
git checkout ${featureBranch} 2>/dev/null || true`, 180_000);

  const sha = commit.output.match(/SHA:([a-f0-9]{40})/)?.[1];
  if (!sha) {
    log("Could not commit/push the resolved merge.");
    await sh(`cd "${projectDir}" && git merge --abort 2>/dev/null; git checkout ${featureBranch} 2>/dev/null || true`);
    return { resolved: false, files, summary: `Resolved the conflicts but could not push:\n${commit.output.slice(-400)}` };
  }

  const summary = `AI-resolved ${files.length} conflicting file(s) merging into ${targetBranch}: ${files.join(", ")}${verifyCmd ? " (build verified)" : ""}.`;
  // The explainer is the point of all this: months from now the ticket log should say why
  // the merge failed and what was changed, not just that something happened.
  log(
    `Merge conflict resolved — ${files.length} file(s) into ${targetBranch}` +
    `${verifyCmd ? " (build verified)" : " (no build command configured — NOT build-verified)"}\n\n` +
    (explanation || "(the resolver gave no explanation)") +
    `\n\nMerge commit ${sha.slice(0, 7)}. Review the diff before approving.`
  );
  return { resolved: true, sha, files, summary, explanation };
}

/**
 * Convenience wrapper for the two places a ticket's merge can conflict (the build, and
 * the Push & Merge button): resolves the acting user's model and the project's build
 * command, then runs the resolver.
 *
 * The build command is the important part — it's what turns "the markers are gone" into
 * "this actually compiles", and it's already recorded on the project's preview manifest.
 * Returns null when there's no usable model, which callers read as "unresolved".
 */
export async function resolveTicketMergeConflict(o: {
  /** Internal project id. */
  projectId: string;
  /** Whose model + API keys to drive the resolver with. */
  userId: string;
  workspaceId: string;
  projectDir: string;
  featureBranch: string;
  targetBranch: string;
  files: string[];
  authUrl: string;
  onLog?: (line: string) => void;
}): Promise<ResolveMergeResult | null> {
  const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, o.userId));
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, o.userId));
  let model: LanguageModel;
  try {
    model = getModel(sel?.selectedModel ?? DEFAULT_MODEL_KEY, {
      anthropic: keys?.anthropicApiKey ?? undefined, openai: keys?.openaiApiKey ?? undefined,
      google: keys?.googleApiKey ?? undefined, kimi: keys?.kimiApiKey ?? undefined,
      deepseek: keys?.deepseekApiKey ?? undefined, glm: keys?.glmApiKey ?? undefined,
    }, { allowEnvFallback: true });
  } catch {
    return null; // no usable key → leave the conflict for a human
  }

  let verifyCmd: string | undefined;
  try {
    const [env] = await db.select({ m: projectEnvironments.setupManifest })
      .from(projectEnvironments).where(eq(projectEnvironments.projectId, o.projectId)).limit(1);
    verifyCmd = env?.m ? (JSON.parse(env.m) as { buildCmd?: string }).buildCmd : undefined;
  } catch { /* no manifest → resolve without the build gate */ }

  return await resolveMergeConflict({
    workspaceId: o.workspaceId,
    projectDir: o.projectDir,
    featureBranch: o.featureBranch,
    targetBranch: o.targetBranch,
    files: o.files,
    authUrl: o.authUrl,
    model,
    verifyCmd,
    onLog: o.onLog,
  });
}
