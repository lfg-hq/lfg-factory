/**
 * Pre-PR review: before the Git tab opens a pull request, an agent reviews what the PR
 * would contain (the GitHub compare of head against base) and reports what a careful
 * reviewer would: bugs, security problems, missing pieces against the ticket's
 * acceptance criteria, risky changes, and tests. It can read any file at the head
 * branch for context.
 *
 * It only returns judgement (a verdict, findings and a draft title/description); the
 * user decides whether to open the PR. Same split as pr-author.ts.
 */
import { z } from "zod";
import { generateText, stepCountIs, tool, zodSchema, type LanguageModel } from "ai";
import { githubChangeSet, githubFileAt } from "./github-branches.ts";
import type { Gh } from "./ticket-diff-github.ts";

export type ReviewFinding = { severity: "blocker" | "major" | "minor" | "nit"; file?: string; line?: number; title: string; detail: string };
export type PrReview = {
  verdict: "ready" | "needs_changes" | "blocked";
  summary: string;
  findings: ReviewFinding[];
  checked: string[];
  title: string;
  body: string;
  stats: { commits: number; files: number; added: number; removed: number };
  compareUrl: string;
};
export type ReviewContext = {
  ticket?: { key?: string | null; name: string; description?: string | null; acceptanceCriteria?: unknown[] };
  epic?: { key?: string | null; name: string; goal?: string | null };
};

const PATCH_BUDGET = 120_000;
const FILE_CHARS = 40_000;

const resultSchema = z.object({
  verdict: z.enum(["ready", "needs_changes", "blocked"]),
  summary: z.string(),
  findings: z.array(z.object({
    severity: z.enum(["blocker", "major", "minor", "nit"]),
    file: z.string().optional(), line: z.number().optional(),
    title: z.string(), detail: z.string(),
  })).default([]),
  checked: z.array(z.string()).default([]),
  title: z.string(),
  body: z.string(),
});

/** The model's final message → a review. Tolerates prose or a ```json fence around the object. */
export function parseReview(text: string): z.infer<typeof resultSchema> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return resultSchema.parse(JSON.parse(raw)); } catch { return null; }
}

