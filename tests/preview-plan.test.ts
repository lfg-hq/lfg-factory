import { describe, expect, test } from "bun:test";
import { executeSteps, orderedSchema, mergeKnowledge, failureSummary, failureKey, assetCaseCheck, type PlanStep } from "../src/services/preview-plan.ts";
import { buildConfigPatchScript } from "../src/services/preview-patches.ts";
import { branchDatabaseScript } from "../src/services/preview-isolation.ts";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const step = (id: string, phase: PlanStep['phase'] = 'build', verify?: string): PlanStep => ({id, phase, command:id, label:id, verify, status:'pending'});
function shell(script: string, env = {}) { return spawnSync('bash', ['-c', script], { encoding:'utf8', env: {...process.env, ...env} }); }
function fixture(fn: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(),'preview-test-')); try { fn(dir); } finally { rmSync(dir, {recursive:true,force:true}); } }

describe('deterministic replay', () => {
  test('never skips work just because a previous step ID was done', async () => {
    const steps = [step('restore'), step('build'),step('run','run')];
    steps.forEach(s => s.status='done');
    const calls: string[]=[];
    await executeSteps(steps, {run:async(_, c)=>{calls.push(c);return {exitCode:0,output:''}}, persist:async()=>{},cancelled:()=>false});
    expect(calls).toEqual(['restore','build','run']);
  });
  test('stops at required schema failure; no false checkmarks', async () => {
    const steps=[step('migration','schema'),step('seed','schema'),step('run','run')];
    const failed=await executeSteps(steps,{run:async()=>({exitCode:1,output:'PendingModelChangesWarning: new model'}),persist:async()=>{},cancelled:()=>false});
    expect(failed?.id).toBe('migration'); expect(steps[1]?.status).toBe('pending'); expect(steps[2]?.status).toBe('pending');
  });
  test('assertions skip applied scripts and verify newly applied work',async()=>{
    const calls:string[]=[];
    let applied=false;
    const steps=[step('sql','schema','check')];
    const run=async(_:PlanStep,c:string)=>{calls.push(c); if(c==='sql') applied=true;return {exitCode:c==='check'&&!applied?1:0,output:''}};
    await executeSteps(steps,{run,persist:async()=>{},cancelled:()=>false});
    expect(calls).toEqual(['check','sql','check']);
    calls.length=0;
    await executeSteps(steps,{run,persist:async()=>{},cancelled:()=>false});
    expect(calls).toEqual(['check']);
  });
  test('failed postcondition does not turn into success',async()=>{
    const failed=await executeSteps([step('patch','build','assert')],{run:async(_,c)=>({exitCode:c==='assert'?1:0,output:'assertion failed'}),persist:async()=>{},cancelled:()=>false});
    expect(failed?.status).toBe('failed');
  });
  test('cancellation never proceeds to recovery or next command',async()=>{
    const steps=[step('build'),step('run','run')];let calls=0;
    expect(executeSteps(steps,{run:async()=>{calls++;return {exitCode:-3,output:'cancelled'}},persist:async()=>{},cancelled:()=>false})).rejects.toThrow('__CANCELLED__');
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(calls).toBe(1);expect(steps[1]?.status).toBe('pending');
  });
  test('ordered recipe preserves interleaved scripts and every seed',()=>{
    const recipe=[{kind:'sqlScript' as const,command:'bootstrap.sql',note:''},{kind:'migration' as const,command:'migrate',note:''},{kind:'seed' as const,command:'seed-a',note:''},{kind:'seed' as const,command:'seed-b',note:''}];
    expect(orderedSchema({schemaSteps:recipe,migrations:['wrong']})).toEqual(recipe);
  });
  test('reprobe retains directives, literal repairs and verified actions',()=>{
    const previous={directives:['casing'],learnings:['JSONC'],configPatches:[{file:'a',find:'b',replace:'c'}],replayActions:[{id:'case',phase:'beforeBuild' as const,command:'fix',verify:'check',note:''}]};
    const next={directives:[],learnings:['new'],configPatches:[],replayActions:[]};
    const merged=mergeKnowledge(next,previous);
    expect(merged.directives).toEqual(['casing']);expect(merged.configPatches).toEqual(previous.configPatches);expect(merged.replayActions).toEqual(previous.replayActions);expect(merged.learnings).toEqual(['JSONC','new']);
  });
  test('keeps exception header and invalidates blocker for new code or command',()=>{
    const log='noise\nSystem.InvalidOperationException: PendingModelChangesWarning\n'+Array(90).fill(' at Framework.Start()').join('\n');
    expect(failureSummary(log)).toContain('PendingModelChangesWarning');
    expect(failureKey('a',step('build'),log)).not.toBe(failureKey('b',step('build'),log));
    expect(failureKey('a',step('build'),log)).not.toBe(failureKey('a',{...step('build'),command:'fixed'},log));
  });
});

