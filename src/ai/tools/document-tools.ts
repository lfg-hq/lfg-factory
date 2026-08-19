import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { projectFiles, projectFileVersions } from "../../db/schema/documents.ts";
import { eq } from "drizzle-orm";
import { emitFileCreated, emitFileUpdated } from "../../events/emitters.ts";
import { saveContent, getContent } from "../../services/s3.ts";
import { linkDocsToEpic } from "../../services/epics.ts";

let _wsBroadcast: ((userId: string, data: object) => void) | null = null;
export function setWsBroadcast(fn: (userId: string, data: object) => void) {
  _wsBroadcast = fn;
}

// ── streamDocumentContent ─────────────────────────────────────────────────────
// Single tool for ALL document types (prd, implementation, spec, etc.).
// Streams content live to the right panel, then upserts into project_file.

export const streamDocumentContent = tool({
  description:
    "Write any document (PRD, implementation plan, spec, roadmap, etc.) and stream it live to the user's right panel. " +
    "Use fileType='prd' for product requirements, 'implementation' for technical plans, or any descriptive type. " +
    "If a file with the same name+type already exists it will be updated in-place. " +
    "Pass `epicId` when the doc relates to a feature you're building — the doc is LINKED " +
    "to that epic so the epic shows the full picture. The doc still lives in the project's " +
    "Docs tab and stays readable and editable; linking never hides or moves it.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      userId: z.string().describe("The user's ID — used to broadcast the save notification"),
      name: z.string().describe("Human-readable document name, e.g. 'Main PRD' or 'Technical Implementation Plan'"),
      fileType: z
        .string()
        .describe("Document type: prd | implementation | tech_analysis | design_language | spec | roadmap | design | research | other"),
      content: z.string().describe("Full document content in Markdown — written once, streamed live to the user"),
      epicId: z.string().optional().describe(
        "The epic this doc relates to (from startEpic). Links the doc to that epic so the " +
        "epic shows its docs alongside its tickets. The doc stays a normal project doc."
      ),
    })
  ),
  execute: async ({ projectId, userId, name, fileType, content, epicId }) => {
    const { s3Key, dbContent } = await saveContent(projectId, fileType, name, content);

    // Docs always live at PROJECT scope so they stay visible and editable. An epic
    // points at them via a link row instead of taking them out of the Docs tab.
    const [file] = await db
      .insert(projectFiles)
      .values({ projectId, epicId: "", name, fileType, content: dbContent, s3Key })
      .onConflictDoUpdate({
        target: [projectFiles.projectId, projectFiles.epicId, projectFiles.name, projectFiles.fileType],
        set: { content: dbContent, s3Key, updatedAt: new Date() },
      })
      .returning();

    if (epicId) {
      await linkDocsToEpic(epicId, [file!.id], userId).catch((e) =>
        console.warn("[streamDocumentContent] epic link failed:", (e as Error).message?.slice(0, 160))
      );
    }

    emitFileCreated({ projectId, documentId: file!.id, documentType: fileType, name });

    if (_wsBroadcast) {
      _wsBroadcast(userId, {
        type: "ai_chunk",
        is_notification: true,
        notification_type: "file_stream",
        file_type: fileType,
        file_id: file!.id,
        file_name: name,
        is_complete: true,
      });
    }
    return { saved: true, id: file!.id, name, fileType };
  },
});

// ── getFileList ───────────────────────────────────────────────────────────────

export const getFileList = tool({
  description: "List all documents/files saved for a project.",
  inputSchema: zodSchema(z.object({ projectId: z.string() })),
  execute: async ({ projectId }) => {
    const rows = await db
      .select({
        id: projectFiles.id,
        name: projectFiles.name,
        fileType: projectFiles.fileType,
        updatedAt: projectFiles.updatedAt,
      })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId));
    return { files: rows };
  },
});

// ── getFileContent ────────────────────────────────────────────────────────────

export const getFileContent = tool({
  description: "Get the content of a specific project document/file by its ID.",
  inputSchema: zodSchema(z.object({ fileId: z.string() })),
  execute: async ({ fileId }) => {
    const [file] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId));
    if (!file) return { found: false as const };
    const content = await getContent(file.s3Key, file.content);
    return {
      found: true as const,
      id: file.id,
      name: file.name,
      fileType: file.fileType,
      content,
    };
  },
});

