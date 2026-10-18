import { expect, test } from 'bun:test';
import { environmentFingerprint, environmentChanges, requiresEnvironmentBuild, environmentPatchCommand } from '../src/services/preview-environment.ts';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellQuote } from '../src/services/preview-plan.ts';

test('snapshots detect additions, edits, deletions and edits made during a run without exposing values', () => {
  const atStart = environmentFingerprint({TOKEN: 'old secret', REMOVED: 'value'});
  const snapshot = {values: atStart, appliedAt: 'today'};
  expect(JSON.stringify(snapshot)).not.toContain('old secret');
  expect(environmentChanges(environmentFingerprint({TOKEN: 'new secret', NEW: 'yes'}), snapshot)).toEqual(['NEW', 'REMOVED', 'TOKEN']);
  expect(environmentChanges(atStart, snapshot)).toEqual([]);
  // Completion records the captured input, not the most recent settings.
  expect(environmentChanges(environmentFingerprint({TOKEN: 'saved during restart', REMOVED: 'value'}), snapshot)).toEqual(['TOKEN']);
});

test('runtime settings avoid build while public and explicitly declared build settings trigger one', () => {
  expect(requiresEnvironmentBuild(['SMTP_PASSWORD', 'LOG_LEVEL'])).toBe(false);
  for (const key of ['NEXT_PUBLIC_API', 'VITE_API', 'REACT_APP_API', 'PUBLIC_API', 'GATSBY_API']) expect(requiresEnvironmentBuild([key])).toBe(true);
  expect(requiresEnvironmentBuild(['STATIC_SITE_URL'], ['STATIC_SITE_URL'])).toBe(true);
});

test('actual patch and shell sourcing handle multiline secrets, deletions, repairs and database isolation', () => {
  const dir = mkdtempSync(join(tmpdir(), "preview env's-"));
  const env = join(dir, '.env');
  const secret = 'line one\n"quoted" \' apostrophe $HOME `touch nope` $(touch nope) \\ end';
  try {
    writeFileSync(env, 'DATABASE_URL="postgres://branch-db"\nAUTH_URL="https://repaired.preview"\nTOKEN="old\nmultiline"\nREMOVE_ME="gone"\n');
    const cmd = environmentPatchCommand(dir, {TOKEN: secret, REMOVE_ME: null, ADDED: 'yes'});
    const patched = spawnSync('sh', ['-c', cmd], {encoding: 'utf8'});
    expect(patched.status).toBe(0);
    expect(patched.stdout + patched.stderr).not.toContain(secret);
    const read = spawnSync('sh', ['-c', `set -a; . ${shellQuote(env)}; set +a; python3 -c 'import os,json; print(json.dumps({k:os.environ.get(k) for k in ["DATABASE_URL","AUTH_URL","TOKEN","REMOVE_ME","ADDED"]}))'`], {encoding: 'utf8', env: {...process.env, REMOVE_ME: 'inherited'}});
    expect(read.status).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual({DATABASE_URL:'postgres://branch-db', AUTH_URL:'https://repaired.preview', TOKEN:secret, REMOVE_ME:null, ADDED:'yes'});
    expect(statSync(env).mode & 0o777).toBe(0o600);
    // Retry after a failed restart, including reverting a prior change.
    expect(spawnSync('sh', ['-c', environmentPatchCommand(dir, {TOKEN:'old', ADDED:null})]).status).toBe(0);
    expect(readFileSync(env, 'utf8')).toContain('TOKEN=old');
    expect(readFileSync(env, 'utf8')).toContain('unset ADDED');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('malformed existing environment stays intact, errors never echo its secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-env-invalid-'));
  try {
    const original = 'TOKEN="unclosed-secret';
    writeFileSync(join(dir, '.env'), original);
    const result = spawnSync('sh', ['-c', environmentPatchCommand(dir, {TOKEN:'replacement'})], {encoding:'utf8'});
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(dir,'.env'), 'utf8')).toBe(original);
    expect(result.stderr).not.toContain('unclosed-secret');
  } finally { rmSync(dir,{recursive:true,force:true}); }
  expect(() => environmentPatchCommand('/tmp', {'PATH':'bad'})).toThrow();
  expect(() => environmentPatchCommand('/tmp', {'X;touch hacked':'bad'})).toThrow();
});

