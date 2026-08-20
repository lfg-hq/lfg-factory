import { db } from "../config/db.ts";
import { epics } from "../db/schema/epics.ts";
import { projects } from "../db/schema/projects.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { epicDocuments } from "../db/schema/epic-documents.ts";
import { eq, and, sql, inArray, ne, isNull } from "drizzle-orm";
import { derivePrefix } from "../utils/ticket-keys.ts";
import { resolveRepoAuth } from "./repo-auth.ts";
import {
  LEGACY_ANCHOR_BRANCH,
  getDefaultBranch,
  getRemoteBranchSha,
  createRemoteBranch,
} from "./git.ts";

export { LEGACY_ANCHOR_BRANCH };

export type EpicStatus =
  | "draft"
  | "building"
  | "in_review"
  | "approved"
  | "merged"
  | "rejected";

/** Statuses where the epic's code has NOT been accepted by the client yet. */
export const UNAPPROVED_STATUSES: EpicStatus[] = ["draft", "building", "in_review"];

export type Epic = typeof epics.$inferSelect;

// ── Naming ───────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "epic";
}

/** `epic/pro-e3-billing-rework` — readable in `git branch` and in a PR list. */
export function epicBranchName(epicKey: string, name: string): string {
  return `epic/${epicKey.toLowerCase()}-${slugify(name)}`;
}

/**
 * Atomically generate the next epic key for a project, e.g. "PRO-E1".
 * Uses its own counter so epic keys never collide with ticket keys.
 */
