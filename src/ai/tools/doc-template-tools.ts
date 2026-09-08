/**
 * loadDocumentTemplate — the agent fetches the shape a document should take, before
 * it writes one.
 *
 * The alternative was injecting every template into the system prompt. Templates are
 * long (a full SOW skeleton is pages), most turns write no document at all, and the
 * project's own template can change between turns. So the prompt lists the TYPES that
 * have one and the agent pulls the body when it is about to write.
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { templateFor, templatesFor } from "../doc-templates/index.ts";

export const loadDocumentTemplate = tool({
  description:
    "Load the template for a document type BEFORE writing that document with " +
    "streamDocumentContent. Returns the skeleton the document should follow and any " +
    "house rules for writing it. Call this first for any type listed in your prompt — " +
    "a document written in the wrong shape has to be rewritten. If the type has no " +
    "template you'll be told, and you can write it as you normally would.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string().describe("The project the document belongs to"),
      docType: z
        .string()
        .describe("The document type you're about to write: prd | sow | spec | tech_analysis | roadmap | …"),
    })
  ),
  execute: async ({ projectId, docType }) => {
    const t = await templateFor(projectId, docType);
    if (!t) {
      const available = (await templatesFor(projectId)).map((x) => x.docType);
      return {
        found: false as const,
        note: `No template for "${docType}" — write the document as you normally would.`,
        available,
      };
    }
    return {
      found: true as const,
      docType: t.docType,
      source: t.source,
      // The shape to follow. Placeholders in {{braces}} are for you to fill in, not to keep.
      skeleton: t.body,
      // House rules. Obey them; never paste them into the document itself.
      instructions: t.instructions || undefined,
    };
  },
});