// ── updateFileContent ─────────────────────────────────────────────────────────

export const updateFileContent = tool({
  description:
    "Rewrite the ENTIRE content of an existing project document. " +
    "Prefer patchFileContent for small edits — this rewrites the whole file and costs more tokens.",
  inputSchema: zodSchema(
    z.object({
      fileId: z.string(),
      userId: z.string(),
      content: z.string().describe("New full document content in Markdown"),
    })
  ),
  execute: async ({ fileId, userId, content }) => {
    const [existing] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId));
    if (!existing) return { success: false, error: "File not found" };

    const { s3Key, dbContent } = await saveContent(existing.projectId, existing.fileType, existing.name, content);
    const [file] = await db
      .update(projectFiles)
      .set({ content: dbContent, s3Key, updatedAt: new Date() })
      .where(eq(projectFiles.id, fileId))
      .returning();

    if (!file) return { success: false, error: "File not found" };

    emitFileUpdated({ projectId: file.projectId, documentId: file.id, documentType: file.fileType });

    if (_wsBroadcast) {
      _wsBroadcast(userId, {
        type: "ai_chunk",
        is_notification: true,
        notification_type: "file_stream",
        file_type: file.fileType,
        file_id: file.id,
        file_name: file.name,
        is_complete: true,
      });
    }
    return { success: true, id: file.id, name: file.name, fileType: file.fileType };
  },
});

// ── patchFileContent ──────────────────────────────────────────────────────────
// Surgical find-and-replace edits — much cheaper than rewriting the whole file.

export const patchFileContent = tool({
  description:
    "Apply surgical find-and-replace edits to an existing document WITHOUT rewriting the entire file. " +
    "Much cheaper on tokens than updateFileContent. Use this for small-to-medium edits like " +
    "changing a priority, adding a bullet point, updating a section, or fixing a typo. " +
    "Each edit specifies an exact oldText to find and the newText to replace it with. " +
    "If oldText is empty string and newText is provided, newText is appended to the end of the document.",
  inputSchema: zodSchema(
    z.object({
      fileId: z.string(),
      userId: z.string(),
      edits: z
        .array(
          z.object({
            oldText: z.string().describe("Exact text to find in the document (use enough context to be unique). Empty string = append to end."),
            newText: z.string().describe("Text to replace it with"),
          })
        )
        .min(1)
        .describe("List of find-and-replace edits to apply in order"),
    })
  ),
  execute: async ({ fileId, userId, edits }) => {
    const [existing] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId));
    if (!existing) return { success: false, error: "File not found" };

    // Get current content
    let content = await getContent(existing.s3Key, existing.content);
    if (!content) return { success: false, error: "Could not read file content" };

    // Apply edits sequentially
    const results: { oldText: string; applied: boolean; reason?: string }[] = [];
    for (const edit of edits) {
      if (edit.oldText === "") {
        // Append mode
        content = content.trimEnd() + "\n\n" + edit.newText;
        results.push({ oldText: "(append)", applied: true });
      } else if (content.includes(edit.oldText)) {
        content = content.replace(edit.oldText, edit.newText);
        results.push({ oldText: edit.oldText.slice(0, 60), applied: true });
      } else {
        results.push({ oldText: edit.oldText.slice(0, 60), applied: false, reason: "Text not found in document" });
      }
    }

    // Save updated content
    const { s3Key, dbContent } = await saveContent(existing.projectId, existing.fileType, existing.name, content);
    const [file] = await db
      .update(projectFiles)
      .set({ content: dbContent, s3Key, updatedAt: new Date() })
      .where(eq(projectFiles.id, fileId))
      .returning();

    if (!file) return { success: false, error: "File not found after update" };

    emitFileUpdated({ projectId: file.projectId, documentId: file.id, documentType: file.fileType });

    if (_wsBroadcast) {
      _wsBroadcast(userId, {
        type: "ai_chunk",
        is_notification: true,
        notification_type: "file_stream",
        file_type: file.fileType,
        file_id: file.id,
        file_name: file.name,
        is_complete: true,
      });
    }

    const applied = results.filter((r) => r.applied).length;
    const failed = results.filter((r) => !r.applied).length;
    return { success: true, id: file.id, name: file.name, editsApplied: applied, editsFailed: failed, details: results };
  },
});
