import { env } from '../../config/env.ts';
import { designProject } from './design-context-tools.ts';
import { composeCapturedDesign, openDesignBaseline } from '../../services/design-baseline.ts';
import { associateUsageDocument } from "../../services/token-usage.ts";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { projectFiles, projectFileVersions } from "../../db/schema/documents.ts";
import { eq, and, desc } from "drizzle-orm";
import { emitFileCreated, emitFileUpdated } from "../../events/emitters.ts";
import { saveContent, getContent } from "../../services/s3.ts";
import { composeDesignPreview } from "../../services/design-preview.ts";
import { linkDocsToEpic } from "../../services/epics.ts";

let _wsBroadcast: ((userId: string, data: object) => void) | null = null;
export function setWsBroadcast(fn: (userId: string, data: object) => void) {
  _wsBroadcast = fn;
}

// Keep agent revisions in the same version history as manual document edits.
/** Returns the version number holding the previous content, or null when nothing changed. */
async function preserveDocumentVersion(file: {id: string; s3Key: string | null; content: string | null}, nextContent: string, userId: string): Promise<number | null> {
  const previous = await getContent(file.s3Key, file.content);
  if (previous === nextContent) return null;
  // Retry the unique version slot if a simultaneous editor saved first.
  for (let attempt = 0; attempt < 4; attempt++) {
    const [latest] = await db.select({version: projectFileVersions.versionNumber}).from(projectFileVersions)
      .where(eq(projectFileVersions.fileId, file.id)).orderBy(desc(projectFileVersions.versionNumber)).limit(1);
    const saved = await db.insert(projectFileVersions).values({fileId: file.id, versionNumber: (latest?.version ?? 0) + 1,
      content: previous, createdById: userId, changeDescription: "Agent revision"})
      .onConflictDoNothing().returning({version: projectFileVersions.versionNumber});
    if (saved.length) return saved[0]!.version;
  }
  throw new Error("Could not preserve the previous document version. Please retry.");
}

// ── streamDocumentContent ─────────────────────────────────────────────────────
// Single tool for ALL document types (prd, implementation, spec, etc.).
// Streams content live to the chat, then upserts into project_file.

export const streamDocumentContent = tool({
  description:
    "Write any document (PRD, implementation plan, spec, roadmap, etc.) and stream it live into an expandable card in the chat. " +
    "Use fileType='prd' for product requirements, 'tech_analysis' for technical analysis / implementation plans, or any descriptive type. " +
    "If your prompt lists a template for this fileType, call loadDocumentTemplate FIRST and follow its skeleton — " +
    "a document written in the wrong shape has to be rewritten. "  +
    "Write standalone product/technical content: decisions, rationale, requirements and open questions. Keep user commands, approval transcripts and agent execution instructions in chat, never in the document. Do not turn chat quotes into authorization. " +
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
  execute: async ({ projectId, userId, name, fileType, content, epicId }, options) => {
    if (fileType === "design_baseline") throw new Error("Use captureDesignLayout to create a verified layout capture.");
    const [previous] = await db.select().from(projectFiles).where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.epicId, ""), eq(projectFiles.name, name), eq(projectFiles.fileType, fileType)));
    const previousVersion = previous ? await preserveDocumentVersion(previous, content, userId) : null;
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
      await linkDocsToEpic(epicId, [file!.id], userId);
    }

    await associateUsageDocument(file!.id, options.toolCallId);
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
    return { saved: true, id: file!.id, name, fileType, ...(previousVersion ? { previousVersion } : {}) };
  },
});

// ── previewPage ───────────────────────────────────────────────────────────────

