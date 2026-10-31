/** Read-only provider adapter. Never uses preview clones or follows provider-supplied URLs. */
export type GitBranch = { branch: string; headSha: string; protected: boolean };
export type GitPR = { id: number; title: string; url: string; source: string; destination: string; headSha: string; sourceRepo: string | null; draft: boolean; merged: boolean; mergeSha: string | null };
export type GitIssue = { code: string; providerRequestId?: string };
export type GitPage<T> = { items: T[]; complete: boolean; errors: GitIssue[] };
export type GitComparison = { ahead: number | null; behind: number | null; complete: boolean };
export class GitProviderError extends Error {
  constructor(public code: string, public status = 502, public providerRequestId?: string) { super(code); }
}
export type GitProviderConfig = { provider: 'github' | 'gitlab'; owner: string; repo: string; token: string; gitlabBaseUrl?: string };
export function createGitProvider(config: GitProviderConfig, fetcher: typeof fetch = fetch) {
  const { provider, owner, repo, token } = config;
  const gl = provider === 'gitlab';
  const identity = `${owner}/${repo}`;
  const base = gl ? `${(config.gitlabBaseUrl || 'https://gitlab.com').replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(identity)}` : `https://api.github.com/repos/${owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(repo)}`;
  const errors: GitIssue[] = [];
  const requestIds = new Set<string>();
  let requests = 0;
  const deadline = Date.now() + 45_000;
  const get = async (path: string): Promise<{ body: any; headers: Headers }> => {
    try {
      if (++requests > 600 || Date.now() > deadline) throw new GitProviderError('PROVIDER_BUDGET');
      const response = await fetcher(base + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'LFG', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(10_000) });
      const rawId = response.headers.get(gl ? 'x-request-id' : 'x-github-request-id');
      const id = rawId?.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 100);
      if (id && requestIds.size < 20) requestIds.add(id);
      if (!response.ok) throw new GitProviderError(response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') ? 'PROVIDER_RATE_LIMIT' : response.status === 401 || response.status === 403 ? 'PROVIDER_ACCESS_DENIED' : response.status === 404 ? 'PROVIDER_NOT_FOUND' : 'PROVIDER_HTTP_ERROR', response.status, id);
      return { body: await response.json(), headers: response.headers };
    } catch (e) {
      const error = e instanceof GitProviderError ? e : new GitProviderError('PROVIDER_UNAVAILABLE');
      errors.push({ code: error.code, providerRequestId: error.providerRequestId });
      throw error;
    }
  };
  async function pages<T>(path: string, normalize: (row: any) => T): Promise<GitPage<T>> {
    const items: T[] = [];
    try {
      for (let page = 1; page <= 100; page++) {
        const { body, headers } = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Array.isArray(body)) throw new GitProviderError('PROVIDER_INVALID_RESPONSE');
        items.push(...body.map(normalize));
        const hasNext = gl ? !!headers.get('x-next-page') : /rel="next"/.test(headers.get('link') || '');
        if (!hasNext && body.length < 100) return { items, complete: true, errors: [] };
        // An explicit terminal pagination header can finish an exactly-full page.
        if (gl && headers.has('x-next-page') && !hasNext) return { items, complete: true, errors: [] };
        if (!gl && headers.has('link') && !hasNext) return { items, complete: true, errors: [] };
      }
      return { items, complete: false, errors: [{ code: 'PROVIDER_PAGE_LIMIT' }] };
    } catch (e) {
      const err = e instanceof GitProviderError ? e : new GitProviderError('PROVIDER_INVALID_RESPONSE');
      return { items, complete: false, errors: [{ code: err.code, providerRequestId: err.providerRequestId }] };
    }
  }
  const pr = (p: any): GitPR => gl ? ({ id: p.iid, title: p.title, url: p.web_url, source: p.source_branch, destination: p.target_branch, headSha: p.sha || p.diff_refs?.head_sha || '', sourceRepo: p.source_project_id === p.target_project_id ? identity : null, draft: !!(p.draft || p.work_in_progress), merged: p.state === 'merged', mergeSha: p.merge_commit_sha || p.squash_commit_sha || null }) : ({ id: p.number, title: p.title, url: p.html_url, source: p.head?.ref || '', destination: p.base?.ref || '', headSha: p.head?.sha || '', sourceRepo: p.head?.repo?.full_name || null, draft: !!p.draft, merged: !!p.merged_at, mergeSha: p.merge_commit_sha || null });
  async function compare(destinationSha: string, headSha: string): Promise<GitComparison> {
    if (destinationSha === headSha) return { ahead: 0, behind: 0, complete: true };
    try {
      if (!gl) {
        const { body } = await get(`/compare/${encodeURIComponent(destinationSha)}...${encodeURIComponent(headSha)}`);
        const valid = Number.isInteger(body.ahead_by) && body.ahead_by >= 0 && Number.isInteger(body.behind_by) && body.behind_by >= 0;
        if (!valid) errors.push({ code: 'PROVIDER_COMPARISON_INCOMPLETE' });
        return { ahead: valid ? body.ahead_by : null, behind: valid ? body.behind_by : null, complete: valid };
      }
      // GitLab compare is paginated/truncated on large histories and has no ahead/behind counters.
      // Count each direction only when the API explicitly confirms no timeout/truncation.
      const count = async (from: string, to: string) => {
        const { body } = await get(`/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=false`);
        return body.compare_timeout === false && Array.isArray(body.commits) && body.commits.length < 1000 ? body.commits.length : null;
      };
      const ahead = await count(destinationSha, headSha);
      const behind = await count(headSha, destinationSha);
      if (ahead === null || behind === null) errors.push({ code: 'PROVIDER_COMPARISON_INCOMPLETE' });
      return { ahead, behind, complete: ahead !== null && behind !== null };
    } catch { return { ahead: null, behind: null, complete: false }; }
  }
  return {
    identity, provider, errors, requestIds,
    info: async () => { const { body } = await get(''); if (!body.default_branch) throw new GitProviderError('PROVIDER_NO_DEFAULT_BRANCH'); return { defaultBranch: String(body.default_branch) }; },
    branches: () => pages<GitBranch>(gl ? '/repository/branches' : '/branches', b => ({ branch: b.name, headSha: gl ? b.commit.id : b.commit.sha, protected: !!b.protected })),
    pullRequests: (merged = false) => pages<GitPR>(gl ? `/merge_requests?state=${merged ? 'merged' : 'opened'}&scope=all` : `/pulls?state=${merged ? 'closed' : 'open'}&sort=updated&direction=desc`, pr),
    compare,
    diagnostics: () => ({ requests, providerRequestIds: [...requestIds], retryCount: 0 }),
  };
}
export type GitProvider = ReturnType<typeof createGitProvider>;
