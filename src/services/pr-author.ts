/**
 * PR authoring — an agent writes the change request's description by reading the code
 * against what the ticket actually asked for.
 *
 * A PR body assembled from the commit list tells a reviewer nothing they couldn't get
 * from `git log`. The useful question is the one a reviewer actually has: does this do
 * what was specified, and where doesn't it? So the agent gets the ticket's requirements
 * and acceptance criteria, the epic's documents (PRD, technical analysis, design), and a
 * shell in the sandbox to read the real diff and the surrounding code — then writes up
 * what changed AND flags anything specified but missing.
 *
 * It never opens the request itself: it returns text, and the caller creates the PR/MR.
 * Same split as the merge resolver — the model produces judgement, the system performs
 * the side effect.
 */
import { z } from "zod";
import { generateText, stepCountIs, tool, zodSchema, type LanguageModel } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { execOnWorkspace } from "./mags.ts";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { epicDocuments } from "../db/schema/epic-documents.ts";

export interface AuthorPrInput {
  workspaceId: string;
  projectDir: string;
  /** Internal project id. */
  projectId: string;
  ticketId: string;
  featureBranch: string;
  targetBranch: string;
  /** Whatever the person raising it wants the reviewer to know. Carried through verbatim. */
  comment?: string;
  model: LanguageModel;
  onLog?: (line: string) => void;
}

export interface AuthorPrResult {
  title: string;
  body: string;
}

/** Documents are long; a PRD can be tens of thousands of characters. Give the agent the
 *  head of each — enough to know what was asked for — rather than blowing the context on
 *  one document and losing the diff. */
const DOC_CHARS = 6000;
const MAX_DOCS = 4;