describe('actual sandbox scripts',()=>{
  test('patches apply twice, preserve JSONC and reject stale text without partial writes',()=>fixture(dir=>{
    writeFileSync(join(dir,'appsettings.json'),'// comment\n{"host":"old"}\n');
    const patch={file:'appsettings.json',find:'"old"',replace:'"new"'};
    for(let i=0;i<2;i++) {const r=shell(buildConfigPatchScript([patch],dir));expect(r.status).toBe(0);}
    expect(readFileSync(join(dir,'appsettings.json'),'utf8')).toContain('// comment');
    const r=shell(buildConfigPatchScript([{...patch,find:'"new"',replace:'"newer"'},{file:'missing',find:'x',replace:'y'}],dir));
    expect(r.status).not.toBe(0);expect(readFileSync(join(dir,'appsettings.json'),'utf8')).toContain('"new"');
  }));
  test('source additions replay and path traversal fails',()=>fixture(dir=>{
    const patch={file:'Migrations/New.cs',find:'',replace:'class New {}',create:true};
    expect(shell(buildConfigPatchScript([patch],dir)).status).toBe(0);
    expect(shell(buildConfigPatchScript([patch],dir)).status).toBe(0);
    expect(shell(buildConfigPatchScript([{...patch,file:'../escaped.cs'}],dir)).status).not.toBe(0);
  }));
  test('case collision catches the .NET alias loop before building',()=>fixture(dir=>{
    mkdirSync(join(dir,'Web/wwwroot/css'),{recursive:true});
    writeFileSync(join(dir,'Web/wwwroot/css/inboxStyle.css'),'body{}');
    // The test host may be case-insensitive; use a Linux-like directory listing stub
    // for colliding names, and exercise real script compilation on all hosts.
    const r=shell(assetCaseCheck(dir));
    expect(r.status).toBe(0);
    const script=assetCaseCheck(dir).replace('seen = {}','files = ["inboxStyle.css", "inboxstyle.css"]\n    seen = {}');
    const collision=shell(script);expect(collision.status).toBe(1);expect(collision.stdout).toContain('Static asset case collision');
  }));
  test('branch databases isolate managed credentials and preserve external connections',()=>fixture(dir=>{
    const bin=join(dir,'bin');mkdirSync(bin);
    writeFileSync(join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    const source='Server=127.0.0.1,1433;Database=cohire;User Id=sa;Password=managed;';
    writeFileSync(join(dir,'.env'),`ConnectionStrings__DefaultConnection="${source}"\nEXTERNAL="Server=remote;Database=prod;Password=external;"\n`);
    writeFileSync(join(dir,'appsettings.json'),`// jsonc\n{"ConnectionStrings":{"DefaultConnection":${JSON.stringify(source)}}}`);
    const engine={engine:'mssql',password:'managed',username:'sa',port:1433,dbName:'app'};
    const script=branchDatabaseScript(dir,'feature/one',[engine]);
    const r=shell(script,{PATH:bin+':'+process.env.PATH});expect(r.status).toBe(0);
    const once=readFileSync(join(dir,'.env'),'utf8');expect(once).toContain('Database=pv_');expect(once).toContain('Database=prod');
    expect(readFileSync(join(dir,'appsettings.json'),'utf8')).toContain('Database=pv_');
    expect(shell(script,{PATH:bin+':'+process.env.PATH}).status).toBe(0);expect(readFileSync(join(dir,'.env'),'utf8')).toBe(once);
  }));
});

test('switch A → B → A uses stable, distinct database names and rejects provisioning failure',()=>fixture(dir=>{
  const bin=join(dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const engine={engine:'mssql',password:'managed',username:'sa',port:1433,dbName:'app'};
  const source='DB="Server=127.0.0.1,1433;Database=app;Password=managed;"\n';
  const values:string[]=[];
  for (const branch of ['A','B','A']) {
    writeFileSync(join(dir,'.env'),source);
    expect(shell(branchDatabaseScript(dir,branch,[engine]),{PATH:bin+':'+process.env.PATH}).status).toBe(0);
    values.push(readFileSync(join(dir,'.env'),'utf8'));
  }
  expect(values[0]).toBe(values[2]);expect(values[0]).not.toBe(values[1]);
  writeFileSync(join(dir,'.env'),source);
  writeFileSync(join(bin,'docker'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  expect(shell(branchDatabaseScript(dir,'C',[engine]),{PATH:bin+':'+process.env.PATH}).status).not.toBe(0);
  expect(readFileSync(join(dir,'.env'),'utf8')).toBe(source);
}));

test('managed Redis gets a separate container endpoint, never FLUSHDB',()=>fixture(dir=>{
  const bin=join(dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'docker'),`#!/bin/sh
case "$1" in
 inspect) exit 1;;
 port) echo '127.0.0.1:32789';;
 exec) echo PONG;;
 *) exit 0;;
esac
`,{mode:0o755});
  writeFileSync(join(dir,'.env'),'REDIS_URL="redis://default:managed@127.0.0.1:6379/0"\nEXTERNAL="redis://default:other@remote:6379/0"\n');
  const script=branchDatabaseScript(dir,'feature/redis',[{engine:'redis',password:'managed',username:'default',port:6379,dbName:'0'}]);
  const r=shell(script,{PATH:bin+':'+process.env.PATH});
  expect(r.status).toBe(0);expect(readFileSync(join(dir,'.env'),'utf8')).toContain('127.0.0.1:32789/0');
  expect(readFileSync(join(dir,'.env'),'utf8')).toContain('other@remote');expect(script).not.toContain('FLUSH');
}));
