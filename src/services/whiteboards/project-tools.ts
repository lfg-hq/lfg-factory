/**
 * What the whiteboard's own agent can look up about the project a board belongs to: its
 * documents, tickets, epics, recent activity and code. These are the chat agent's own reading
 * tools, borrowed as they are, so both agents see the project the same way.
 *
 * Reading only. Every call is pinned to the board's project: whatever project or user id the
 * model writes is replaced, and a document or ticket is only read if it belongs to this project.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { projects } from "../../db/schema/projects.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { projectTickets } from "../../db/schema/tickets.ts";

type AnyTool = { description?: string; inputSchema?: unknown; execute?: (input: any, options: any) => Promise<unknown> };
export type ToolSet = Record<string, AnyTool>;

/** A short line for the chat while the agent is using a tool. */
export const LOOKUP_LABELS: Record<string, string> = {
  getProjectDashboard: "Looking at the project", getFileList: "Listing the documents", getFileContent: "Reading a document",
  getPendingTickets: "Checking the tickets", getTicketDetails: "Reading a ticket", getEpicStatus: "Checking the epics",
  getRecentActivities: "Checking recent activity", queryCodebase: "Reading the code",
  add_elements: "Drawing", update_elements: "Updating the board", delete_elements: "Removing from the board",
};
const MAX_TEXT = 30_000;

/** Long documents and logs are cut so one lookup cannot swamp the conversation. */
function clip(value: unknown, budget = { left: MAX_TEXT * 2 }): unknown {
  if (typeof value === "string") {
    const take = Math.min(value.length, MAX_TEXT, Math.max(0, budget.left));
    budget.left -= take;
    return take < value.length ? value.slice(0, take) + `… [cut: ${value.length - take} more characters]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => clip(item, budget));
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, budget)]));
  return value;
}

export interface Ownership { file(id: string): Promise<boolean>; ticket(id: string): Promise<boolean> }
const databaseOwnership = (projectId: string): Ownership => ({
  file: async (id) => !!(await db.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.id, id), eq(projectFiles.projectId, projectId))).limit(1))[0],
  ticket: async (id) => !!(await db.select({ id: projectTickets.id }).from(projectTickets).where(and(eq(projectTickets.id, id), eq(projectTickets.projectId, projectId))).limit(1))[0],
});

/** Pin the chat agent's reading tools to one project and one person. `projectId` is the INTERNAL id the tools use. */
export function pinToProject(source: ToolSet, projectId: string, userId: string, owns: Ownership = databaseOwnership(projectId)): ToolSet {
  const pinned: ToolSet = {};
  for (const [name, original] of Object.entries(source)) {
    if (!original?.execute || !(name in LOOKUP_LABELS)) continue;
    pinned[name] = { ...original, execute: async (input: Record<string, unknown>, options: unknown) => {
      try {
        const args: Record<string, unknown> = { ...input, projectId, userId };
        if (typeof args.fileId === "string" && !(await owns.file(args.fileId))) return { found: false, error: "No such document in this project. Call getFileList for the ids." };
        if (typeof args.ticketId === "string" && !(await owns.ticket(args.ticketId))) return { found: false, error: "No such ticket in this project. Call getPendingTickets for the ids." };
        return clip(await original.execute!(args, options));
      } catch (error) {
        return { error: `Could not look that up: ${(error as Error).message}` };
      }
    } };
  }
  return pinned;
}

/** The lookups for the project a board belongs to (by its PUBLIC project id), and the project's name. Empty when the project is gone. */
export async function projectLookups(publicProjectId: string, userId: string): Promise<{ tools: ToolSet; projectName: string | null; projectId: string | null }> {
  const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.projectId, publicProjectId)).limit(1);
  if (!project) return { tools: {}, projectName: null, projectId: null };
  const [{ getProjectDashboard }, { getFileList, getFileContent }, { getPendingTickets, getTicketDetails }, { getEpicStatus }, { getRecentActivities }, { queryCodebase }] = await Promise.all([
    import("../../ai/tools/project-tools.ts"), import("../../ai/tools/document-tools.ts"), import("../../ai/tools/ticket-tools.ts"),
    import("../../ai/tools/epic-tools.ts"), import("../../ai/tools/activity-tools.ts"), import("../../ai/tools/codebase-tools.ts"),
  ]);
  const source = { getProjectDashboard, getFileList, getFileContent, getPendingTickets, getTicketDetails, getEpicStatus, getRecentActivities, queryCodebase } as unknown as ToolSet;
  return { tools: pinToProject(source, project.id, userId), projectName: project.name, projectId: project.id };
}
