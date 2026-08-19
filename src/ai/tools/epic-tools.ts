import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { epics } from "../../db/schema/epics.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { eq, and, inArray, isNull, asc } from "drizzle-orm";
import {
  createEpic,
  listUnapprovedEpics,
  assignTicketsToEpic,
  linkDocsToEpic,
  getEpic as getEpicById,
  LEGACY_ANCHOR_BRANCH,
  UNAPPROVED_STATUSES,
} from "../../services/epics.ts";

// ── createEpic ────────────────────────────────────────────────────────────────

export const startEpic = tool({
  description:
    "Open an EPIC — the delivery unit for a feature: its scope doc, technical analysis, " +
    "tickets, git branch, preview and client approval all hang off it. " +
    "Call this ONCE at the start of a new feature, BEFORE writing its docs or creating its " +
    "tickets, then pass the returned epicId to streamDocumentContent and createTickets. " +
    "An epic is cut from `main` (approved code), so its tickets never inherit another " +
    "feature's unapproved work and it can be reviewed and merged on its own. " +
    "Do NOT ask the user which branch to build on — that is a git question they should never " +
    "have to answer. Just open the epic; only set `parentEpicId` if `checkEpicOverlap` says " +
    "this work genuinely sits on top of another epic that is still awaiting approval.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      userId: z.string().describe("The user's ID — recorded as the epic's creator"),
      name: z.string().describe("Short client-facing name for the feature, e.g. 'Billing rework'"),
      goal: z.string().optional().describe("One line the client would recognise: what this delivers and why"),
      conversationId: z.string().optional().describe("The conversation this epic came out of, if known"),
      parentEpicId: z.string().optional().describe(
        "ONLY when this feature genuinely builds on another epic the client hasn't approved yet. " +
        "This epic then cannot be merged to main until that one is. Leave unset by default."
      ),
    })
  ),
  execute: async ({ projectId, userId, name, goal, conversationId, parentEpicId }) => {
    const epic = await createEpic({
      projectId,
      name,
      goal,
      createdById: userId,
      conversationId: conversationId ?? null,
      parentEpicId: parentEpicId ?? null,
    });
    return {
      epicId: epic.id,
      epicKey: epic.epicKey,
      name: epic.name,
      branch: epic.branch,
      baseBranch: epic.baseBranch,
      stackedOn: epic.parentEpicId ?? null,
    };
  },
});

// ── checkEpicOverlap ──────────────────────────────────────────────────────────

export const checkEpicOverlap = tool({
  description:
    "Before opening an epic, check whether the work it describes collides with another epic " +
    "the client has NOT approved yet. Returns the unapproved epics and the files they've " +
    "touched. If there's a real overlap — the new work would edit the same files, or plainly " +
    "depends on that feature existing — tell the user in PRODUCT language ('X is still waiting " +
    "on your review and touches the same screens — stack on it, or keep them separate?') and " +
    "only then consider passing parentEpicId. If there's no overlap, say nothing and just " +
    "start the epic from main.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      paths: z.array(z.string()).optional().describe(
        "Repo-relative files/dirs the new work is likely to touch, if you can name them"
      ),
    })
  ),
  execute: async ({ projectId, paths }) => {
    const pending = await listUnapprovedEpics(projectId);
    if (!pending.length) return { unapprovedEpics: [], overlaps: [] };

    const wanted = (paths ?? []).filter(Boolean);
    const overlaps = wanted.length
      ? pending
          .map((e) => {
            const touched = (e.filesTouched as string[] | null) ?? [];
            const shared = touched.filter((f) =>
              wanted.some((w) => f === w || f.startsWith(`${w.replace(/\/$/, "")}/`) || w.startsWith(f))
            );
            return { epicId: e.id, epicKey: e.epicKey, name: e.name, sharedPaths: shared };
          })
          .filter((o) => o.sharedPaths.length > 0)
      : [];

    return {
      unapprovedEpics: pending.map((e) => ({
        epicId: e.id,
        epicKey: e.epicKey,
        name: e.name,
        status: e.status,
        goal: e.goal,
      })),
      overlaps,
    };
  },
});

// ── addTicketsToEpic ──────────────────────────────────────────────────────────

