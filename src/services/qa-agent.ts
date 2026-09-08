import { teamApiKeys } from "./llm-access.ts";
/**
 * QA agent — the job that runs AFTER a ticket builds.
 *
 * It writes a test suite for the ticket's acceptance criteria and, crucially,
 * PROVES the suite is worth having before committing it.
 *
 * ─ Why the proof matters ────────────────────────────────────────────────────
 * A model that has read the diff will happily write tests that assert what the
 * code does rather than what the ticket asked for. Those pass every time and
 * tell you nothing — worse than no tests, because they manufacture confidence.
 *
 * So the model writes the tests (it needs to see the code for them to compile),
 * and the SERVER decides whether to believe them, mechanically:
 *
 *   RED    check out the branch point's version of the changed source files and
 *          run each new test file. It should FAIL — the feature isn't there yet.
 *   GREEN  restore the implementation and run them again. They should PASS.
 *
 *   fail → pass   the test genuinely covers this ticket's change      → keep
 *   pass → pass   tautological, or covering pre-existing behaviour    → discard
 *   fail → fail   the interesting one: the code is wrong, or the test is → keep,
 *                 report it, and do NOT block the ticket (a generated test is
 *                 as likely to be wrong as the code it judges)
 *
 * The kept tests land as their own commit on the ticket's branch.
 *
 * ─ Contract ─────────────────────────────────────────────────────────────────
 *  • The only integration point is runTicketQa() — fire-and-forget, never throws.
 *  • Opt-in per project (projects.qaMode = "tests"); global kill switch TICKET_QA=off.
 *  • Runs in the ticket's EXISTING sandbox (deps installed, DB seeded) — a fresh
 *    VM per QA run would cost more than the build it is checking.
 */

import { and, desc, eq } from "drizzle-orm";
import { generateText } from "ai";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { projects } from "../db/schema/projects.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { execOnWorkspace } from "./mags.ts";
import { addLog } from "./ticket-logs.ts";
import { resolveTicketAnchor } from "./epics.ts";
import { resolveRepoAuth } from "./repo-auth.ts";
import { resolveGitActor } from "./git-access.ts";
import { commitAndPush, mergeToAnchor } from "./git.ts";

const WORKING_DIR = "/data";
const RUN_TIMEOUT_MS = parseInt(process.env.QA_TEST_TIMEOUT_MS || "420000", 10); // 7 min per phase
const MAX_TEST_FILES = parseInt(process.env.QA_MAX_TEST_FILES || "6", 10);

export function isQaEnabled(): boolean {
  return (process.env.TICKET_QA ?? "on") !== "off";
}

// ── Test runners ──────────────────────────────────────────────────────

export interface TestRunner {
  /** Command that runs ONE test file, with the path appended. */
  cmd: string;
  framework: string;
  /** Where tests live by convention, and the extension to use. */
  dir: string;
  ext: string;
}

/**
 * Work out how this repo runs tests, from what's actually in it.
 *
 * Ordered by specificity: a lockfile/manifest that NAMES the runner beats a
 * guess from the language. Returns null when the repo has no test setup at all —
 * the caller then decides whether to scaffold one.
 */
export function detectRunnerFromProbe(probe: string): TestRunner | null {
  const has = (s: string) => probe.includes(s);
  // Node: prefer whatever the package.json actually depends on.
  if (has("HAS_VITEST")) return { cmd: "npx vitest run", framework: "vitest", dir: "tests", ext: ".test.ts" };
  if (has("HAS_JEST")) return { cmd: "npx jest", framework: "jest", dir: "tests", ext: ".test.js" };
  if (has("HAS_PYTEST")) return { cmd: "python -m pytest -q", framework: "pytest", dir: "tests", ext: "_test.py" };
  if (has("HAS_GO")) return { cmd: "go test", framework: "go", dir: ".", ext: "_test.go" };
  if (has("HAS_DOTNET_TEST")) return { cmd: "dotnet test", framework: "dotnet", dir: "Tests", ext: "Tests.cs" };
  return null;
}