export const previewPage = tool({
  description:
    "Show a page or app screen; call once per named screen for multi-screen features. Follow the design-feature skill for app UI. " +
    "For existing apps read the actual files with readDesignSource, then generate self-contained HTML reusing their layout and styles. No running app or sandbox is required. captureDesignLayout is optional. " +
    "Show the user a REAL, rendered preview of a page — a self-contained HTML document " +
    "(all CSS inline in a <style> block, no external files, no build step) that appears " +
    "as an expandable card in the chat. " +
    "A request to design/show/preview the UI already authorizes rendering; do not ask again or emit text wireframes first. " +
    "Read and reuse the actual app layout, navigation and affected screen: preserve menu labels, order, icons and flows. " +
    "Embed all CSS and inline SVG icons; external stylesheets, fonts and scripts are blocked. Style links/buttons explicitly. " +
    "Batch small copy changes. Use concise chat captions rather than duplicating previews as ASCII diagrams. " +
    "The preview is saved as a draft. After acceptance, pass its ID in createTickets.approvedDesignDocumentIds to preserve the accepted design.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      userId: z.string().describe("The user's ID — used to push the preview into their chat"),
      approximateReason: z.string().min(12).optional().describe("Only when the user accepts an approximate standalone mockup: explain which source files or visual references were unavailable. Do not silently fall back."),
      baselineId: z.string().optional().describe("Immutable actual app layout from captureDesignLayout. With this set, html/css/js describe ONLY the feature region, never the sidebar or app shell."),
      css: z.string().optional().describe("App-matching CSS embedded in a style block"),
      js: z.string().optional().describe("Local mock interactions; no network or real mutations"),
      data: z.unknown().optional().describe("Synthetic JSON exposed as window.mockData"),
      name: z.string().describe("What this page is, e.g. 'RingDesk landing page'"),
      epicId: z.string().optional().describe("Related epic; links this preview to the feature."),
      html: z
        .string()
        .describe(
          "A COMPLETE, self-contained HTML document: <!doctype html> … </html>, with all " +
          "styling inside one <style> block. No external stylesheets, scripts or images " +
          "(use inline SVG or CSS gradients). It must render correctly opened on its own."
        ),
    })
  ),
  execute: async ({ projectId, userId, name, html, css, js, data, epicId, baselineId, approximateReason }, options) => {
    const designApp = await designProject(projectId, userId);
    const sourceRead = (options as unknown as { designSourceRead?: boolean }).designSourceRead === true;
    if ((designApp.repoUrl || designApp.repoName) && !sourceRead && !baselineId && !approximateReason) {
      return { saved: false, error: 'Read the actual layout, navigation, affected page and styles with readDesignSource before rendering. No sandbox or capture is required. Reload the design-feature skill. If source is unavailable, explain the gap and agree an approximate mockup; then pass approximateReason.' };
    }
    html = composeDesignPreview({ html, css, js, data });
    let fidelity = 'Approximate mockup — app layout not verified';
    if (baselineId) {
      const [baselineFile] = await db.select().from(projectFiles).where(eq(projectFiles.id, baselineId));
      if (!baselineFile || baselineFile.projectId !== projectId || baselineFile.fileType !== 'design_baseline') throw new Error('Layout capture must belong to this project.');
      const baseline = openDesignBaseline(await getContent(baselineFile.s3Key, baselineFile.content), env.BETTER_AUTH_SECRET);
      if (baseline.projectId !== projectId) throw new Error('Layout capture project mismatch.');
      html = composeCapturedDesign(baseline, html);
      fidelity = 'Captured app layout · interactive sample feature · static navigation';
    } else if (sourceRead) {
      fidelity = "Source-based design · sample data · not verified against the running app";
      html = html.replace(/<head[^>]*>/i, '$&<meta name="lfg-design-fidelity" content="source-based">');
    } else {
      html = html.replace(/<head[^>]*>/i, '$&<meta name="lfg-design-fidelity" content="approximate">');
    }
    const fileType = "page_preview";
    const { s3Key, dbContent } = await saveContent(projectId, fileType, name, html);

    const [file] = await db
      .insert(projectFiles)
      .values({ projectId, epicId: "", name, fileType, content: dbContent, s3Key })
      .onConflictDoUpdate({
        target: [projectFiles.projectId, projectFiles.epicId, projectFiles.name, projectFiles.fileType],
        set: { content: dbContent, s3Key, updatedAt: new Date() },
      })
      .returning();

    if (epicId) await linkDocsToEpic(epicId, [file!.id], userId);
    await associateUsageDocument(file!.id, options.toolCallId);
    emitFileCreated({ projectId, documentId: file!.id, documentType: fileType, name });

    // The card is pushed by the stream handler on tool-result, NOT from here.
    // _wsBroadcast goes through the connection manager's socket registry, which is a
    // different channel from the chat stream the rest of this UI arrives on — the
    // notification was being sent into a socket the chat page never reads.
    return {
      saved: true,
      id: file!.id,
      name,
      status: "draft",
      fidelity,
      approvalRequired: "Wait for user acceptance before passing this ID in approvedDesignDocumentIds to createTickets.",
      // Say it plainly so the model quotes the id in the ticket rather than paraphrasing.
      referenceForTicket: `Approved design preview: document ${file!.id} ("${name}") — build the page to match it.`,
    };
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
  execute: async ({ fileId }, options) => {
    const [file] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId));
    if (!file) return { found: false as const };
    await associateUsageDocument(file.id, options.toolCallId);
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
  execute: async ({ fileId, userId, content }, options) => {
    const [existing] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId));
    if (!existing) return { success: false, error: "File not found" };
    if (existing.fileType === "design_baseline") return { success: false, error: "Layout captures are immutable. Capture a new version." };
    await associateUsageDocument(existing.id, options.toolCallId);

    const previousVersion = await preserveDocumentVersion(existing, content, userId);
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
    return { success: true, id: file.id, name: file.name, fileType: file.fileType, ...(previousVersion ? { previousVersion } : {}) };
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
  execute: async ({ fileId, userId, edits }, options) => {
    const [existing] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId));
    if (!existing) return { success: false, error: "File not found" };
    if (existing.fileType === "design_baseline") return { success: false, error: "Layout captures are immutable. Capture a new version." };
    await associateUsageDocument(existing.id, options.toolCallId);

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
    const previousVersion = await preserveDocumentVersion(existing, content, userId);
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
    return { success: true, id: file.id, name: file.name, fileType: file.fileType, ...(previousVersion ? { previousVersion } : {}), editsApplied: applied, editsFailed: failed, details: results };
  },
});
