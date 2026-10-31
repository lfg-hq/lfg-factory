import { test, expect } from 'bun:test';
import { createGitProvider, type GitPR } from '../src/services/git-provider.ts';
import { integrationFor, buildGitWorkspace } from '../src/services/git-workspace.ts';
// Labelled deterministic provider fixtures — not live provider evidence.
const config = { provider: 'github' as const, owner: 'fixture', repo: 'repo', token: 'fixture-token' };
const branch = (branch: string, headSha = branch) => ({ branch, headSha, protected: false });
const merged: GitPR = { id: 7, title: 'fixture squash', url: 'https://github.com/fixture/repo/pull/7', source: 'ticket', destination: 'epic', headSha: 't1', sourceRepo: 'fixture/repo', draft: false, merged: true, mergeSha: 'squash' };
const cmp = async (base: string, head: string) => ({ ahead: head === 'squash' ? 0 : 2, behind: 1, complete: true });
test('exact-head squash/rebase evidence is destination aware and ignores later branch commits/forks', async () => {
  const history = { items: [merged], complete: true, errors: [] };
  expect((await integrationFor(branch('ticket','t1'), branch('epic'), history, 'fixture/repo', cmp)).status).toBe('integrated');
  expect((await integrationFor(branch('ticket','t2'), branch('epic'), history, 'fixture/repo', cmp)).status).toBe('not_integrated');
  expect((await integrationFor(branch('ticket','t1'), branch('main'), history, 'fixture/repo', cmp)).status).toBe('not_integrated');
  expect((await integrationFor(branch('ticket','t1'), branch('epic'), history, 'other/repo', cmp)).status).toBe('not_integrated');
  expect((await integrationFor(branch('ticket','t1'), branch('epic'), history, 'fixture/repo', async () => ({ ahead: 1, behind: 0, complete: true }))).status).toBe('not_integrated');
});
test('missing refs, unknown comparison and partial merge evidence never count merged; identical refs do', async () => {
  const history = { items: [], complete: false, errors: [] };
  expect((await integrationFor(undefined, branch('epic'), history, 'fixture/repo', cmp)).status).toBe('unknown');
  expect((await integrationFor(branch('t'), branch('epic'), history, 'fixture/repo', cmp)).status).toBe('unknown');
  expect((await integrationFor(branch('t'), branch('epic'), { ...history, complete: true }, 'fixture/repo', async () => ({ ahead: null, behind: null, complete: false }))).status).toBe('unknown');
  const provider = createGitProvider(config);
  expect((await integrationFor(branch('t','same'), branch('e','same'), history, 'fixture/repo', provider.compare)).evidence).toContain('Identical');
});
test('GitHub paginates all branches and PRs without filtering drafts or forks', async () => {
  const seen: string[] = [];
  const provider = createGitProvider(config, (async (url: string) => {
    const u = new URL(url); seen.push(u.pathname + u.search);
    const page = Number(u.searchParams.get('page'));
    const body = u.pathname.endsWith('/branches') ? [branch('fixture')].map(b => ({name:b.branch,commit:{sha:'h'}})) : [{ number: page, title: 'fixture external', head: { ref: 'fork', sha: 'h', repo: { full_name: 'external/fork' } }, base: { ref: 'main' }, draft: true }];
    return Response.json(body, { headers: page === 1 ? { link: '<https://api.github.com/ignored>; rel="next"' } : {} });
  }) as typeof fetch);
  const branches = await provider.branches(), prs = await provider.pullRequests();
  expect(branches.items.length).toBe(2); expect(branches.complete).toBe(true);
  expect(prs.items.length).toBe(2); expect(prs.items[0]).toMatchObject({ draft: true, sourceRepo: 'external/fork' });
  expect(seen.filter(s => s.includes('page=2')).length).toBe(2);
});
test('GitLab pagination retains external MRs and denied later pages return explicit partial errors', async () => {
  const provider = createGitProvider({ ...config, provider: 'gitlab', owner: 'group/subgroup' }, (async (url: string) => {
    const u = new URL(url);
    expect(u.pathname).toContain('group%2Fsubgroup%2Frepo');
    if (u.searchParams.get('page') === '2') return new Response('private secret body must not escape', {status:403, headers:{'x-request-id':'safe-id'}});
    return Response.json([{iid:2,title:'fixture external',source_branch:'fork',target_branch:'epic',source_project_id:4,target_project_id:5,draft:true}],{headers:{'x-next-page':'2'}});
  }) as typeof fetch);
  const prs = await provider.pullRequests();
  expect(prs.complete).toBe(false); expect(prs.items[0]?.draft).toBe(true); expect(prs.items[0]?.sourceRepo).toBeNull();
  expect(prs.errors).toEqual([{code:'PROVIDER_ACCESS_DENIED',providerRequestId:'safe-id'}]);
  expect(JSON.stringify(prs)).not.toContain('secret body');
});
test('page bounds and GitLab comparison timeouts remain explicitly incomplete', async () => {
  let calls = 0;
  const bounded = createGitProvider(config, (async () => { calls++; return Response.json([], { headers: { link: '<https://api.github.com/fixture>; rel="next"' } }); }) as typeof fetch);
  const list = await bounded.branches();
  expect(calls).toBe(100); expect(list.complete).toBe(false); expect(list.errors[0]?.code).toBe('PROVIDER_PAGE_LIMIT');
  const gitlab = createGitProvider({ ...config, provider: 'gitlab' }, (async () => Response.json({ compare_timeout: true, commits: [] })) as typeof fetch);
  expect(await gitlab.compare('base','head')).toEqual({ahead:null,behind:null,complete:false});
  expect(gitlab.errors[0]?.code).toBe('PROVIDER_COMPARISON_INCOMPLETE');
});
test('stored IDs, missing branches, stacked epic destinations, default and Other remain distinct', async () => {
  const provider = createGitProvider(config, (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/repo')) return Response.json({ default_branch: 'main' });
    if (u.pathname.endsWith('/branches')) return Response.json(['main','epic/one','epic/two','free','legacy'].map(name => ({name,commit:{sha:name}})));
    if (u.pathname.endsWith('/pulls')) return Response.json([]);
    return Response.json({ ahead_by: 0, behind_by: 0 });
  }) as typeof fetch);
  const workspace = await buildGitWorkspace(provider, [{id:'e1',name:'First',epicKey:'E1',branch:'epic/one',baseBranch:'main',baseSha:'m0'},{id:'e2',name:'Stacked',epicKey:'E2',branch:'epic/two',baseBranch:'epic/one',baseSha:'e0'}], [{id:'t1',title:'Missing',epicId:'e1',githubBranch:'deleted',status:'done',destination:'epic/one'}], 't1');
  expect(workspace.epics[1]?.destination).toBe('epic/one');
  expect(workspace.epics[0]?.tickets[0]).toMatchObject({ id:'t1', missingRef:true, integration:{status:'unknown'}, activeUse:{preview:true} });
  expect(workspace.other.map(b => b.branch)).toEqual(['free','legacy']);
  expect(workspace.defaultBranch.branch).toBe('main'); expect(workspace.totals.tickets.unknown).toBe(1);
  expect(workspace.completeness.complete).toBe(false);
});