export async function reviewPullRequest(input: {
  gh: Gh; base: string; head: string; model: LanguageModel; context?: ReviewContext;
  onProgress?: (message: string) => void; fetcher?: typeof fetch;
}): Promise<PrReview> {
  const { gh, base, head, model, context = {} } = input;
  const progress = input.onProgress ?? (() => {});
  const fetcher = input.fetcher ?? fetch;

  progress(`Reading ${head} against ${base}…`);
  const change = await githubChangeSet(gh, base, head, fetcher);
  if (change.error) throw new Error(change.error);
  if (!change.aheadBy) throw new Error(`${head} has nothing that ${base} doesn't already have, so there's nothing to open a pull request for.`);
  const stats = {
    commits: change.aheadBy, files: change.files.length,
    added: change.files.reduce((n, f) => n + f.added, 0), removed: change.files.reduce((n, f) => n + f.removed, 0),
  };

  // Every file's patch while the budget lasts; the rest listed so the agent can read them on demand.
  let used = 0;
  const shown: string[] = [], skipped: string[] = [];
  for (const f of change.files) {
    const block = `--- ${f.path} (${f.status}, +${f.added} -${f.removed})\n${f.patch}`;
    if (used + block.length > PATCH_BUDGET) { skipped.push(`${f.path} (+${f.added} -${f.removed})`); continue; }
    used += block.length; shown.push(block);
  }

  const t = context.ticket, e = context.epic;
  const criteria = t?.acceptanceCriteria?.length
    ? t.acceptanceCriteria.map((c) => `- ${typeof c === "string" ? c : JSON.stringify(c)}`).join("\n") : "";
  const spec = [
    e ? `Epic ${e.key ?? ""} "${e.name}"${e.goal ? `: ${e.goal}` : ""}` : "",
    t ? `Ticket ${t.key ?? ""} "${t.name}"\n${(t.description ?? "").slice(0, 4000)}` : "",
    criteria ? `Acceptance criteria:\n${criteria}` : "",
  ].filter(Boolean).join("\n\n");

  const tools = {
    readFile: tool({
      description: `Read a file's full current text on ${head} (or on ${base} with side="base") to understand a change in context: callers, types, config, tests.`,
      inputSchema: zodSchema(z.object({ path: z.string(), side: z.enum(["head", "base"]).optional() })),
      execute: async ({ path, side }: { path: string; side?: "head" | "base" }) => {
        progress(`Reading ${path}…`);
        const text = await githubFileAt(gh, path, side === "base" ? base : head, fetcher).catch(() => null);
        return text === null ? { error: `${path} isn't on ${side === "base" ? base : head} (or isn't a text file).` } : { text: text.slice(0, FILE_CHARS), truncated: text.length > FILE_CHARS };
      },
    }),
  };

  progress(`Reviewing ${stats.files} file${stats.files === 1 ? "" : "s"}…`);
  const result = await generateText({
    model,
    tools,
    stopWhen: stepCountIs(14),
    system:
      "You are a senior engineer doing a thorough pull request review before the PR is opened. Review the change for: " +
      "correctness bugs and edge cases; security (injection, auth/permission gaps, secrets committed, unsafe input handling); " +
      "data loss or migrations; error handling; breaking API/contract changes; performance problems; missing or weak tests; " +
      "and, when a ticket is given, whether every acceptance criterion is actually met (say which are not). " +
      "Read surrounding files with readFile when a patch alone can't tell you whether something is right; don't guess. " +
      "Only report real, specific problems with the file and line; no generic advice, no praise. Severity: blocker = must not merge " +
      "(broken build, security hole, data loss, criterion clearly unmet); major = likely bug or significant gap; minor = should fix; nit = optional. " +
      "Verdict: blocked if any blocker, needs_changes if any major, else ready.\n\n" +
      "Finish with ONLY a JSON object, no other text: " +
      '{"verdict":"ready|needs_changes|blocked","summary":"2-4 sentences: what the change does and its overall state",' +
      '"findings":[{"severity":"blocker|major|minor|nit","file":"path","line":12,"title":"short","detail":"what is wrong, why it matters, how to fix"}],' +
      '"checked":["what you verified, e.g. \\"Acceptance criterion 2 (rate limit) is enforced in src/x.ts\\""],' +
      '"title":"PR title, imperative, under 72 chars","body":"PR description in Markdown: ## Summary, ## Changes (bullets), ## Testing, and ## Review notes listing open findings"}',
    prompt:
      `Pull request: ${head} → ${base} in ${gh.owner}/${gh.repo}. ${stats.commits} commit(s), ${stats.files} file(s), +${stats.added} -${stats.removed}.\n\n` +
      (spec ? `What this work was asked to do:\n${spec}\n\n` : "") +
      `Commits:\n${change.commits.map((c) => `${c.sha} ${c.message}`).join("\n").slice(0, 6000)}\n\n` +
      `Diff:\n${shown.join("\n\n")}` +
      (skipped.length ? `\n\nNot shown (over budget; use readFile if they matter):\n${skipped.join("\n")}` : ""),
  });

  const parsed = parseReview(result.text);
  if (!parsed) throw new Error("The review didn't come back in a readable form. Try again, or pick a different model.");
  const rank = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;
  const findings = [...parsed.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
  // The verdict follows the findings, whatever the model labelled it.
  const verdict = findings.some((f) => f.severity === "blocker") ? "blocked" : findings.some((f) => f.severity === "major") ? "needs_changes" : parsed.verdict === "blocked" ? "needs_changes" : parsed.verdict;
  return { ...parsed, verdict, findings, stats, compareUrl: change.compareUrl };
}