/** What we'd add to a repo that has no runner, per stack. Null = can't scaffold. */
export function scaffoldPlanFor(probe: string): { runner: TestRunner; steps: string[] } | null {
  if (probe.includes("HAS_PACKAGE_JSON")) {
    return {
      runner: { cmd: "npx vitest run", framework: "vitest", dir: "tests", ext: ".test.ts" },
      steps: [
        "npm install -D vitest@^3 2>&1 | tail -3",
        `node -e "const f='package.json',p=require('./'+f);p.scripts=p.scripts||{};if(!p.scripts.test||/no test specified/.test(p.scripts.test))p.scripts.test='vitest run';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\\n')"`,
        "mkdir -p tests",
      ],
    };
  }
  if (probe.includes("HAS_PYPROJECT") || probe.includes("HAS_REQUIREMENTS")) {
    return {
      runner: { cmd: "python -m pytest -q", framework: "pytest", dir: "tests", ext: "_test.py" },
      steps: ["python -m pip install pytest 2>&1 | tail -3", "mkdir -p tests"],
    };
  }
  return null; // .NET/Go project layouts are too opinionated to scaffold blind
}

/** One shell round-trip that answers every question detection needs. */
const PROBE_SCRIPT = `
[ -f package.json ] && echo HAS_PACKAGE_JSON
[ -f package.json ] && grep -q '"vitest"' package.json && echo HAS_VITEST
[ -f package.json ] && grep -q '"jest"' package.json && echo HAS_JEST
{ [ -f pytest.ini ] || [ -f pyproject.toml ] && grep -q pytest pyproject.toml 2>/dev/null; } && echo HAS_PYTEST
[ -f pyproject.toml ] && echo HAS_PYPROJECT
[ -f requirements.txt ] && echo HAS_REQUIREMENTS
[ -f go.mod ] && echo HAS_GO
ls *.sln */*.csproj 2>/dev/null | head -1 | grep -q . && echo HAS_DOTNET_TEST
echo PROBE_DONE`.trim();

// ── Verdicts ──────────────────────────────────────────────────────────

export type TestVerdict = "verifies" | "tautological" | "failing" | "broken";

export interface TestFileResult {
  path: string;
  criterion: string;
  redFailed: boolean;   // failed at the branch point (what we WANT)
  greenPassed: boolean; // passes with the implementation
  verdict: TestVerdict;
}

/**
 * Judge one generated test from its two runs. This is the whole point of the
 * feature, so it is a pure function and it is tested.
 */
export function judge(redFailed: boolean, greenPassed: boolean): TestVerdict {
  if (redFailed && greenPassed) return "verifies";      // exactly what we want
  if (!redFailed && greenPassed) return "tautological"; // passed before the change too
  if (redFailed && !greenPassed) return "failing";      // the interesting signal
  return "broken";                                       // passed at base, fails now → suspect
}

export interface QaReport {
  status: "verified" | "partial" | "failed" | "skipped";
  framework?: string;
  summary: string;
  kept: number;
  discarded: number;
  failing: number;
  commit?: string;
  results: TestFileResult[];
  scaffolded?: boolean;
}

