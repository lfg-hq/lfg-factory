/** Provider adapter. Never uses preview clones or follows provider-supplied URLs. */
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
  const get = async (path: string, payload?: Record<string, unknown>, method?: string): Promise<{ body: any; headers: Headers }> => {
    try {
      if (++requests > 600 || Date.now() > deadline) throw new GitProviderError('PROVIDER_BUDGET');
      const response = await fetcher(base + path, { method: method || (payload ? 'POST' : 'GET'), body: payload ? JSON.stringify(payload) : undefined, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'LFG', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(10_000) });
      const rawId = response.headers.get(gl ? 'x-request-id' : 'x-github-request-id');
      const id = rawId?.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 100);
      if (id && requestIds.size < 20) requestIds.add(id);
      if (!response.ok) throw new GitProviderError(response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') ? 'PROVIDER_RATE_LIMIT' : response.status === 401 || response.status === 403 ? 'PROVIDER_ACCESS_DENIED' : response.status === 404 ? 'PROVIDER_NOT_FOUND' : 'PROVIDER_HTTP_ERROR', response.status, id);
      if (response.status === 204) return { body: null, headers: response.headers };
      const reader = response.body?.getReader();
      if (!reader) throw new GitProviderError('PROVIDER_INVALID_RESPONSE');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new GitProviderError('PROVIDER_RESPONSE_TOO_LARGE', 422); }
          chunks.push(value);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        return { body: text ? JSON.parse(text) : null, headers: response.headers };
      } finally { reader.releaseLock(); }
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
    identity, provider, errors, requestIds, repositoryKey: base.toLowerCase(),
    info: async () => { const { body } = await get(''); if (!body.default_branch) throw new GitProviderError('PROVIDER_NO_DEFAULT_BRANCH'); return { defaultBranch: String(body.default_branch) }; },
    branches: () => pages<GitBranch>(gl ? '/repository/branches' : '/branches', b => ({ branch: b.name, headSha: gl ? b.commit.id : b.commit.sha, protected: !!b.protected })),
    pullRequests: (merged = false) => pages<GitPR>(gl ? `/merge_requests?state=${merged ? 'merged' : 'opened'}&scope=all` : `/pulls?state=${merged ? 'closed' : 'open'}&sort=updated&direction=desc`, pr),
    compare,
    ref: async (ref: string) => {
      const { body } = await get(gl ? `/repository/branches/${encodeURIComponent(ref)}` : `/branches/${encodeURIComponent(ref)}`);
      const sha = gl ? body.commit?.id : body.commit?.sha;
      if (!/^[a-f0-9]{40,64}$/.test(sha || '')) throw new GitProviderError('PROVIDER_INVALID_REVISION');
      return sha as string;
    },
    reviewChanges: async (baseSha: string, headSha: string) => {
      const { body } = await get(gl ? `/repository/compare?from=${baseSha}&to=${headSha}&straight=false` : `/compare/${baseSha}...${headSha}`);
      const files = gl ? body.diffs : body.files;
      if (!Array.isArray(files) || files.length >= (gl ? 100 : 300) || body.compare_timeout || body.compare_same_ref || body.overflow) throw new GitProviderError('DIFF_INCOMPLETE', 422);
      if (files.length > 40) throw new GitProviderError('DIFF_TOO_LARGE', 422);
      const included: { file: string; patch: string; context?: string; contextOmittedReason?: string }[] = [];
      const excluded: { file: string; reason: string }[] = [];
      let size = 0;
      for (const f of files) {
        const file = String(gl ? f.new_path : f.filename);
        if (!file || file.length > 500 || file.startsWith('/') || file.split('/').some(p => p === '..' || p === '.') || /[\x00-\x1f]/.test(file)) throw new GitProviderError('PROVIDER_INVALID_PATH', 422);
        const patch = gl ? f.diff : f.patch;
        // Never send obvious credential files or secret-bearing content to a model.
        const secret = /(^|\/)(\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|credentials(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519)$/i.test(file);
        const containsSecret = (s: string) => /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_|sk-proj-|AKIA)[A-Za-z0-9]{16,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(s);
        const patchIncomplete = !gl && typeof patch === 'string' && Number.isInteger(f.additions) && Number.isInteger(f.deletions) && patch.split('\n').filter((line: string) => /^[+-]/.test(line)).length !== f.additions + f.deletions;
        if (secret || !patch || patchIncomplete || f.collapsed || f.too_large || containsSecret(patch)) { excluded.push({ file, reason: secret ? 'secret file' : !patch ? 'binary or unavailable patch' : 'secret-bearing or incomplete patch' }); continue; }
        if ((size += patch.length) > 120_000) throw new GitProviderError('DIFF_TOO_LARGE', 422);
        const item: { file: string; patch: string; context?: string; contextOmittedReason?: string } = { file, patch, contextOmittedReason: 'Context file-count bound or deleted file; patch only.' };
        if (included.length < 6 && !(gl ? f.deleted_file : f.status === 'removed')) {
          const { body: content } = await get(gl ? `/repository/files/${encodeURIComponent(file)}?ref=${headSha}` : `/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${headSha}`);
          const decoded = content.encoding === 'base64' && content.size <= 20_000 ? Buffer.from(content.content || '', 'base64').toString('utf8') : '';
          if (decoded && !decoded.includes('\u0000') && !containsSecret(decoded)) { item.context = decoded; delete item.contextOmittedReason; }
          else item.contextOmittedReason = decoded ? 'Secret-bearing or binary context excluded; patch only.' : 'Context unavailable or over 20 KB; patch only.';
        }
        included.push(item);
      }
      return { files: included, excluded, limitations: ['Static review only; runtime tests were not executed.', 'Context is bounded to six source files of at most 20 KB; unchanged dependencies and runtime behavior are not exhaustively verified.'] };
    },
    createPullRequest: async (source: string, destination: string, title: string, body: string) => {
      const response = await get(gl ? '/merge_requests' : '/pulls', gl ? { source_branch: source, target_branch: destination, title, description: body } : { head: source, base: destination, title, body });
      const result = pr(response.body);
      if (!Number.isInteger(result.id) || !result.url?.startsWith('https://')) throw new GitProviderError('PROVIDER_INVALID_RESPONSE');
      return result;
    },
    pullRequest: async (number: number) => pr((await get(gl ? `/merge_requests/${number}` : `/pulls/${number}`)).body),
    mergeState: async (number: number) => {
      const { body: p } = await get(gl ? `/merge_requests/${number}` : `/pulls/${number}`);
      const pullRequest = pr(p);
      const blockers: string[] = [];
      if (pullRequest.draft) blockers.push('DRAFT');
      if (gl) {
        if (p.state !== 'opened' || p.detailed_merge_status !== 'mergeable' || p.has_conflicts !== false) blockers.push('PROVIDER_POLICY_OR_CONFLICT');
        const { body: approvals } = await get(`/merge_requests/${number}/approvals`);
        if (!Number.isInteger(approvals.approvals_left) || approvals.approvals_left !== 0) blockers.push('APPROVAL_REQUIRED_OR_UNKNOWN');
        if (p.head_pipeline && p.head_pipeline.status !== 'success') blockers.push('CHECKS_FAILED_OR_UNKNOWN');
      } else {
        // clean is the provider's aggregate policy verdict; blocked/unstable/behind/unknown never qualify.
        if (p.state !== 'open' || p.mergeable !== true || p.mergeable_state !== 'clean') blockers.push('PROVIDER_POLICY_OR_CONFLICT');
        const [{ body: status }, { body: checks }] = await Promise.all([get(`/commits/${pullRequest.headSha}/status`), get(`/commits/${pullRequest.headSha}/check-runs?per_page=100`)]);
        if ((status.total_count > 0 && status.state !== 'success') || !Number.isInteger(status.total_count) || !Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length || checks.check_runs.some((c: any) => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion))) blockers.push('CHECKS_FAILED_OR_UNKNOWN');
        // Rulesets can require a merge queue; never bypass it with the REST merge endpoint.
        const { body: rules } = await get(`/rules/branches/${encodeURIComponent(pullRequest.destination)}`);
        if (!Array.isArray(rules) || rules.some((r: any) => r.type === 'merge_queue')) blockers.push('UNSUPPORTED_MERGE_QUEUE');
      }
      return { pullRequest, blockers, policy: gl ? p.detailed_merge_status : p.mergeable_state,
        states: { draft: pullRequest.draft, conflicts: gl ? p.has_conflicts === false ? 'none' : 'present or unknown' : p.mergeable === true ? 'none' : 'present or unknown', checks: blockers.includes('CHECKS_FAILED_OR_UNKNOWN') || blockers.includes('PROVIDER_POLICY_OR_CONFLICT') ? 'failed, pending or unknown' : 'provider satisfied', reviews: blockers.includes('APPROVAL_REQUIRED_OR_UNKNOWN') || blockers.includes('PROVIDER_POLICY_OR_CONFLICT') ? 'missing or unknown' : 'provider policy satisfied', protection: blockers.includes('UNSUPPORTED_MERGE_QUEUE') ? 'merge queue — use provider' : 'provider policy authoritative' } };
    },
    mergePullRequest: async (number: number, sha: string) => {
      const info = (await get('')).body;
      const method = gl ? undefined : info.allow_merge_commit ? 'merge' : info.allow_squash_merge ? 'squash' : info.allow_rebase_merge ? 'rebase' : null;
      if (method === null) throw new GitProviderError('NO_SUPPORTED_MERGE_METHOD', 409);
      await get(gl ? `/merge_requests/${number}/merge` : `/pulls/${number}/merge`, gl ? { sha, should_remove_source_branch: false } : { sha, merge_method: method }, 'PUT');
      const result = pr((await get(gl ? `/merge_requests/${number}` : `/pulls/${number}`)).body);
      if (!result.merged || !result.mergeSha || result.headSha !== sha) throw new GitProviderError('MERGE_OUTCOME_UNCERTAIN', 409);
      return result;
    },
    deleteBranch: async (branch: string) => { await get(gl ? `/repository/branches/${encodeURIComponent(branch)}` : `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, undefined, 'DELETE'); },
    diagnostics: () => ({ requests, providerRequestIds: [...requestIds], retryCount: 0 }),
  };
}
export type GitProvider = ReturnType<typeof createGitProvider>;
