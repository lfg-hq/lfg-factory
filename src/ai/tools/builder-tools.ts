/**
 * Builder Tools — tools for API-based ticket execution.
 *
 * These tools let the AI agent execute commands on a Mags VM,
 * read/write files, and report progress — all without the Claude CLI.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { execOnWorkspace } from "../../services/mags.ts";
import { db } from "../../config/db.ts";
import { projectTickets, projectTodoLists } from "../../db/schema/tickets.ts";
import { emit } from "../../events/bus.ts";
import { addLog } from "../../services/ticket-logs.ts";
import { eq } from "drizzle-orm";
import { matchKnowledge } from "../knowledge/matcher.ts";

export interface BuilderToolContext {
  workspaceId: string;
  ticketId: string;
  projectId: string;
  userId: string;
  projectDir: string;
}

const MAX_OUTPUT_BYTES = 10_000;

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return (
    output.slice(0, MAX_OUTPUT_BYTES / 2) +
    "\n\n... [output truncated — " +
    output.length +
    " bytes total] ...\n\n" +
    output.slice(-MAX_OUTPUT_BYTES / 2)
  );
}

export function createBuilderTools(ctx: BuilderToolContext) {
  return {
    sshCommand: tool({
      description:
        "Execute a shell command on the VM. Use this for installing packages, running builds, checking files, etc. The command runs as root in an Alpine Linux environment.",
      inputSchema: zodSchema(
        z.object({
          command: z.string().describe("The shell command to execute"),
          timeout: z
            .number()
            .optional()
            .default(120_000)
            .describe("Timeout in milliseconds (default 120s)"),
        })
      ),
      execute: async ({ command, timeout }) => {
        await addLog(ctx.ticketId, `$ ${command}`, "command", ctx.userId);
        try {
          const result = await execOnWorkspace(ctx.workspaceId, command, {
            timeout,
          });
          const output = truncateOutput(result.output ?? "");
          return { exitCode: result.exitCode ?? 0, output };
        } catch (err) {
          return {
            exitCode: 1,
            output: `Command failed: ${(err as Error).message}`,
          };
        }
      },
    }),

    readFile: tool({
      description:
        "Read the contents of a file on the VM. Returns the file content as a string.",
      inputSchema: zodSchema(
        z.object({
          path: z
            .string()
            .describe(
              "Absolute path or path relative to the project directory"
            ),
        })
      ),
      execute: async ({ path }) => {
        const absPath = path.startsWith("/")
          ? path
          : `${ctx.projectDir}/${path}`;
        try {
          const result = await execOnWorkspace(
            ctx.workspaceId,
            `cat "${absPath}"`,
            { timeout: 30_000 }
          );
          return {
            content: truncateOutput(result.output ?? ""),
            exitCode: result.exitCode ?? 0,
          };
        } catch (err) {
          return {
            content: "",
            error: `Failed to read file: ${(err as Error).message}`,
            exitCode: 1,
          };
        }
      },
    }),

    writeFile: tool({
      description:
        "Write content to a file on the VM. Creates the file if it doesn't exist, including any necessary parent directories.",
      inputSchema: zodSchema(
        z.object({
          path: z
            .string()
            .describe(
              "Absolute path or path relative to the project directory"
            ),
          content: z.string().describe("The content to write to the file"),
        })
      ),
      execute: async ({ path, content }) => {
        const absPath = path.startsWith("/")
          ? path
          : `${ctx.projectDir}/${path}`;
        const b64 = Buffer.from(content).toString("base64");
        try {
          const mkdirCmd = `mkdir -p "$(dirname "${absPath}")"`;
          await execOnWorkspace(ctx.workspaceId, mkdirCmd, { timeout: 15_000 });

          const writeCmd = `echo '${b64}' | base64 -d > "${absPath}"`;
          const result = await execOnWorkspace(ctx.workspaceId, writeCmd, {
            timeout: 30_000,
          });
          await addLog(
            ctx.ticketId,
            `Write: ${absPath}`,
            "command",
            ctx.userId
          );
          return { success: (result.exitCode ?? 0) === 0, path: absPath };
        } catch (err) {
          return {
            success: false,
            error: `Failed to write file: ${(err as Error).message}`,
          };
        }
      },
    }),

    listFiles: tool({
      description:
        "List files and directories on the VM. Supports glob patterns via find.",
      inputSchema: zodSchema(
        z.object({
          path: z
            .string()
            .optional()
            .default(".")
            .describe("Directory to list (default: project root)"),
          pattern: z
            .string()
            .optional()
            .describe("Optional glob pattern for find (e.g. '*.ts')"),
          maxDepth: z
            .number()
            .optional()
            .default(3)
            .describe("Max directory depth (default 3)"),
        })
      ),
      execute: async ({ path, pattern, maxDepth }) => {
        const absPath = path!.startsWith("/")
          ? path!
          : `${ctx.projectDir}/${path}`;
        let cmd = `find "${absPath}" -maxdepth ${maxDepth}`;
        if (pattern) cmd += ` -name "${pattern}"`;
        cmd += " -type f 2>/dev/null | head -200";
        try {
          const result = await execOnWorkspace(ctx.workspaceId, cmd, {
            timeout: 30_000,
          });
          const files = (result.output ?? "")
            .split("\n")
            .filter((f: string) => f.trim());
          return { files };
        } catch (err) {
          return {
            files: [] as string[],
            error: `Failed to list files: ${(err as Error).message}`,
          };
        }
      },
    }),

    searchFiles: tool({
      description:
        "Search file contents using grep. Returns matching lines with file paths and line numbers.",
      inputSchema: zodSchema(
        z.object({
          pattern: z.string().describe("Regex pattern to search for"),
          path: z
            .string()
            .optional()
            .default(".")
            .describe("Directory to search in (default: project root)"),
          include: z
            .string()
            .optional()
            .describe("File glob to include (e.g. '*.ts')"),
        })
      ),
      execute: async ({ pattern, path, include }) => {
        const absPath = path!.startsWith("/")
          ? path!
          : `${ctx.projectDir}/${path}`;
        let cmd = `grep -rn "${pattern.replace(/"/g, '\\"')}" "${absPath}"`;
        if (include) cmd += ` --include="${include}"`;
        cmd += " 2>/dev/null | head -100";
        try {
          const result = await execOnWorkspace(ctx.workspaceId, cmd, {
            timeout: 30_000,
          });
          return {
            matches: truncateOutput(result.output ?? ""),
            exitCode: result.exitCode ?? 0,
          };
        } catch (err) {
          return {
            matches: "",
            error: `Search failed: ${(err as Error).message}`,
            exitCode: 1,
          };
        }
      },
    }),

    createTasks: tool({
      description:
        "Create tasks to track your implementation progress. Call this early to show the user what you plan to do.",
      inputSchema: zodSchema(
        z.object({
          tasks: z
            .array(
              z.object({
                description: z.string().describe("Task description"),
              })
            )
            .describe("Tasks to create"),
        })
      ),
      execute: async ({ tasks }) => {
        // Idempotent: on a re-run/reassign the agent calls createTasks again.
        // Reuse existing tasks with the same description (keeping their current
        // status, so completed work stays completed) instead of creating a
        // duplicate set. Only genuinely new descriptions get inserted.
        const existing = await db
          .select({ id: projectTodoLists.id, description: projectTodoLists.description })
          .from(projectTodoLists)
          .where(eq(projectTodoLists.ticketId, ctx.ticketId));
        const norm = (s: string) => s.trim().toLowerCase();
        const byDesc = new Map(existing.map((t) => [norm(t.description), t]));

        const created: Array<{ id: string; description: string }> = [];
        for (const task of tasks) {
          const match = byDesc.get(norm(task.description));
          if (match) {
            created.push({ id: match.id, description: match.description });
            continue;
          }
          const [row] = await db
            .insert(projectTodoLists)
            .values({
              ticketId: ctx.ticketId,
              description: task.description,
              status: "pending",
            })
            .returning({
              id: projectTodoLists.id,
              description: projectTodoLists.description,
            });
          if (row) {
            created.push(row);
            byDesc.set(norm(row.description), row);
          }
        }
        emit({
          type: "ticket.tasks_updated",
          ticketId: ctx.ticketId,
          taskIds: created.map((t) => t.id),
        });
        return { created };
      },
    }),

    updateTaskStatus: tool({
      description:
        "Update the status of a task. Use this to show progress as you implement.",
      inputSchema: zodSchema(
        z.object({
          taskId: z.string().describe("The task ID to update"),
          status: z
            .enum(["pending", "in_progress", "success", "fail"])
            .describe("New status"),
          explanation: z
            .string()
            .optional()
            .describe("Optional explanation of what was done"),
        })
      ),
      execute: async ({ taskId, status, explanation }) => {
        const updateData: Record<string, unknown> = {
          status,
          updatedAt: new Date(),
        };
        if (explanation) updateData.explanation = explanation;

        await db
          .update(projectTodoLists)
          .set(updateData)
          .where(eq(projectTodoLists.id, taskId));

        emit({
          type: "ticket.tasks_updated",
          ticketId: ctx.ticketId,
          taskIds: [taskId],
        });
        return { success: true };
      },
    }),

    reportStatus: tool({
      description:
        "Report the final status of your implementation. You MUST call this when you are done (either complete or failed). This is how the platform knows you are finished.",
      inputSchema: zodSchema(
        z.object({
          status: z
            .enum(["complete", "failed"])
            .describe("Final status of the implementation"),
          message: z
            .string()
            .describe("Summary of what was done or why it failed"),
        })
      ),
      execute: async ({ status, message }) => {
        await addLog(
          ctx.ticketId,
          `IMPLEMENTATION_STATUS: ${status.toUpperCase()} - ${message}`,
          "ai_response",
          ctx.userId
        );

        emit({
          type: "ticket.execution_finished",
          ticketId: ctx.ticketId,
          projectId: ctx.projectId,
          status: status === "complete" ? "complete" : "failed",
          exitCode: status === "complete" ? 0 : 1,
        });

        return { reported: true, status, message };
      },
    }),

    askUser: tool({
      description:
        "Ask the user a question with suggested options. Use this when you need clarification on a decision that significantly affects implementation (e.g. auth method, database choice, UI approach). Blocks until the user responds.",
      inputSchema: zodSchema(
        z.object({
          question: z
            .string()
            .describe("The question to ask the user"),
          suggestions: z
            .array(z.string())
            .min(2)
            .max(5)
            .describe("2-5 suggested options for the user to choose from"),
          context: z
            .string()
            .optional()
            .describe("Optional context explaining why this decision matters"),
        })
      ),
      execute: async ({ question, suggestions, context }) => {
        const message = context
          ? `${question}\n\nContext: ${context}`
          : question;

        await addLog(ctx.ticketId, message, "question", ctx.userId, {
          options: suggestions,
        });

        // Long-poll projectTickets.notes for INPUT_RESPONSE marker
        const marker = `INPUT_RESPONSE:${ctx.ticketId}:`;
        const deadline = Date.now() + 300_000; // 5 min timeout

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));

          const [ticket] = await db
            .select({ notes: projectTickets.notes })
            .from(projectTickets)
            .where(eq(projectTickets.id, ctx.ticketId))
            .limit(1);

          const notes = ticket?.notes ?? "";
          const idx = notes.lastIndexOf(marker);
          if (idx !== -1) {
            const answer = notes.slice(idx + marker.length).split("\n")[0];
            // Clear the marker
            await db
              .update(projectTickets)
              .set({ notes: notes.slice(0, idx).trim(), updatedAt: new Date() })
              .where(eq(projectTickets.id, ctx.ticketId));
            return { answer };
          }
        }

        return { answer: "No response — proceed with your best judgment" };
      },
    }),

    searchKnowledge: tool({
      description:
        "Search the LFG knowledge base for implementation patterns and design guidelines. Use this BEFORE implementing common features like payments, auth, landing pages, dashboards, etc. Returns relevant code snippets and best practices.",
      inputSchema: zodSchema(
        z.object({
          query: z
            .string()
            .describe(
              "Search query describing what you need (e.g. 'stripe payment checkout', 'landing page hero section')"
            ),
          category: z
            .enum(["implementation", "design", "all"])
            .optional()
            .default("all")
            .describe("Filter by category (default: all)"),
          maxResults: z
            .number()
            .optional()
            .default(3)
            .describe("Max articles to return (default: 3)"),
        })
      ),
      execute: async ({ query, category, maxResults }) => {
        const results = matchKnowledge(query, { category, maxResults });
        if (results.length === 0) {
          return {
            found: false,
            message: "No matching knowledge articles found.",
            articles: [],
          };
        }
        return {
          found: true,
          articles: results.map((r) => ({
            title: r.title,
            category: r.category,
            content: r.content,
          })),
        };
      },
    }),
  };
}
