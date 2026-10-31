// Labelled API/RBAC fixtures in an isolated test-only SQLite database.
import { test, expect, mock, afterAll } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
const root = mkdtempSync(join(tmpdir(), 'git-api-fixture-'));
process.env.DATABASE_DRIVER = 'sqlite'; process.env.DATABASE_URL = join(root, 'fixture.db');
process.env.BETTER_AUTH_SECRET = 'fixture-only-auth-secret'; process.env.BETTER_AUTH_URL = 'http://localhost:8080';
const gen = Bun.spawnSync(['bun','node_modules/drizzle-kit/bin.cjs','generate','--dialect','sqlite','--schema','./src/db/schema/sqlite/index.ts','--out',join(root,'schema')]);
if (gen.exitCode) throw new Error(gen.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root,'schema')).filter(f => f.endsWith('.sql'))) sqlite.exec(readFileSync(join(root,'schema',f),'utf8'));
sqlite.close();
mock.module('../src/auth/middleware.ts', () => ({ requireAuth: async (c:any,next:any) => { c.set('user',{id:c.req.header('x-fixture-user') || 'member'}); await next(); } }));
const { db } = await import('../src/config/db.ts');
const { users, githubTokens } = await import('../src/db/schema/users.ts');
const { projects, projectMembers } = await import('../src/db/schema/projects.ts');
const { organizations, orgMemberships } = await import('../src/db/schema/organizations.ts');
const { default: api } = await import('../src/routes/api/git.ts');
for (const id of ['owner','member','outsider']) await db.insert(users).values({id,name:id,email:`${id}@fixture.invalid`});
await db.insert(organizations).values({id:'team',name:'Fixture',slug:'fixture',ownerId:'owner'});
await db.insert(orgMemberships).values({id:'member-team',organizationId:'team',userId:'member',role:'viewer'});
await db.insert(projects).values({id:'internal',projectId:'public',name:'Fixture',ownerId:'owner',organizationId:'team',repoOwner:'fixture',repoName:'repo',repoProvider:'github',repoUrl:'https://github.com/fixture/repo',shareGitAccess:false});
await db.insert(projectMembers).values({id:'membership',projectId:'internal',userId:'member',role:'viewer',canEditFiles:false});
await db.insert(githubTokens).values({userId:'owner',accessToken:'fixture-owner-token',githubUsername:'fixture'});
const request = (path:string,user='member') => api.request(path,{headers:{'x-fixture-user':user}});
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; rmSync(root,{recursive:true,force:true}); });
test('cross-project access and credential sharing denial fail safely with correlation logs', async () => {
  const logs:string[]=[]; const log = console.log; console.log = (...v) => logs.push(v.join(' '));
  try {
    const denied = await request('/projects/public/git/branches','outsider'); expect(denied.status).toBe(404);
    const disconnected = await request('/projects/public/git/branches'); expect(disconnected.status).toBe(403);
    const body = await disconnected.json(); expect(body.code).toBe('GIT_DISCONNECTED'); expect(body.correlationId).toBeTruthy();
    expect(logs.map(l=>JSON.parse(l)).some(l=>l.outcome==='failed' && l.durationMs>=0 && l.correlationId && l.timestamp)).toBe(true);
    expect(logs.join(' ')).not.toContain('fixture-owner-token');
    expect((await request('/projects/internal/git/branches','owner')).status).toBe(404);
  } finally { console.log=log; }
});
test('shared read-only viewer gets paginated provider results; denied provider logs are sanitized', async () => {
  await db.update(projects).set({shareGitAccess:true}).where(eq(projects.id,'internal'));
  const logs:string[]=[]; const log=console.log; console.log=(...v)=>logs.push(v.join(' '));
  let denied=false;
  globalThis.fetch = (async (url: string, init:RequestInit) => {
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer fixture-owner-token');
    if (denied) return new Response('fixture private body',{status:403,headers:{'x-github-request-id':'fixture-provider-id'}});
    if (new URL(url).pathname.endsWith('/repo')) return Response.json({default_branch:'main'});
    return Response.json([]);
  }) as typeof fetch;
  try {
    const response = await request('/projects/public/git/pull-requests?repoOwner=attacker'); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({readOnly:true,canManageCode:false,completeness:{complete:true}});
    denied=true;
    const failure=await request('/projects/public/git/branches'); expect(failure.status).toBe(403);
    expect(await failure.json()).toMatchObject({code:'PROVIDER_ACCESS_DENIED'});
    const records=logs.map(l=>JSON.parse(l));
    expect(records.some(l=>l.event==='git.provider.completed' && l.outcome==='completed' && l.provider==='github')).toBe(true);
    expect(records.some(l=>l.event==='git.provider.failed' && l.errorCode==='PROVIDER_ACCESS_DENIED' && l.providerRequestId==='fixture-provider-id')).toBe(true);
    expect(logs.join(' ')).not.toMatch(/fixture-owner-token|private body|Authorization/);
  } finally { console.log=log; globalThis.fetch=originalFetch; }
});
test('conflicting stored repository identity cannot send a token to another repository', async () => {
  await db.update(projects).set({repoUrl:'https://github.com/other/repo'}).where(eq(projects.id,'internal'));
  const response=await request('/projects/public/git/branches','owner'); expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({code:'REPOSITORY_IDENTITY_MISMATCH'});
});