// Exercise the real restart orchestration with remote I/O substituted; the
// generated environment patch is covered above with a real shell.
import vm from 'node:vm';
import { restartWorktree } from '../src/services/preview-restart.ts';
const serviceSource = readFileSync(new URL('../src/services/dev-preview.ts', import.meta.url), 'utf8');
const restartSource = serviceSource.slice(serviceSource.indexOf('export async function restartPreviewApp('), serviceSource.indexOf('/** Prepare/refresh a branch'));
const compiledRestart = new Bun.Transpiler({loader:'ts'}).transformSync(restartSource.replace('export async function', 'async function'));
function restartHarness(options: {build?:boolean; fail?:boolean; pending?:boolean} = {}) {
  const old = {TOKEN:'old', NEXT_PUBLIC_API:'old'};
  const values = {...old, ...(options.build ? {NEXT_PUBLIC_API:'new'} : {TOKEN:'new'})};
  const events: string[] = [];
  const profile: any = {appliedProjectEnvironment:{values:environmentFingerprint(old),appliedAt:'before'}, environmentOverrides:[], ...(options.pending ? {pendingProjectEnvironment:{keys:['FAILED_ADDITION'],requiresBuild:true}} : {})};
  let recorded: any = null;
  const context = vm.createContext({
    crypto, Date, Set, Object, Error, Number,
    acquirePreviewRun:async()=>()=>events.push('release'), loadPublicId:async()=>{}, resetLog:()=>{},
    setPreview:async(_p:any,_u:any,patch:any)=>events.push('status:'+patch.previewStatus), persistSteps:async()=>{},
    getEnv:async()=>({setupManifest:'{}',runCommand:'node server.js',previewBranch:'epic/test',appPort:3000,stableAlias:'test'}),
    manifestSchema:{parse:()=>({port:3000,buildCmd:'npm run build',databases:[{connectionEnvVar:'DATABASE_URL'}]})},
    ensureProjectSandbox:async()=>({workspaceId:'vm'}), throwIfCancelled:()=>{},
    sh:async(_w:any,command:string)=>{events.push(command.startsWith('python3')?'apply':'shell');return {exitCode:0,output:command.includes('worktree list')?'worktree /data/epic\nbranch refs/heads/epic/test\n':''};},
    PROJECT_DIR:'/data/project', restartWorktree, environmentBranch:(b:string)=>b,
    loadAppProfile:async()=>({profile}), readProjectEnvironment:async()=>({...values}),
    environmentFingerprint, environmentChanges, requiresEnvironmentBuild, environmentPatchCommand,
    saveAppProfile:async()=>{events.push('pending');}, plog:()=>{}, shellQuote,
    runDetachedPolled:async()=>{events.push('build');return {exitCode:options.fail?1:0};}, localizeCmd:(c:string)=>c,
    resolvePreviewWorkers:async()=>{events.push('discover-workers');},
    previewWorkerCommand:(action:string)=>{events.push('workers-'+action);return 'workers-'+action;},
    envPrefix:()=>'', restartServerCommand:()=>{events.push('launch');return 'launch';},
    waitForRestart:async()=>{if(options.fail) throw new Error('crash');}, isCancelled:()=>false,sleep:async()=>{},
    enableHttpAccess:async()=>{},setStableUrl:async()=> 'https://preview.test',
    db:{update:()=>({set:()=>({where:async()=>{}})})}, projectEnvironments:{}, eq:()=>{},
    recordAppliedEnvironment:async(_p:string,b:string,s:any)=>{events.push('applied');recorded={branch:b,values:s};},
    failed:async(_p:string,_u:string,error:string)=>({error}),cancelledProjects:{delete:()=>{}},
  });
  vm.runInContext(compiledRestart,context);
  return {run:(rebuildApp=false)=>vm.runInContext('restartPreviewApp("p",{userId:"u",rebuildApp:'+rebuildApp+'})',context),events,profile,values,recorded:()=>recorded};
}

test('runtime-only restart applies before launch, skips build, and records branch-specific settings only after readiness', async()=>{
  const h=restartHarness();
  expect(await h.run()).toEqual({previewUrl:'https://preview.test'});
  expect(h.events).not.toContain('build');
  expect(h.events.indexOf('pending')).toBeLessThan(h.events.indexOf('apply'));
  expect(h.events.indexOf('apply')).toBeLessThan(h.events.indexOf('launch'));
  expect(h.events.indexOf('workers-stop')).toBeLessThan(h.events.indexOf('apply'));
  expect(h.events.indexOf('launch')).toBeLessThan(h.events.indexOf('workers-start'));
  expect(h.events.indexOf('workers-start')).toBeLessThan(h.events.indexOf('applied'));
  expect(h.recorded()).toEqual({branch:'epic/test',values:environmentFingerprint(h.values)});
});

test('public variable changes build before launch; a failed build does not launch or mark applied',async()=>{
  const good=restartHarness({build:true}); await good.run();
  expect(good.events.indexOf('build')).toBeLessThan(good.events.indexOf('launch'));
  const bad=restartHarness({build:true,fail:true});
  expect((await bad.run()).error).toContain('Build');
  expect(bad.events).not.toContain('launch'); expect(bad.recorded()).toBeNull();
  expect(bad.profile.pendingProjectEnvironment.requiresBuild).toBe(true);
});

test('failed runtime start stays pending; retry includes partially applied keys even after user reverts settings',async()=>{
  const failed=restartHarness({fail:true}); await failed.run();
  expect(failed.recorded()).toBeNull(); expect(failed.profile.pendingProjectEnvironment.keys).toContain('TOKEN');
  const retry=restartHarness({pending:true}); await retry.run();
  expect(retry.events).toContain('build'); expect(retry.profile.pendingProjectEnvironment.keys).toContain('FAILED_ADDITION');
});


test('explicit custom build request rebuilds without fetching or preparing another branch',async()=>{
  const h=restartHarness(); await h.run(true);
  expect(h.events).toContain('build');
  expect(h.recorded().branch).toBe('epic/test');
});

test('database edits require preparation and never overwrite a branch connection on quick restart',async()=>{
  const h=restartHarness();
  (h.values as Record<string,string>).DATABASE_URL='postgres://different-db';
  const result=await h.run();
  expect(result.error).toContain('Database connection settings changed');
  expect(h.events).not.toContain('apply'); expect(h.events).not.toContain('launch');
  expect(h.recorded()).toBeNull();
});