export async function nextEpicKey(projectId: string, projectName: string): Promise<string> {
  const prefix = derivePrefix(projectName);
  const [updated] = await db
    .update(projects)
    .set({ epicCounter: sql`${projects.epicCounter} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ epicCounter: projects.epicCounter });
  return `${prefix}-E${updated?.epicCounter ?? 1}`;
}

// ── Creation ─────────────────────────────────────────────────────────

export interface CreateEpicInput {
  projectId: string;
  name: string;
  goal?: string;
  createdById?: string | null;
  conversationId?: string | null;
  /**
   * Set ONLY when this epic must deliberately build on another epic that the
   * client hasn't approved yet. Leave undefined for the normal case — cut from
   * clean `main`, which is what stops unapproved work leaking between features.
   */
  parentEpicId?: string | null;
  /**
   * Override what the epic branch is cut from. Used when ADOPTING tickets that
   * were already built and merged under the old global anchor — the epic takes
   * over `lfg-agent`'s current head so the work that already exists ends up
   * inside the epic, instead of a branch off main that's missing all of it.
   */
  baseBranchOverride?: string | null;
}

/**
 * Create an epic and cut its branch.
 *
 * The branch is created over the provider's REST API (no VM needed) and its base
 * SHA is PINNED on the row, so the epic's starting point can't drift while it's
 * in flight. If the project has no repo/token yet — a brand-new project whose
 * repo is auto-created on first build — the branch is left unmaterialized and
 * gets created lazily by the ticket build, from the same recorded base branch.
 */
export async function createEpic(input: CreateEpicInput): Promise<Epic> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) throw new Error(`Project not found: ${input.projectId}`);

  const epicKey = await nextEpicKey(project.id, project.name);
  const branch = epicBranchName(epicKey, input.name);

  // A stacked epic is cut from its parent's branch, not from main. Recording it
  // is what lets the merge guard block promotion until the parent lands.
  let parent: Epic | null = null;
  if (input.parentEpicId) {
    parent = (await getEpic(input.parentEpicId)) ?? null;
  }

  let baseBranch = input.baseBranchOverride || parent?.branch || "main";
  let baseSha: string | null = null;

  const auth = await resolveRepoAuth(project, project.ownerId);
  if (auth) {
    try {
      if (!parent && !input.baseBranchOverride) baseBranch = await getDefaultBranch(auth);
      const sha = await getRemoteBranchSha({ ...auth, branch: baseBranch });
      if (sha) {
        const created = await createRemoteBranch({ ...auth, branch, fromSha: sha });
        baseSha = sha;
        console.log(
          `[epics] ${epicKey} branch ${branch} ${created.created ? "created" : "already existed"} from ${baseBranch}@${sha.slice(0, 7)}`
        );
      } else {
        // Empty repo (no commits yet) — nothing to branch from. Lazy path handles it.
        console.log(`[epics] ${epicKey}: base branch ${baseBranch} has no head yet; deferring branch creation`);
      }
    } catch (e) {
      console.warn(`[epics] ${epicKey}: branch creation deferred — ${(e as Error).message?.slice(0, 200)}`);
    }
  }

  const [row] = await db
    .insert(epics)
    .values({
      projectId: project.id,
      epicKey,
      name: input.name,
      goal: input.goal ?? "",
      status: "draft",
      createdById: input.createdById ?? null,
      conversationId: input.conversationId ?? null,
      branch,
      baseBranch,
      baseSha,
      parentEpicId: parent?.id ?? null,
    })
    .returning();

  return row!;
}

/**
 * Move existing tickets into an epic.
 *
 * Grouping is retroactive; git is not. A ticket that already merged under the
 * old global anchor keeps the branch it was built on — what changes is that the
 * epic now owns it for review and approval, and any ticket built FROM NOW ON
 * cascades on the epic's branch. That's why adoption pairs with
 * `baseBranchOverride`: cut the epic from the anchor that already holds the work.
 *
 * Returns the tickets actually moved (ids outside the project are ignored).
 */
export async function assignTicketsToEpic(
  epicId: string,
  ticketIds: string[]
): Promise<{ moved: number; ticketIds: string[] }> {
  const epic = await getEpic(epicId);
  if (!epic) throw new Error(`Epic not found: ${epicId}`);
  const ids = [...new Set(ticketIds.filter(Boolean))];
  if (!ids.length) return { moved: 0, ticketIds: [] };

  const rows = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.projectId, epic.projectId), inArray(projectTickets.id, ids)));
  if (!rows.length) return { moved: 0, ticketIds: [] };

  const valid = rows.map((r) => r.id);
  await db
    .update(projectTickets)
    .set({ epicId, updatedAt: new Date() })
    .where(inArray(projectTickets.id, valid));

  console.log(`[epics] ${epic.epicKey}: adopted ${valid.length} ticket(s)`);
  return { moved: valid.length, ticketIds: valid };
}

/** Tickets in this project that don't belong to any epic yet. */
export async function listUnassignedTickets(projectId: string) {
  return db
    .select({
      id: projectTickets.id,
      ticketKey: projectTickets.ticketKey,
      name: projectTickets.name,
      status: projectTickets.status,
      githubMergeStatus: projectTickets.githubMergeStatus,
      createdAt: projectTickets.createdAt,
    })
    .from(projectTickets)
    .where(and(eq(projectTickets.projectId, projectId), isNull(projectTickets.epicId)));
}

/**
 * Pull work that was built BEFORE this epic existed onto the epic's branch.
 *
 * A ticket built under the old global anchor has its code on its own feature
 * branch, merged into `lfg-agent` — not into the epic it was later adopted into.
 * Rather than deleting the branch and rebuilding (which re-runs the agent and can
 * produce different code), replay the merge: feature branch → epic branch, over
 * the provider API. Idempotent — a ticket already contained in the epic branch
 * reports "already" and is left alone.
 */
export async function syncEpicBranch(
  epicId: string,
  actingUserId: string,
  opts?: { force?: boolean }
): Promise<{
  epicBranch: string | null;
  results: Array<{
    ticketKey: string | null;
    branch: string;
    status: string;
    detail?: string;
    extraCommits?: Array<{ sha: string; message: string }>;
  }>;
}> {
  const epic = await getEpic(epicId);
  if (!epic) throw new Error(`Epic not found: ${epicId}`);
  if (!epic.branch) return { epicBranch: null, results: [] };

  const [project] = await db.select().from(projects).where(eq(projects.id, epic.projectId)).limit(1);
  if (!project) throw new Error(`Project not found: ${epic.projectId}`);

  const auth = await resolveRepoAuth(project, actingUserId);
  if (!auth) throw new Error("No connected repo or credentials.");

  const tickets = await db
    .select({
      ticketKey: projectTickets.ticketKey,
      name: projectTickets.name,
      branch: projectTickets.githubBranch,
    })
    .from(projectTickets)
    .where(eq(projectTickets.epicId, epicId));

  const { mergeBranchViaApi, compareBranches } = await import("./git.ts");
  const results: Array<{
    ticketKey: string | null;
    branch: string;
    status: string;
    detail?: string;
    extraCommits?: Array<{ sha: string; message: string }>;
  }> = [];

  // Commit messages the executor writes for a ticket's own work.
  const ownsCommit = (msg: string, t: { ticketKey: string | null; name: string }) =>
    (t.ticketKey ? msg.toLowerCase().includes(t.ticketKey.toLowerCase()) : false) ||
    msg.toLowerCase().includes(t.name.toLowerCase().slice(0, 40));

  for (const t of tickets) {
    if (!t.branch) continue; // never built — nothing on a branch to bring over

    // A branch cut from the old global anchor carries that anchor's whole
    // history. Merging it into an epic cut from main would import every OTHER
    // feature's unapproved work too — the exact leak epics exist to stop. So
    // look before merging, and refuse when the branch brings in more than its
    // own ticket's commits.
    const cmp = await compareBranches({
      provider: auth.provider,
      owner: auth.owner,
      repo: auth.repo,
      token: auth.token,
      base: epic.branch,
      head: t.branch,
    }).catch(() => null);

    if (cmp && cmp.aheadBy === 0) {
      results.push({ ticketKey: t.ticketKey, branch: t.branch, status: "already" });
      continue;
    }

    const foreign = cmp ? cmp.commits.filter((c) => !ownsCommit(c.message, t)) : [];
    if (foreign.length && !opts?.force) {
      results.push({
        ticketKey: t.ticketKey,
        branch: t.branch,
        status: "would_contaminate",
        detail:
          `${t.branch} was cut from \`${LEGACY_ANCHOR_BRANCH}\`, so merging it would also bring ` +
          `${foreign.length} commit(s) belonging to other work into ${epic.epicKey}.`,
        extraCommits: foreign.slice(0, 20),
      });
      continue;
    }

    const r = await mergeBranchViaApi({
      provider: auth.provider,
      owner: auth.owner,
      repo: auth.repo,
      token: auth.token,
      base: epic.branch,
      head: t.branch,
      message: `Adopt ${t.ticketKey ?? t.name} into ${epic.epicKey}`,
    }).catch((e) => ({ status: "conflict" as const, detail: (e as Error).message?.slice(0, 200) }));
    results.push({ ticketKey: t.ticketKey, branch: t.branch, status: r.status, detail: r.detail });
  }

  console.log(`[epics] ${epic.epicKey}: synced ${results.length} branch(es) into ${epic.branch}`);
  return { epicBranch: epic.branch, results };
}

