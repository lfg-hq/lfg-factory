/**
 * Codebase Query Tool
 *
 * Answers questions about the project's linked GitHub repo by running a small
 * agentic loop IN-PROCESS (no sandbox): the model gets a repo map and reads
 * files / greps on demand via the GitHub API. Runs on the provider's lite model
 * with prompt caching, and works with any provider. See
 * services/codebase-query-api.ts and services/github-reader.ts.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { projects } from "../../db/schema/projects.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { githubTokens, llmApiKeys } from "../../db/schema/users.ts";
import { modelSelections } from "../../db/schema/chat.ts";
import { queryCodebaseInProcess } from "../../services/codebase-query-api.ts";
import { getValidGitlabToken } from "../../services/gitlab-token.ts";
import { resolveGitActor } from "../../services/git-access.ts";
import { resolveLlmGrants, llmKeyUserId } from "../../services/llm-access.ts";
import { DEFAULT_MODEL_KEY, type UserApiKeys } from "../provider.ts";
import { eq } from "drizzle-orm";

/** Derive owner/repo from stored fields, falling back to parsing repoUrl (GitHub or GitLab). */
function resolveRepo(project: {
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
}): { owner: string; repo: string } | null {
  if (project.repoOwner && project.repoName) {
    return { owner: project.repoOwner, repo: project.repoName };
  }
  if (project.repoUrl) {
    const m = project.repoUrl.match(/(?:github|gitlab)\.com[/:]([^/]+(?:\/[^/]+)*)\/([^/.]+)/);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  return null;
}

export const queryCodebase = tool({
  description:
    "Query the project's codebase to answer questions about code structure, " +
    "find implementations, understand patterns, or explore the repository. " +
    "Reads the linked GitHub/GitLab repo directly (file map + on-demand file reads / grep) at ANY branch. " +
    "Use this when the user asks about their code — how something works, " +
    "where something is defined, code architecture, etc. " +
    "IMPORTANT: when the question is about the work done ON A TICKET (its changes, what a ticket implemented, or reviewing/critiquing a ticket's output), pass that ticket's `ticketId` so this reads the ticket's FEATURE branch — the ticket's changes live there, NOT on the default branch. Pass `branch` directly if you already know the branch name.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string().describe("The project ID"),
      userId: z.string().describe("The user ID"),
      question: z.string().describe("The question about the codebase"),
      ticketId: z
        .string()
        .optional()
        .describe("If the question is about a specific ticket's work, pass its ticket ID — the query then reads that ticket's feature branch (its changes) instead of the default branch."),
      branch: z
        .string()
        .optional()
        .describe("Git branch to query. Default: the repo's default branch. Ignored if ticketId is given."),
    })
  ),
  execute: async ({ projectId, userId, question, ticketId, branch }) => {
    // 1. Load project → resolve owner/repo
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return { error: "Project not found" };

    const repo = resolveRepo(project);
    if (!repo) {
      return {
        error: "No repository linked to this project. Connect a GitHub or GitLab repo first.",
      };
    }

    const provider = (project as { repoProvider?: string }).repoProvider === "gitlab" ? "gitlab" : "github";

    // If the question is about a ticket's work, read THAT ticket's feature branch
    // (its changes live there, not on the default branch).
    let effectiveBranch = branch;
    if (ticketId) {
      const [tk] = await db
        .select({ gb: projectTickets.githubBranch })
        .from(projectTickets)
        .where(eq(projectTickets.id, ticketId))
        .limit(1);
      effectiveBranch = tk?.gb || `feature/ticket-${ticketId}`;
    }

    // Fine-grained sharing: read the repo with the acting user's EFFECTIVE Git token
    // (owner's when "Share Git access" is on, else their own) and run the lite query on
    // the effective LLM key (owner's when granted "use my API keys", else their own) —
    // so a collaborator can explore the codebase using the owner's access when allowed.
    const gitActor = resolveGitActor(project, userId);
    const keyUserId = llmKeyUserId(await resolveLlmGrants(project, userId), userId);
    const ownHint = gitActor.usingOwnCollaboratorToken ? " This project doesn't share the owner's Git — ask the owner to enable “Share Git access”." : "";

    // 2. Load the repo provider's token for the effective Git user
    let accessToken: string | undefined;
    if (provider === "gitlab") {
      accessToken = (await getValidGitlabToken(gitActor.gitUserId)) ?? undefined;
      if (!accessToken) {
        return { error: `No valid GitLab token. Reconnect GitLab in Settings to query the codebase.${ownHint}` };
      }
    } else {
      const [ghToken] = await db
        .select()
        .from(githubTokens)
        .where(eq(githubTokens.userId, gitActor.gitUserId))
        .limit(1);
      accessToken = ghToken?.accessToken;
      if (!accessToken) {
        return { error: `No GitHub token found. Connect GitHub in Settings to query the codebase.${ownHint}` };
      }
    }

    // 3. Resolve the model (acting user's CHOICE) + keys (effective key user — owner's
    //    when granted). Query runs on the lite tier of whichever provider is selected.
    const [modelSel] = await db
      .select()
      .from(modelSelections)
      .where(eq(modelSelections.userId, userId));
    const [apiKeys] = await db
      .select()
      .from(llmApiKeys)
      .where(eq(llmApiKeys.userId, keyUserId));

    const modelKey = modelSel?.selectedModel ?? DEFAULT_MODEL_KEY;
    const userApiKeys: UserApiKeys | undefined = apiKeys
      ? {
          anthropic: apiKeys.anthropicApiKey ?? undefined,
          openai: apiKeys.openaiApiKey ?? undefined,
          google: apiKeys.googleApiKey ?? undefined,
          kimi: apiKeys.kimiApiKey ?? undefined,
          deepseek: apiKeys.deepseekApiKey ?? undefined,
          glm: apiKeys.glmApiKey ?? undefined,
        }
      : undefined;

    // 4. Run the in-process query (streams chunks to the user via WS)
    try {
      const result = await queryCodebaseInProcess({
        owner: repo.owner,
        repo: repo.repo,
        question,
        githubToken: accessToken,
        provider,
        modelKey,
        userApiKeys,
        branch: effectiveBranch,
        userId,
      });
      return { answer: result.answer, branch: result.branch };
    } catch (err) {
      console.error(`[queryCodebase] Query failed:`, err);
      return {
        error: `Codebase query failed: ${(err as Error).message?.slice(0, 300)}`,
      };
    }
  },
});