/** The human-facing summary — what actually gets read. */
export function describeReport(r: QaReport, criteriaCount: number): string {
  if (r.status === "skipped") return `🧪 **QA skipped** — ${r.summary}`;
  const lines: string[] = [];
  const verified = r.results.filter((x) => x.verdict === "verifies");
  lines.push(
    r.failing > 0
      ? `⚠️ **QA: ${verified.length} of ${criteriaCount} acceptance criteria verified, ${r.failing} failing.**`
      : `🧪 **QA: ${verified.length} of ${criteriaCount} acceptance criteria verified by tests.**`,
  );
  if (verified.length) {
    lines.push("", ...verified.map((x) => `- ✅ ${x.criterion}`));
  }
  const failing = r.results.filter((x) => x.verdict === "failing" || x.verdict === "broken");
  if (failing.length) {
    lines.push("", "**Not passing — worth a look (the test may be wrong, not the code):**",
      ...failing.map((x) => `- ❌ ${x.criterion} \`${x.path}\``));
  }
  if (r.discarded) {
    lines.push("", `_${r.discarded} generated test${r.discarded === 1 ? "" : "s"} passed against the branch point too, so ${r.discarded === 1 ? "it was" : "they were"} discarded — ${r.discarded === 1 ? "it wasn't" : "they weren't"} testing this ticket._`);
  }
  if (r.commit) lines.push("", `Committed as \`${r.commit.slice(0, 7)}\` on the ticket's branch.`);
  return lines.join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────

export async function runTicketQa(
  ticketId: string,
  opts: { ownerId: string; llmUserId?: string; projectId: string },
): Promise<QaReport | null> {
  if (!isQaEnabled()) return null;
  try {
    return await run(ticketId, opts);
  } catch (err) {
    console.warn(`[qa-agent] ${ticketId} failed:`, (err as Error).message?.slice(0, 200));
    return null;
  }
}

async function run(ticketId: string, opts: { ownerId: string; llmUserId?: string; projectId: string }): Promise<QaReport | null> {
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project) return null;

  // Opt-in per project. Off by default: a second agent run per ticket is real money.
  if (((project as { qaMode?: string }).qaMode ?? "off") !== "tests") return null;

  const criteria = ((ticket.acceptanceCriteria as string[] | null) ?? []).filter(Boolean);
  if (!criteria.length) {
    await addLog(ticketId, "QA skipped — this ticket has no acceptance criteria to test against.", "command", opts.ownerId);
    return { status: "skipped", summary: "no acceptance criteria on the ticket", kept: 0, discarded: 0, failing: 0, results: [] };
  }

  const sb = await resolveSandbox(ticketId);
  if (!sb) {
    await addLog(ticketId, "QA skipped — the ticket's sandbox is gone, so there's nothing to test in.", "command", opts.ownerId);
    return { status: "skipped", summary: "no sandbox", kept: 0, discarded: 0, failing: 0, results: [] };
  }
  const { workspaceId, projectDir } = sb;
  const cwd = `${WORKING_DIR}/${projectDir}`;

  await addLog(ticketId, "🧪 QA: writing tests for this ticket's acceptance criteria…", "command", opts.ownerId);

  // 1. How does this repo run tests?
  const runnerInfo = await resolveRunner(project, workspaceId, cwd, ticketId, opts.ownerId);
  if (!runnerInfo) {
    await addLog(ticketId, "QA skipped — no test runner in this repo and its stack isn't one I can set up safely.", "command", opts.ownerId);
    return { status: "skipped", summary: "no test runner and none could be scaffolded", kept: 0, discarded: 0, failing: 0, results: [] };
  }
  const { runner, scaffolded } = runnerInfo;

  // 2. What did this ticket actually change? Tests are judged against that.
  const { anchorBranch } = await resolveTicketAnchor(ticket);
  const baseRef = `origin/${anchorBranch}`;
  const changed = await changedSourceFiles(workspaceId, cwd, baseRef);
  if (!changed.length) {
    await addLog(ticketId, "QA skipped — no source changes to test against the branch point.", "command", opts.ownerId);
    return { status: "skipped", summary: "no changed files vs the branch point", kept: 0, discarded: 0, failing: 0, results: [] };
  }

  // 3. Write the tests.
  const generated = await generateTests({
    ticket: { name: ticket.name, description: ticket.description ?? "", criteria },
    runner, changed, workspaceId, cwd, ownerId: opts.llmUserId ?? opts.ownerId, projectId: opts.projectId,
  });
  if (!generated.length) {
    await addLog(ticketId, "QA skipped — couldn't generate usable tests for these criteria.", "command", opts.ownerId);
    return { status: "skipped", summary: "no tests generated", kept: 0, discarded: 0, failing: 0, results: [] };
  }
  for (const t of generated) await writeFile(workspaceId, cwd, t.path, t.content);

  // 4. RED then GREEN — the server decides whether these tests mean anything.
  await addLog(ticketId, `🧪 QA: checking ${generated.length} test${generated.length === 1 ? "" : "s"} against the branch point…`, "command", opts.ownerId);
  const red = await runPhaseAtBase(workspaceId, cwd, baseRef, changed, generated.map((g) => g.path), runner);
  const green = await runPhase(workspaceId, cwd, generated.map((g) => g.path), runner);

  const results: TestFileResult[] = generated.map((g) => {
    const redFailed = red[g.path] === false;   // false = did not pass at base
    const greenPassed = green[g.path] === true;
    return { path: g.path, criterion: g.criterion, redFailed, greenPassed, verdict: judge(redFailed, greenPassed) };
  });

  // 5. Discard the tests that prove nothing; keep the rest.
  const discard = results.filter((r) => r.verdict === "tautological");
  for (const d of discard) await execOnWorkspace(workspaceId, `rm -f ${JSON.stringify(`${cwd}/${d.path}`)}`, { timeout: 30_000 }).catch(() => {});
  const kept = results.filter((r) => r.verdict !== "tautological");
  const failing = kept.filter((r) => r.verdict !== "verifies").length;

  const report: QaReport = {
    status: !kept.length ? "skipped" : failing ? "partial" : "verified",
    framework: runner.framework,
    summary: `${kept.length - failing} verified, ${failing} failing, ${discard.length} discarded`,
    kept: kept.length, discarded: discard.length, failing, results, scaffolded,
  };

  // 6. Commit the suite as its own commit on the ticket's branch.
  if (kept.length) {
    const sha = await commitTests(ticket, project, opts.ownerId, workspaceId, cwd, anchorBranch, kept.length);
    if (sha) report.commit = sha;
  }

  await db.update(projectTickets)
    .set({ details: { ...(ticket.details as Record<string, unknown> ?? {}), qaReport: report }, updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId))
    .catch(() => {});
  await addLog(ticketId, describeReport(report, criteria.length), "ai_response", opts.ownerId);
  return report;
}