// ── Lookups ──────────────────────────────────────────────────────────

export async function getEpic(epicId: string): Promise<Epic | undefined> {
  const [row] = await db.select().from(epics).where(eq(epics.id, epicId)).limit(1);
  return row;
}

export async function listEpics(projectId: string): Promise<Epic[]> {
  return db.select().from(epics).where(eq(epics.projectId, projectId));
}

/** Epics in this project whose code the client has not accepted yet. */
export async function listUnapprovedEpics(projectId: string, excludeEpicId?: string): Promise<Epic[]> {
  const where = excludeEpicId
    ? and(
        eq(epics.projectId, projectId),
        inArray(epics.status, UNAPPROVED_STATUSES),
        ne(epics.id, excludeEpicId)
      )
    : and(eq(epics.projectId, projectId), inArray(epics.status, UNAPPROVED_STATUSES));
  return db.select().from(epics).where(where);
}

// ── The branch a ticket lives on ─────────────────────────────────────

export interface TicketAnchor {
  /** Branch the ticket is cut FROM and merged back INTO. */
  anchorBranch: string;
  /** What the anchor itself is cut from, if it has to be created. */
  baseBranch: string;
  epic: Epic | null;
}

/**
 * Resolve which branch a ticket cascades on.
 *
 * With an epic: the epic's own branch, so the ticket sees the earlier tickets in
 * ITS delivery unit and nothing else. Without one (tickets created before epics
 * existed): the legacy global `lfg-agent` anchor, preserving old behaviour —
 * including its leakage. New work should always carry an epicId.
 */