export const addToEpic = tool({
  description:
    "Put existing TICKETS and/or DOCS into an epic — use for 'move all docs and tickets " +
    "into epic X', 'put these tickets in an epic', 'group the JD generator work'. " +
    "Pass an existing `epicId`, or `newEpicName` to create one. " +
    "To gather ids: `listTicketsForEpic` for tickets, `getFileList` for docs. " +
    "When the user says 'all', pass every id you found — don't make them list them. " +
    "\n\nTwo things behave differently and are worth one clause each when you report back: " +
    "tickets MOVE into the epic (a ticket belongs to exactly one epic), while docs are " +
    "LINKED (they stay in the project's Docs tab, stay editable, and one doc can feed " +
    "several epics — nothing is hidden or taken away). " +
    "\n\nAlso: a NEW epic wrapped around already-BUILT tickets is cut from the branch " +
    "their code was merged into, not from main — otherwise its branch wouldn't contain " +
    "their work. That happens automatically; don't say it starts from main.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      userId: z.string(),
      ticketIds: z.array(z.string()).optional().describe("Existing tickets to move into the epic"),
      fileIds: z.array(z.string()).optional().describe("Existing project docs to link to the epic"),
      epicId: z.string().optional().describe("Use THIS existing epic"),
      newEpicName: z.string().optional().describe("Or create an epic with this name"),
      goal: z.string().optional().describe("One line on what the new epic delivers"),
    })
  ),
  execute: async ({ projectId, userId, ticketIds, fileIds, epicId, newEpicName, goal }) => {
    const tIds = ticketIds ?? [];
    const fIds = fileIds ?? [];
    if (!tIds.length && !fIds.length) {
      return { error: "Pass ticketIds and/or fileIds — there's nothing to add." };
    }

    let targetId = epicId;

    if (!targetId) {
      if (!newEpicName?.trim()) {
        return { error: "Pass either epicId (an existing epic) or newEpicName (to create one)." };
      }
      // Are any of these already built? If so the epic must ADOPT the anchor that
      // holds their code rather than branch off clean main.
      const rows = tIds.length
        ? await db
            .select({ merged: projectTickets.githubMergeStatus })
            .from(projectTickets)
            .where(and(eq(projectTickets.projectId, projectId), inArray(projectTickets.id, tIds)))
        : [];
      const anyBuilt = rows.some((r) => r.merged === "merged");

      const epic = await createEpic({
        projectId,
        name: newEpicName.trim(),
        goal,
        createdById: userId,
        baseBranchOverride: anyBuilt ? LEGACY_ANCHOR_BRANCH : null,
      });
      targetId = epic.id;
    }

    const moved = tIds.length ? (await assignTicketsToEpic(targetId, tIds)).moved : 0;
    const linked = fIds.length ? (await linkDocsToEpic(targetId, fIds, userId)).linked : 0;

    const epic = await getEpicById(targetId);
    return {
      ticketsMoved: moved,
      docsLinked: linked,
      epicId: targetId,
      epicKey: epic?.epicKey ?? null,
      epicName: epic?.name ?? null,
      branch: epic?.branch ?? null,
      adoptedExistingWork: epic?.baseBranch === LEGACY_ANCHOR_BRANCH,
      // Docs were linked, not moved — say so if you mention them.
      docsRemainInProjectDocs: true,
    };
  },
});

// ── listTicketsForEpic ────────────────────────────────────────────────────────

export const listTicketsForEpic = tool({
  description:
    "List the project's tickets with their current epic (if any), so you can pick ids to " +
    "move into an epic. Use `unassignedOnly` to see just the tickets that don't belong to " +
    "an epic yet — that's usually the set the user means by 'these tickets'.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      unassignedOnly: z.boolean().optional(),
      conversationId: z.string().optional().describe(
        "Limit to tickets created in this conversation. Note: tickets created before " +
        "ticket/conversation linking existed have no conversation recorded and won't match."
      ),
    })
  ),
  execute: async ({ projectId, unassignedOnly, conversationId }) => {
    const filters = [eq(projectTickets.projectId, projectId)];
    if (unassignedOnly) filters.push(isNull(projectTickets.epicId));
    if (conversationId) filters.push(eq(projectTickets.conversationId, conversationId));

    const rows = await db
      .select({
        id: projectTickets.id,
        ticketKey: projectTickets.ticketKey,
        name: projectTickets.name,
        status: projectTickets.status,
        epicId: projectTickets.epicId,
        mergeStatus: projectTickets.githubMergeStatus,
        createdAt: projectTickets.createdAt,
      })
      .from(projectTickets)
      .where(and(...filters))
      .orderBy(asc(projectTickets.createdAt));

    const epicRows = await db.select().from(epics).where(eq(epics.projectId, projectId));
    const byId = Object.fromEntries(epicRows.map((e) => [e.id, e]));

    return {
      tickets: rows.map((t) => ({
        ...t,
        epicKey: t.epicId ? byId[t.epicId]?.epicKey ?? null : null,
        epicName: t.epicId ? byId[t.epicId]?.name ?? null : null,
      })),
    };
  },
});

// ── getEpicStatus ─────────────────────────────────────────────────────────────

export const getEpicStatus = tool({
  description:
    "Get one epic — or every epic in the project — with its tickets, docs, branch and " +
    "approval state. Use it to answer 'what's waiting on me?' or 'what's in this build?'.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      epicId: z.string().optional().describe("Omit to list every epic in the project"),
      onlyUnapproved: z.boolean().optional().describe("Only epics the client hasn't accepted yet"),
    })
  ),
  execute: async ({ projectId, epicId, onlyUnapproved }) => {
    const where = epicId
      ? and(eq(epics.projectId, projectId), eq(epics.id, epicId))
      : onlyUnapproved
        ? and(eq(epics.projectId, projectId), inArray(epics.status, UNAPPROVED_STATUSES))
        : eq(epics.projectId, projectId);
    const rows = await db.select().from(epics).where(where);
    if (!rows.length) return { epics: [] };

    const ids = rows.map((e) => e.id);
    const [tickets, docs] = await Promise.all([
      db
        .select({
          id: projectTickets.id,
          epicId: projectTickets.epicId,
          ticketKey: projectTickets.ticketKey,
          name: projectTickets.name,
          status: projectTickets.status,
          executionOrder: projectTickets.executionOrder,
        })
        .from(projectTickets)
        .where(inArray(projectTickets.epicId, ids)),
      db
        .select({
          id: projectFiles.id,
          epicId: projectFiles.epicId,
          name: projectFiles.name,
          fileType: projectFiles.fileType,
        })
        .from(projectFiles)
        .where(inArray(projectFiles.epicId, ids)),
    ]);

    return {
      epics: rows.map((e) => ({
        epicId: e.id,
        epicKey: e.epicKey,
        name: e.name,
        goal: e.goal,
        status: e.status,
        branch: e.branch,
        baseBranch: e.baseBranch,
        stackedOnEpicId: e.parentEpicId,
        previewUrl: e.previewUrl,
        tickets: tickets
          .filter((t) => t.epicId === e.id)
          .sort((a, b) => a.executionOrder - b.executionOrder),
        docs: docs.filter((d) => d.epicId === e.id),
      })),
    };
  },
});
