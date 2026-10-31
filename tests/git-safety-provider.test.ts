// TEST-ONLY provider HTTP fixtures. No live repository requests or mutations.
import { test, expect } from 'bun:test';
import { createGitProvider } from '../src/services/git-provider.ts';
test('GitLab native merge requires approval/pipeline/policy and verifies resulting SHA; delete never requests automatic removal', async () => {
  const sha = 'a'.repeat(40); let approvals = 1, pipeline = 'success', state = 'mergeable', merged = false, deletes = 0;
  const calls: any[] = [];
  const mr = () => ({ iid: 7, title: 'TEST FIXTURE', web_url: 'https://gitlab.com/fixture/repo/-/merge_requests/7', source_branch: 'feature', target_branch: 'main', sha, source_project_id: 1, target_project_id: 1, state: merged ? 'merged' : 'opened', detailed_merge_status: state, has_conflicts: false, head_pipeline: { status: pipeline }, merge_commit_sha: merged ? 'b'.repeat(40) : null });
  const provider = createGitProvider({ provider: 'gitlab', owner: 'fixture', repo: 'repo', token: 'test-only-token' }, (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname; calls.push({ path, method: init.method, body: init.body });
    if (path.endsWith('/approvals')) return Response.json({ approvals_left: approvals });
    if (path.endsWith('/merge') && init.method === 'PUT') { expect(JSON.parse(init.body as string)).toEqual({ sha, should_remove_source_branch: false }); merged = true; return Response.json(mr()); }
    if (path.endsWith('/merge_requests/7')) return Response.json(mr());
    if (path.includes('/repository/branches/') && init.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }); }
    return Response.json({ default_branch: 'main' });
  }) as typeof fetch);
  expect((await provider.mergeState(7)).blockers).toContain('APPROVAL_REQUIRED_OR_UNKNOWN'); approvals = 0;
  pipeline = 'failed'; expect((await provider.mergeState(7)).blockers).toContain('CHECKS_FAILED_OR_UNKNOWN'); pipeline = 'success';
  state = 'checking'; expect((await provider.mergeState(7)).blockers).toContain('PROVIDER_POLICY_OR_CONFLICT'); state = 'mergeable';
  expect((await provider.mergeState(7)).blockers).toEqual([]); expect((await provider.mergePullRequest(7, sha)).merged).toBe(true);
  await provider.deleteBranch('old/feature'); expect(deletes).toBe(1); expect(calls.at(-1).path).toContain('old%2Ffeature');
});