export async function resolveTicketAnchor(ticket: {
  epicId?: string | null;
}): Promise<TicketAnchor> {
  if (ticket.epicId) {
    const epic = await getEpic(ticket.epicId);
    if (epic?.branch) {
      return {
        anchorBranch: epic.branch,
        baseBranch: epic.baseBranch || "main",
        epic,
      };
    }
  }
  return { anchorBranch: LEGACY_ANCHOR_BRANCH, baseBranch: "main", epic: null };
}

// ── State transitions ────────────────────────────────────────────────

/**
 * Move an epic to `building` the first time one of its tickets starts. No-op once
 * the epic has moved past building, so a re-run of an old ticket can't drag an
 * approved epic backwards.
 */
export async function markEpicBuilding(epicId: string | null | undefined): Promise<void> {
  if (!epicId) return;
  await db
    .update(epics)
    .set({ status: "building", updatedAt: new Date() })
    .where(and(eq(epics.id, epicId), eq(epics.status, "draft")))
    .catch((e) => console.warn(`[epics] markEpicBuilding failed:`, (e as Error).message));
}

/**
 * Record the repo-relative paths an epic has touched. Used to detect when a new
 * epic overlaps an unapproved one — the only case where stacking is worth
 * surfacing to a human.
 */
export async function recordEpicFilesTouched(
  epicId: string | null | undefined,
  files: string[]
): Promise<void> {
  if (!epicId || !files.length) return;
  const epic = await getEpic(epicId);
  if (!epic) return;
  const existing = new Set((epic.filesTouched as string[] | null) ?? []);
  for (const f of files) if (f) existing.add(f);
  await db
    .update(epics)
    .set({ filesTouched: [...existing], updatedAt: new Date() })
    .where(eq(epics.id, epicId))
    .catch((e) => console.warn(`[epics] recordEpicFilesTouched failed:`, (e as Error).message));
}

// ── Approval + promotion to main ─────────────────────────────────────

export interface MergeBlocker {
  code: "not_approved" | "no_branch" | "parent_unmerged" | "no_repo";
  message: string;
}

/**
 * The merge guard. Nothing reaches `main` unless the client accepted THIS epic —
 * and, if it was deliberately stacked on another, unless that one landed first.
 * This is the check that makes "merge my feature" stop meaning "ship six
 * unverified tickets somebody else wrote".
 */
export async function getMergeBlockers(epic: Epic): Promise<MergeBlocker[]> {
  const blockers: MergeBlocker[] = [];

  if (epic.status !== "approved") {
    blockers.push({
      code: "not_approved",
      message:
        epic.status === "merged"
          ? `${epic.epicKey} has already been merged to ${epic.baseBranch}.`
          : `${epic.epicKey} hasn't been approved yet (it's ${epic.status.replace("_", " ")}).`,
    });
  }

  if (!epic.branch) {
    blockers.push({ code: "no_branch", message: `${epic.epicKey} has no branch to merge.` });
  }

  if (epic.parentEpicId) {
    const parent = await getEpic(epic.parentEpicId);
    if (parent && parent.status !== "merged") {
      blockers.push({
        code: "parent_unmerged",
        message:
          `${epic.epicKey} was built on top of ${parent.epicKey} (${parent.name}), which hasn't ` +
          `gone live yet. Merging now would take that unapproved work with it — land ${parent.epicKey} first.`,
      });
    }
  }

  return blockers;
}

