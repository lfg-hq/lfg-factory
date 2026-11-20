/**
 * The tools an agent on someone's own computer gets for one chat turn, over the LFG MCP
 * endpoint (src/routes/mcp-server.ts). Built from the same pieces as the server chat in
 * stream-handler.ts (toolsProduct, the project's loadSkill, notes, ticket↔document links)
 * and bound the same way (withConversationContext), so the agent reads and writes LFG's
 * data exactly as the server-side agent would.
 *
 * Over MCP:
 * - askUser / confirmAction return "shown, wait for the reply"; the chat turn that relays
 *   the agent's events (step 4) renders the card from the tool call, as the server does.
 * - streamDocumentContent saves the whole document when called (no live typing effect).
 * - The preview tools (inspect, diagnostics, runInPreview, handlePreview) work as on the
 *   web; only their live progress lines are dropped (they went to the chat socket).
 * Left out: provider web search (the agent has its own), Composio connectors,
 * quickChange (off by default).
 */

import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects } from "../db/schema/projects.ts";
import { toolsProduct } from "./tools/index.ts";
import { withConversationContext } from "./tools/conversation-context.ts";
import { linkTicketDocumentsTool } from "./tools/ticket-document-tools.ts";
import type { TurnGrant } from "../services/runner/turn-tokens.ts";

export async function buildMcpTools(grant: TurnGrant): Promise<Record<string, any>> {
  let tools: Record<string, any> = { ...toolsProduct };
  const { buildLoadSkillTool } = await import("./tools/skill-tools.ts");
  tools.loadSkill = buildLoadSkillTool(grant.projectId ?? undefined);
  if (grant.projectId) {
    const [project] = await db.select({ publicId: projects.projectId }).from(projects).where(eq(projects.id, grant.projectId)).limit(1);
    Object.assign(tools, (await import("./tools/note-tools.ts")).noteTools({ projectId: grant.projectId, userId: grant.userId }));
    Object.assign(tools, (await import("./tools/comment-tools.ts")).commentTools({ projectId: grant.projectId, userId: grant.userId }));
    if (project) tools.linkTicketDocuments = linkTicketDocumentsTool({ projectId: grant.projectId, publicProjectId: project.publicId, userId: grant.userId });
    if (project) Object.assign(tools, await previewTools(grant, project.publicId));
  }
  // The agent runs on the user's computer and may read the app from a local checkout.
  tools = withConversationContext(tools, grant.conversationId, grant.userId, grant.projectId, grant.messageId, { localCheckout: true });
  return tools;
}

/** The live preview, as the web chat gets it (stream-handler.ts): read-only inspection,
 *  diagnostics, a shell for checks, and operations such as resetting a preview password. */
async function previewTools(grant: TurnGrant, publicProjectId: string): Promise<Record<string, any>> {
  const projectId = grant.projectId!;
  const { createPreviewInspectTool, createPreviewRunTool } = await import("../services/dev-preview.ts");
  const { previewDiagnosticsTool } = await import("./tools/preview-diagnostics.ts");
  const { previewActionTool } = await import("./tools/preview-action-tools.ts");
  const ctx = { projectId, publicProjectId, userId: grant.userId, conversationId: grant.conversationId };
  const { cloudOnlyTools } = await import("../services/preview-where.ts");
  return {
    ...cloudOnlyTools({ ...(await createPreviewInspectTool({ projectId })), runInPreview: createPreviewRunTool(ctx) }, grant.userId, projectId),
    getPreviewDiagnostics: previewDiagnosticsTool({ projectId, publicProjectId, userId: grant.userId }),
    handlePreview: previewActionTool(ctx),
  };
}
