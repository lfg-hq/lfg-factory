/**
 * Branch comparison tool: ahead/behind counts for the project's branches, read from
 * the GitHub API with the project's effective Git token (same resolution as
 * queryCodebase). Read-only.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { projects } from "../../db/schema/projects.ts";
import { githubTokens } from "../../db/schema/users.ts";
import { resolveGitActor } from "../../services/git-access.ts";
import { compareGithubBranches } from "../../services/ticket-diff-github.ts";
import { resolveRepo } from "./codebase-tools.ts";

export const compareBranches = tool({
  description:
    "Compare the project's Git branches with a base branch on GitHub: for each branch, how many commits it is ahead of and behind the base, its status (ahead / behind / diverged / identical) and its last commit date. " +
    "Use this for any question like 'which branches are out of date', 'how far behind is X', or 'what hasn't been merged'. " +
    "Do NOT run git commands through inspectPreview for this: the preview's clone is shallow, so its counts are wrong. " +
    "`base` defaults to the repo's real default branch on GitHub. Note `lfg-agent` is LFG's legacy anchor branch, not necessarily the default branch; compare against it only when the user asks. " +
    "Returns at most 50 branches (`truncated` says if more matched; narrow with `branches`). If this returns an error, report it as written; only tell the user to connect GitHub when the error says no token is connected.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string().describe("The project ID"),
      userId: z.string().describe("The user ID"),
      base: z.string().optional().describe("Branch to compare against. Default: the repo's default branch on GitHub."),
      branches: z.array(z.string()).optional().describe("Only these branches: exact names or substrings (e.g. 'feature/'). Default: all branches."),
    })
  ),
  execute: async ({ projectId, userId, base, branches }) => {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return { error: "Project not found" };
    const repo = resolveRepo(project);
    if (!repo) return { error: "No repository is linked to this project yet, so there are no branches to compare." };
    if ((project as { repoProvider?: string }).repoProvider === "gitlab") {
      return { error: "Branch comparison only supports GitHub repositories for now; this project uses GitLab." };
    }
    const gitActor = resolveGitActor(project, userId);
    const [ghToken] = await db.select().from(githubTokens).where(eq(githubTokens.userId, gitActor.gitUserId)).limit(1);
    if (!ghToken?.accessToken) {
      const ownHint = gitActor.usingOwnCollaboratorToken ? " This project doesn't share the owner's Git — ask the owner to enable “Share Git access”." : "";
      return { error: `No GitHub token is connected. Connect GitHub in Settings to compare branches.${ownHint}` };
    }
    try {
      const result = await compareGithubBranches({ owner: repo.owner, repo: repo.repo, token: ghToken.accessToken }, { base, only: branches });
      return result.error ? { error: result.error, base: result.base, defaultBranch: result.defaultBranch } : result;
    } catch (e) {
      return { error: `Couldn't reach GitHub to compare branches: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