export async function authorPullRequest(input: AuthorPrInput): Promise<AuthorPrResult> {
  const { workspaceId, projectDir, projectId, ticketId, featureBranch, targetBranch, model } = input;
  const log = input.onLog ?? (() => {});

  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId));
  if (!ticket) throw new Error("Ticket not found");

  // The documents this work was specified by: the epic's own drafts plus anything linked
  // to it (typically the master PRD). Ordered so a technical analysis or design doc — the
  // ones with the acceptance detail — win the budget over a long product PRD.
  const owned = ticket.epicId
    ? await db.select({ id: projectFiles.id, name: projectFiles.name, fileType: projectFiles.fileType, content: projectFiles.content })
        .from(projectFiles)
        .where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.epicId, ticket.epicId), eq(projectFiles.isActive, true)))
    : [];
  const linkedIds = ticket.epicId
    ? (await db.select({ fileId: epicDocuments.fileId }).from(epicDocuments).where(eq(epicDocuments.epicId, ticket.epicId))).map((r) => r.fileId)
    : [];
  const linked = linkedIds.length
    ? await db.select({ id: projectFiles.id, name: projectFiles.name, fileType: projectFiles.fileType, content: projectFiles.content })
        .from(projectFiles).where(inArray(projectFiles.id, linkedIds))
    : [];
  const seen = new Set<string>();
  const rank = (t: string) => (/tech/i.test(t) ? 0 : /design/i.test(t) ? 1 : /prd/i.test(t) ? 2 : 3);
  const docs = [...owned, ...linked]
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
    .sort((a, b) => rank(a.fileType) - rank(b.fileType))
    .slice(0, MAX_DOCS);

  const docBlock = docs.length
    ? docs.map((d) => `### ${d.name} (${d.fileType})\n${(d.content ?? "").slice(0, DOC_CHARS)}`).join("\n\n")
    : "(no documents linked to this ticket's epic)";

  const criteria = Array.isArray(ticket.acceptanceCriteria) && ticket.acceptanceCriteria.length
    ? (ticket.acceptanceCriteria as unknown[]).map((c) => `- ${typeof c === "string" ? c : JSON.stringify(c)}`).join("\n")
    : "(none recorded)";

  const sh = async (script: string, timeout = 120_000) => {
    const b64 = Buffer.from(script).toString("base64");
    const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout })
      .catch((e) => ({ output: `EXEC_FAILED: ${(e as Error).message}`, exitCode: 1 }));
    return { output: r.output ?? "", exitCode: r.exitCode ?? 0 };
  };

  // The shape of the change, up front, so the agent starts from facts rather than
  // spending its first turns discovering what it's even looking at.
  log("Reading the change…");
  const shape = await sh(`
cd "${projectDir}" 2>/dev/null || exit 1
git fetch --prune origin >/dev/null 2>&1
echo "=== COMMITS ==="
git log --format='%h %s' origin/${targetBranch}..origin/${featureBranch} 2>/dev/null | head -20
echo "=== FILES ==="
git diff --stat origin/${targetBranch}...origin/${featureBranch} 2>/dev/null | tail -40`, 90_000);

  const tools = {
    run: tool({
      description:
        "Run ONE read-only shell command in the repo to inspect the change. Use `git diff origin/" +
        targetBranch + "...origin/" + featureBranch + " -- <path>` to read a file's changes, `cat`/`sed -n` to read a file in " +
        "full for context, `grep -rn` to check whether something specified actually exists in the code. " +
        "Returns exit code + output. Read-only: do not modify, commit, push or build anything.",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("One read-only shell command, e.g. `git diff origin/main...origin/feature/x -- src/Program.cs` or `grep -rn \"GenerateAsync\" src`."),
      })),
      execute: async ({ command }: { command: string }) => {
        // Read-only by construction: this agent exists to describe the change, not touch it.
        if (/\b(git\s+(commit|push|merge|rebase|reset|checkout|switch|apply|clean)|rm|mv|cp|tee|dotnet|npm|yarn|pnpm|make)\b/.test(command) || />/.test(command)) {
          return { exitCode: 1, output: "Refused: this tool is read-only. Use git diff / git show / cat / grep to inspect." };
        }
        log(`  pr$ ${command.slice(0, 120)}`);
        const r = await sh(`cd "${projectDir}" && ${command}`, 90_000);
        return { exitCode: r.exitCode, output: r.output.slice(-6000) || "(no output)" };
      },
    }),
  };

  log("Analysing the change against the ticket and its documents…");
  const run = await generateText({
    model,
    tools,
    stopWhen: stepCountIs(24),
    system:
      `You are writing the description for a change request (a PR/MR) that a human will review.\n\n` +
      `You have the ticket that specified the work, the documents it was specified by, and a read-only ` +
      `shell in the sandbox holding the code. Read enough of the actual diff to describe it truthfully — ` +
      `do not paraphrase the commit messages and call it a description.\n\n` +
      `The reviewer's real question is "does this do what we asked, and where doesn't it?". So:\n` +
      `- Describe what the change ACTUALLY does, in terms of behaviour, not file names.\n` +
      `- Check the acceptance criteria and the documents against the code. If something specified is ` +
      `MISSING, partially done, or done differently, say so plainly — that is the most valuable part of ` +
      `your output, and a reviewer who finds it themselves after you claimed completeness will not trust ` +
      `you again. Verify with grep rather than assuming.\n` +
      `- Call out anything risky: schema changes, config or secrets, auth, deletions, or anything touching ` +
      `code outside this ticket's scope.\n` +
      `- Do not invent testing you did not do. You cannot run the app.\n\n` +
      `Reply in EXACTLY this format, plain markdown, no preamble:\n\n` +
      `TITLE: <one line, imperative, under 72 chars>\n` +
      `---\n` +
      `## What this does\n<2-5 bullets, behaviour first>\n\n` +
      `## Against the spec\n<bullet per acceptance criterion or documented requirement: met / partial / ` +
      `missing, with the evidence. If nothing was specified, say so.>\n\n` +
      `## Risks & review notes\n<bullets; "none obvious" is a valid answer if you actually checked>`,
    prompt:
      `Change request: \`${featureBranch}\` → \`${targetBranch}\`\n\n` +
      `## Ticket ${ticket.ticketKey ?? ""}: ${ticket.name}\n${(ticket.description ?? "").slice(0, 8000)}\n\n` +
      `## Acceptance criteria\n${criteria}\n\n` +
      `## Documents this was specified by\n${docBlock}\n\n` +
      `## Shape of the change\n${shape.output.slice(0, 4000)}\n\n` +
      (input.comment ? `## Note from the person raising it\n${input.comment}\n\n` : "") +
      `Inspect the diff with the tool, then write the description.`,
  }).catch((e) => {
    log(`PR author agent errored: ${(e as Error).message?.slice(0, 160)}`);
    return null;
  });

  const text = (run?.text ?? "").trim();
  // Fall back to something honest rather than failing the whole action if the model
  // wandered off-format — a PR with a thin description beats no PR.
  const titleMatch = text.match(/^TITLE:\s*(.+)$/m);
  const title = (titleMatch?.[1] ?? `${ticket.ticketKey ? ticket.ticketKey + ": " : ""}${ticket.name}`).trim().slice(0, 120);
  let body = text.includes("---") ? text.slice(text.indexOf("---") + 3).trim() : text;
  if (!body) {
    body = `## What this does\n${(ticket.description ?? ticket.name).slice(0, 2000)}\n\n_(The analysis agent produced no description — this is the ticket text.)_`;
  }
  if (input.comment) body += `\n\n---\n\n**From the author:** ${input.comment}`;
  body += `\n\n<sub>Raised from LFG · ticket ${ticket.ticketKey ?? ticketId}${docs.length ? ` · reviewed against ${docs.map((d) => d.name).join(", ")}` : ""}</sub>`;

  log(`Description written: ${title}`);
  return { title, body };
}
