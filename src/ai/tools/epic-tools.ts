import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { epics } from "../../db/schema/epics.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { eq, and, inArray } from "drizzle-orm";
import {
  createEpic,
  listUnapprovedEpics,
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