/** Client accepted the epic. Does NOT merge — promotion is a separate, explicit act. */
export async function approveEpic(
  epicId: string,
  approvedById: string,
  notes?: string
): Promise<Epic> {
  const epic = await getEpic(epicId);
  if (!epic) throw new Error(`Epic not found: ${epicId}`);
  if (epic.status === "merged") return epic;

  const [row] = await db
    .update(epics)
    .set({
      status: "approved",
      approvedById,
      approvedAt: new Date(),
      rejectedAt: null,
      reviewNotes: notes ?? epic.reviewNotes ?? "",
      updatedAt: new Date(),
    })
    .where(eq(epics.id, epicId))
    .returning();
  console.log(`[epics] ${epic.epicKey} approved by ${approvedById}`);
  return row!;
}

/**
 * Client said no. The branch is left in place (nothing is force-deleted) but the
 * epic is out of the promotion path, and any epic stacked on it stays blocked.
 */
export async function rejectEpic(
  epicId: string,
  rejectedById: string,
  notes?: string
): Promise<Epic> {
  const epic = await getEpic(epicId);
  if (!epic) throw new Error(`Epic not found: ${epicId}`);

  const [row] = await db
    .update(epics)
    .set({
      status: "rejected",
      rejectedAt: new Date(),
      approvedById: null,
      approvedAt: null,
      reviewNotes: notes ?? epic.reviewNotes ?? "",
      updatedAt: new Date(),
    })
    .where(eq(epics.id, epicId))
    .returning();
  console.log(`[epics] ${epic.epicKey} rejected by ${rejectedById}`);
  return row!;
}

/**
 * Epics stacked on this one — they inherited its code, so a rejection or a
 * pending approval here holds them back too.
 */
export async function listDependentEpics(epicId: string): Promise<Epic[]> {
  return db.select().from(epics).where(eq(epics.parentEpicId, epicId));
}

/**
 * Promote an APPROVED epic to main: open a PR from the epic branch and merge it,
 * then fold the epic's docs into the project's master docs.
 *
 * Docs merge when code merges — that's the point. An epic's scope/tech docs
 * describe unapproved work while it's in flight, so they live at epic scope; on
 * promotion they're copied to project scope where the client reads them. (The
 * copy is verbatim; genuinely rewriting the master PRD around a delta is a model
 * job, not a database one, so that stays a deliberate follow-up.)
 */
export async function promoteEpicToMain(
  epicId: string,
  actingUserId: string
): Promise<{ merged: boolean; prUrl?: string; prNumber?: number; blockers?: MergeBlocker[] }> {
  const epic = await getEpic(epicId);
  if (!epic) throw new Error(`Epic not found: ${epicId}`);

  const blockers = await getMergeBlockers(epic);
  if (blockers.length) return { merged: false, blockers };

  const [project] = await db.select().from(projects).where(eq(projects.id, epic.projectId)).limit(1);
  if (!project) throw new Error(`Project not found: ${epic.projectId}`);

  const auth = await resolveRepoAuth(project, actingUserId);
  if (!auth) {
    return {
      merged: false,
      blockers: [{ code: "no_repo", message: "No connected repo or credentials to merge with." }],
    };
  }

  const { createPullRequest, mergePullRequest } = await import("./git.ts");
  const targetBranch = epic.baseBranch || "main";

  const { prNumber, prUrl } = await createPullRequest({
    repoOwner: auth.owner,
    repoName: auth.repo,
    featureBranch: epic.branch!,
    targetBranch,
    title: `${epic.epicKey}: ${epic.name}`,
    body:
      `${epic.goal || ""}\n\n` +
      `Approved epic — every ticket in it was built on \`${epic.branch}\`, cut from ` +
      `\`${targetBranch}\`${epic.baseSha ? `@${epic.baseSha.slice(0, 7)}` : ""}.`,
    githubToken: auth.token,
  });

  await db
    .update(epics)
    .set({ prNumber, prUrl, updatedAt: new Date() })
    .where(eq(epics.id, epicId));

  // GitLab MRs aren't merged through this path — hand back the MR to merge there.
  if (auth.provider !== "github") {
    return { merged: false, prNumber, prUrl };
  }

  const { mergeCommitSha } = await mergePullRequest({
    repoOwner: auth.owner,
    repoName: auth.repo,
    prNumber,
    githubToken: auth.token,
  });

  await db
    .update(epics)
    .set({ status: "merged", mergeCommitSha, mergedAt: new Date(), updatedAt: new Date() })
    .where(eq(epics.id, epicId));

  // Docs are LINKED, not owned, so there is nothing to move on approval — they
  // were always readable in the project's Docs tab.

  console.log(`[epics] ${epic.epicKey} merged to ${targetBranch} (${mergeCommitSha.slice(0, 7)})`);
  return { merged: true, prNumber, prUrl };
}

