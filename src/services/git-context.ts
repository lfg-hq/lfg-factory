import { db } from '../config/db.ts';
import { eq } from 'drizzle-orm';
import { githubTokens } from '../db/schema/users.ts';
import { env } from '../config/env.ts';
import { resolveGitActor } from './git-access.ts';
import { getValidGitlabToken } from './gitlab-token.ts';
import { createGitProvider, GitProviderError } from './git-provider.ts';

/** Resolve credentials anew for requests and durable jobs; never persist them. */
export async function gitContext(project: any, userId: string) {
  const actor = resolveGitActor(project, userId);
  const provider = project.repoProvider === 'gitlab' ? 'gitlab' : 'github';
  const owner = project.repoOwner, repo = project.repoName?.replace(/\.git$/, '');
  if (!owner || !repo) throw new GitProviderError('NO_REPOSITORY', 400);
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(owner) || !/^[\w.-]+$/.test(repo) || `${owner}/${repo}`.split('/').some(s => s === '.' || s === '..')) throw new GitProviderError('REPOSITORY_IDENTITY_INVALID', 400);
  if (project.repoUrl) {
    const url = new URL(project.repoUrl);
    if (url.protocol !== 'https:' || url.host !== (provider === 'gitlab' ? new URL(env.GITLAB_BASE_URL).host : 'github.com') || url.username || url.password || decodeURIComponent(url.pathname).replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '') !== `${owner}/${repo}`) throw new GitProviderError('REPOSITORY_IDENTITY_MISMATCH', 400);
  }
  const token = provider === 'gitlab' ? await getValidGitlabToken(actor.gitUserId) : (await db.select().from(githubTokens).where(eq(githubTokens.userId, actor.gitUserId)).limit(1))[0]?.accessToken;
  if (!token) throw new GitProviderError('GIT_DISCONNECTED', 403);
  return createGitProvider({ provider, owner, repo, token, gitlabBaseUrl: env.GITLAB_BASE_URL });
}