// ── Steps ─────────────────────────────────────────────────────────────

/** The ticket's live sandbox + the directory its code is in. */
async function resolveSandbox(ticketId: string): Promise<{ workspaceId: string; projectDir: string } | null> {
  const [row] = await db.select().from(sandboxes)
    .where(eq(sandboxes.ticketId, ticketId))
    .orderBy(desc(sandboxes.updatedAt)).limit(1);
  if (!row?.magsWorkspaceId) return null;
  const projectDir = row.workspaceType === "ticket-worktree"
    ? `wt-ticket-${ticketId.slice(0, 12)}`   // shared preview VM: the ticket's worktree
    : "project";
  const probe = await execOnWorkspace(row.magsWorkspaceId,
    `test -d ${WORKING_DIR}/${projectDir}/.git || test -f ${WORKING_DIR}/${projectDir}/.git && echo DIR_OK`,
    { timeout: 45_000 }).catch(() => ({ output: "" }));
  if (!probe.output.includes("DIR_OK")) return null;
  return { workspaceId: row.magsWorkspaceId, projectDir };
}

async function resolveRunner(
  project: { id: string; testCommand?: string | null },
  workspaceId: string, cwd: string, ticketId: string, ownerId: string,
): Promise<{ runner: TestRunner; scaffolded?: boolean } | null> {
  const probe = (await execOnWorkspace(workspaceId, `cd ${cwd} && ${PROBE_SCRIPT}`, { timeout: 60_000 }).catch(() => ({ output: "" }))).output;
  const detected = detectRunnerFromProbe(probe);
  if (detected) {
    if (!project.testCommand) {
      await db.update(projects).set({ testCommand: detected.cmd, updatedAt: new Date() }).where(eq(projects.id, project.id)).catch(() => {});
    }
    return { runner: detected };
  }

  // Nothing to run tests with. Set one up — once per project, as its own commit,
  // and say so plainly: this changes the repo's tooling, not just its tests.
  const plan = scaffoldPlanFor(probe);
  if (!plan) return null;
  await addLog(ticketId, `🧪 QA: this repo has no test runner — setting up **${plan.runner.framework}** (one-off, committed separately).`, "command", ownerId);
  for (const step of plan.steps) {
    await execOnWorkspace(workspaceId, `cd ${cwd} && ${step}`, { timeout: 300_000 }).catch(() => {});
  }
  const verify = await execOnWorkspace(workspaceId, `cd ${cwd} && ${plan.runner.cmd} --version >/dev/null 2>&1 && echo RUNNER_OK || echo RUNNER_MISSING`, { timeout: 120_000 })
    .catch(() => ({ output: "" }));
  if (!verify.output.includes("RUNNER_OK")) {
    await addLog(ticketId, "QA: the test runner didn't install cleanly — skipping tests for this ticket.", "cli_error", ownerId);
    return null;
  }
  await db.update(projects).set({ testCommand: plan.runner.cmd, updatedAt: new Date() }).where(eq(projects.id, project.id)).catch(() => {});
  return { runner: plan.runner, scaffolded: true };
}