/**
 * Docs an epic is built from. Linked, never owned — the doc stays in the project's
 * Docs tab so it can be read and improved while the epic is in flight.
 */
export async function listEpicDocs(epicId: string) {
  return db
    .select({
      id: projectFiles.id,
      name: projectFiles.name,
      fileType: projectFiles.fileType,
      updatedAt: projectFiles.updatedAt,
      linkedAt: epicDocuments.createdAt,
    })
    .from(epicDocuments)
    .innerJoin(projectFiles, eq(projectFiles.id, epicDocuments.fileId))
    .where(eq(epicDocuments.epicId, epicId));
}

/** Point an epic at project docs. Idempotent — re-linking the same doc is a no-op. */
export async function linkDocsToEpic(
  epicId: string,
  fileIds: string[],
  linkedById?: string | null
): Promise<{ linked: number }> {
  const ids = [...new Set(fileIds.filter(Boolean))];
  if (!ids.length) return { linked: 0 };
  const epic = await getEpic(epicId);
  if (!epic) throw new Error(`Epic not found: ${epicId}`);

  // Only docs from the epic's own project.
  const valid = await db
    .select({ id: projectFiles.id })
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, epic.projectId), inArray(projectFiles.id, ids)));
  if (!valid.length) return { linked: 0 };

  await db
    .insert(epicDocuments)
    .values(valid.map((f) => ({ epicId, fileId: f.id, linkedById: linkedById ?? null })))
    .onConflictDoNothing();
  return { linked: valid.length };
}

export async function unlinkDocsFromEpic(epicId: string, fileIds: string[]): Promise<void> {
  const ids = [...new Set(fileIds.filter(Boolean))];
  if (!ids.length) return;
  await db
    .delete(epicDocuments)
    .where(and(eq(epicDocuments.epicId, epicId), inArray(epicDocuments.fileId, ids)));
}

/** Epic links for a set of docs, so a doc list can show which epics use each one. */
export async function epicLinksForDocs(projectId: string) {
  const rows = await db
    .select({
      fileId: epicDocuments.fileId,
      epicId: epics.id,
      epicKey: epics.epicKey,
      epicName: epics.name,
      epicStatus: epics.status,
    })
    .from(epicDocuments)
    .innerJoin(epics, eq(epics.id, epicDocuments.epicId))
    .where(eq(epics.projectId, projectId));

  const byFile: Record<string, Array<{ epicId: string; epicKey: string | null; epicName: string; epicStatus: string }>> = {};
  for (const r of rows) {
    (byFile[r.fileId] ||= []).push({ epicId: r.epicId, epicKey: r.epicKey, epicName: r.epicName, epicStatus: r.epicStatus });
  }
  return byFile;
}

/**
 * All of an epic's tickets are built → it's the client's turn. Called after a
 * ticket merge; silently does nothing while work remains.
 */
export async function maybeSubmitEpicForReview(epicId: string | null | undefined): Promise<boolean> {
  if (!epicId) return false;
  const epic = await getEpic(epicId);
  if (!epic || epic.status !== "building") return false;

  const tickets = await db
    .select({ id: projectTickets.id, status: projectTickets.status })
    .from(projectTickets)
    .where(eq(projectTickets.epicId, epicId));
  if (!tickets.length) return false;

  const DONE = new Set(["done", "review", "archived"]);
  if (!tickets.every((t) => DONE.has(t.status))) return false;

  await db
    .update(epics)
    .set({ status: "in_review", submittedForReviewAt: new Date(), updatedAt: new Date() })
    .where(eq(epics.id, epicId));
  console.log(`[epics] ${epic.epicKey} → in_review (${tickets.length} tickets built)`);
  return true;
}
