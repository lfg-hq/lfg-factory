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
import { execOnWorkspace } from "./mags.ts";

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
    // The merge went through this time (the anchor moved under us). Nothing to resolve.
    log("The merge applied cleanly on retry — no conflict to resolve.");
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

  const fileList = files.map((f) => `  - ${f}`).join("\n");
  log(`Handing the conflict to the AI resolver…`);
  await generateText({
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
      `When every conflicting file is resolved, reply with one short line naming what you did.`,
    prompt:
      `Resolve the conflicts from merging \`${featureBranch}\` into \`${targetBranch}\`.\n\n` +
      `Conflicting files:\n${fileList}\n\n` +
      `Edit them so the merged result keeps what both branches intended, then stop.`,
  }).catch((e) => {
    log(`Resolver agent errored: ${(e as Error).message?.slice(0, 160)}`);
    return null;
  });

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
    log(`Resolution rejected — ${why}. Aborting the merge and leaving the branch untouched.`);
    await sh(`cd "${projectDir}" && git merge --abort 2>/dev/null; git checkout ${featureBranch} 2>/dev/null || true`);
    return { resolved: false, files, summary: `The AI resolver did not finish the merge (${why}) — needs a human.` };
  }

  // Optional build gate: a resolution that doesn't compile is worse than no resolution,
  // because it lands on the branch the client previews.
  if (verifyCmd) {
    log(`Verifying the resolved merge builds: ${verifyCmd}`);
    const built = await sh(`cd "${projectDir}" && ${verifyCmd} 2>&1 | tail -30`, 1_800_000);
    if (built.exitCode !== 0) {
      log(`Resolved merge does NOT build (exit ${built.exitCode}) — aborting.`);
      await sh(`cd "${projectDir}" && git merge --abort 2>/dev/null; git checkout ${featureBranch} 2>/dev/null || true`);
      return { resolved: false, files, summary: `The AI resolved the conflicts but the result didn't build — needs a human.\n${built.output.slice(-600)}` };
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
  log(summary);
  return { resolved: true, sha, files, summary };
}