/** Source files this ticket changed relative to the branch point (tests excluded). */
async function changedSourceFiles(workspaceId: string, cwd: string, baseRef: string): Promise<string[]> {
  const r = await execOnWorkspace(workspaceId,
    `cd ${cwd} && git fetch --quiet origin 2>/dev/null; git diff --name-only ${baseRef}...HEAD 2>/dev/null | head -60`,
    { timeout: 90_000 }).catch(() => ({ output: "" }));
  return (r.output || "")
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((p) => !/(^|\/)(tests?|__tests__|spec)\//i.test(p) && !/\.(test|spec)\.[jt]sx?$|_test\.(py|go)$/i.test(p));
}

async function writeFile(workspaceId: string, cwd: string, path: string, content: string): Promise<void> {
  const b64 = Buffer.from(content).toString("base64");
  await execOnWorkspace(workspaceId,
    `cd ${cwd} && mkdir -p "$(dirname ${JSON.stringify(path)})" && echo ${b64} | base64 -d > ${JSON.stringify(path)}`,
    { timeout: 60_000 });
}

/** Run each test file, one at a time, and record pass/fail. */
async function runPhase(workspaceId: string, cwd: string, paths: string[], runner: TestRunner): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const p of paths) {
    const r = await execOnWorkspace(workspaceId,
      `cd ${cwd} && ${runner.cmd} ${JSON.stringify(p)} >/tmp/qa.log 2>&1 && echo QA_PASS || echo QA_FAIL`,
      { timeout: RUN_TIMEOUT_MS }).catch(() => ({ output: "QA_FAIL" }));
    out[p] = (r.output || "").includes("QA_PASS");
  }
  return out;
}

/**
 * The RED phase: put the changed source files back to their branch-point state,
 * run the tests, then restore. A test that passes here isn't testing this ticket.
 * Restoration is in a finally-equivalent: leaving the tree on base would be far
 * worse than a missing verdict.
 */
async function runPhaseAtBase(
  workspaceId: string, cwd: string, baseRef: string,
  changed: string[], testPaths: string[], runner: TestRunner,
): Promise<Record<string, boolean>> {
  const quoted = changed.map((f) => JSON.stringify(f)).join(" ");
  // Files ADDED by this ticket don't exist at base — checkout fails for those, so
  // move them aside instead; either way the feature is absent for the run.
  await execOnWorkspace(workspaceId,
    `cd ${cwd} && for f in ${quoted}; do git checkout ${baseRef} -- "$f" 2>/dev/null || mv "$f" "$f.qa-hidden" 2>/dev/null; done; echo BASE_READY`,
    { timeout: 120_000 }).catch(() => {});
  try {
    return await runPhase(workspaceId, cwd, testPaths, runner);
  } finally {
    await execOnWorkspace(workspaceId,
      `cd ${cwd} && for f in ${quoted}; do [ -f "$f.qa-hidden" ] && mv "$f.qa-hidden" "$f"; git checkout HEAD -- "$f" 2>/dev/null; done; echo RESTORED`,
      { timeout: 120_000 }).catch(() => {});
  }
}

async function commitTests(
  ticket: { id: string; ticketKey: string | null; name: string; githubBranch: string | null; epicId?: string | null; assigneeId?: string | null },
  project: { id: string; ownerId: string; repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null },
  ownerId: string, workspaceId: string, cwd: string, anchorBranch: string, count: number,
): Promise<string | undefined> {
  const { gitUserId } = resolveGitActor(project as never, ticket.assigneeId ?? ownerId);
  const auth = await resolveRepoAuth(project, gitUserId);
  if (!auth || !ticket.githubBranch) return undefined;
  try {
    const { sha } = await commitAndPush({
      workspaceId, projectDir: cwd,
      commitMessage: `test(${ticket.ticketKey ?? "ticket"}): cover ${count} acceptance criteri${count === 1 ? "on" : "a"}`,
      featureBranch: ticket.githubBranch,
      repoUrl: auth.repoUrl, githubToken: auth.token, tokenUser: auth.tokenUser,
    });
    await mergeToAnchor({
      workspaceId, projectDir: cwd, featureBranch: ticket.githubBranch,
      repoUrl: auth.repoUrl, githubToken: auth.token, tokenUser: auth.tokenUser,
      targetBranch: anchorBranch, baseBranch: anchorBranch,
    }).catch(() => {});
    return sha;
  } catch {
    return undefined; // the report still stands; the tests just didn't land
  }
}

