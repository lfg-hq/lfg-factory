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
import { githubTokens, llmApiKeys } from "../../db/schema/users.ts";
import { modelSelections } from "../../db/schema/chat.ts";
import { queryCodebaseInProcess } from "../../services/codebase-query-api.ts";
import { getValidGitlabToken } from "../../services/gitlab-token.ts";
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
    "Reads the linked GitHub repo directly (file map + on-demand file reads / grep). " +
    "Use this when the user asks about their code — how something works, " +
    "where something is defined, code architecture, etc.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string().describe("The project ID"),
      userId: z.string().describe("The user ID"),
      question: z.string().describe("The question about the codebase"),
      branch: z
        .string()
        .optional()
        .describe("Git branch to query. Default: the repo's default branch."),
    })
  ),
  execute: async ({ projectId, userId, question, branch }) => {
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

    // 2. Load the repo provider's token for the user
    let accessToken: string | undefined;
    if (provider === "gitlab") {
      accessToken = (await getValidGitlabToken(userId)) ?? undefined;
      if (!accessToken) {
        return { error: "No valid GitLab token. Reconnect GitLab in Settings to query the codebase." };
      }
    } else {
      const [ghToken] = await db
        .select()
        .from(githubTokens)
        .where(eq(githubTokens.userId, userId))
        .limit(1);
      accessToken = ghToken?.accessToken;
      if (!accessToken) {
        return { error: "No GitHub token found. Connect GitHub in Settings to query the codebase." };
      }
    }

    // 3. Resolve the user's selected model + keys (query runs on the lite tier
    //    of whichever provider the user is on).
    const [modelSel] = await db
      .select()
      .from(modelSelections)
      .where(eq(modelSelections.userId, userId));
    const [apiKeys] = await db
      .select()
      .from(llmApiKeys)
      .where(eq(llmApiKeys.userId, userId));

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
        branch,
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