// ── Generation ────────────────────────────────────────────────────────

interface GeneratedTest { path: string; content: string; criterion: string }

async function generateTests(args: {
  ticket: { name: string; description: string; criteria: string[] };
  runner: TestRunner;
  changed: string[];
  workspaceId: string;
  cwd: string;
  ownerId: string;
  projectId: string;
}): Promise<GeneratedTest[]> {
  const model = await pickModel(args.ownerId, args.projectId);
  if (!model) return [];

  // Show the model the code — a test that doesn't compile is useless, and the
  // red/green harness is what protects us from tautologies, not blindness.
  const excerpts: string[] = [];
  for (const f of args.changed.slice(0, 8)) {
    const r = await execOnWorkspace(args.workspaceId, `cd ${args.cwd} && head -c 6000 ${JSON.stringify(f)}`, { timeout: 45_000 }).catch(() => ({ output: "" }));
    if (r.output?.trim()) excerpts.push(`--- ${f}\n${r.output}`);
  }

  const prompt = `Write ${args.runner.framework} tests for a ticket that was just implemented.

## Ticket
${args.ticket.name}

${args.ticket.description.slice(0, 2000)}

## Acceptance criteria — ONE test file per criterion, in this order
${args.ticket.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## The code that was changed
${excerpts.join("\n\n").slice(0, 24000)}

## Rules
- Test the BEHAVIOUR the acceptance criterion describes, not the implementation's shape.
  Your tests are run against the code BEFORE this ticket as well; one that passes there
  is thrown away as worthless, so assert the thing the ticket actually added.
- UNIT tests only: no network, no real database, no running server. Mock at the boundary.
- Each file must run standalone under \`${args.runner.cmd} <file>\`.
- Import from real paths in the code above. Do not invent modules.
- No snapshot tests, no sleeps, nothing time-dependent.

Return ONLY a JSON array, at most ${MAX_TEST_FILES} items:
[{"path":"${args.runner.dir}/<name>${args.runner.ext}","criterion":"<the criterion, verbatim>","content":"<the whole file>"}]`;

  try {
    const { text } = await generateText({ model, prompt, maxOutputTokens: 8000 });
    return parseGenerated(text).slice(0, MAX_TEST_FILES);
  } catch (e) {
    console.warn("[qa-agent] generation failed:", (e as Error).message?.slice(0, 160));
    return [];
  }
}

/** Pull the JSON array out of a model reply that may be fenced or chatty. */
export function parseGenerated(text: string): GeneratedTest[] {
  const raw = text ?? "";
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is GeneratedTest =>
        !!x && typeof x === "object" &&
        typeof (x as GeneratedTest).path === "string" &&
        typeof (x as GeneratedTest).content === "string" &&
        !!(x as GeneratedTest).content.trim() &&
        // Never let a generated path escape the repo.
        !(x as GeneratedTest).path.includes("..") &&
        !(x as GeneratedTest).path.startsWith("/"))
      .map((x) => ({ path: x.path, content: x.content, criterion: String(x.criterion ?? "").trim() || x.path }));
  } catch {
    return [];
  }
}

async function pickModel(ownerId: string, projectId: string) {
  try {
    const { selectedSubscriptionModel } = await import("./subscription-execution.ts");
    const subscription = await selectedSubscriptionModel(ownerId, projectId);
    if (subscription) return subscription;
    const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, ownerId));
    const keys = await teamApiKeys(ownerId, projectId);
    const modelKey = sel?.selectedModel ?? DEFAULT_MODEL_KEY;
    return getModel(modelKey, keys ? {
      anthropic: keys.anthropicApiKey ?? undefined, openai: keys.openaiApiKey ?? undefined,
      google: keys.googleApiKey ?? undefined, kimi: keys.kimiApiKey ?? undefined,
      deepseek: keys.deepseekApiKey ?? undefined, glm: keys.glmApiKey ?? undefined,
    } : undefined);
  } catch {
    return null;
  }
}
