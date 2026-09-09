import { test, expect } from "bun:test";
import { compileRuntimePlan } from "../src/services/runtime-plan.ts";
import { executeSteps } from "../src/services/preview-plan.ts";
import { assertEvidence, assertHeadsUnchanged, type ValidationEvidence } from "../src/services/validation-contract.ts";
import { environmentScript, cleanupEnvironmentScript } from "../src/services/validation-sandbox.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const recipe={runtime:'node',framework:'express',toolchain:[],installCmd:'install',buildCmd:'build',runCmd:'start',schemaSteps:[{kind:'migration' as const,command:'migrate',note:''}],verificationPaths:['/feature']};
const compile=()=>compileRuntimePlan(recipe,{dir:'/repo',localize:c=>c,configure:'config',start:'start',sql:f=>f,http:p=>'http '+p,tests:['test feature']});
test('runtime failure stops before HTTP and acceptance, never grants a pass from build alone',async()=>{
 const steps=compile();const calls:string[]=[];
 const failure=await executeSteps(steps,{cancelled:()=>false,persist:async()=>{},run:async(_,c)=>{calls.push(c);return {exitCode:c==='start'?1:0,output:'Startup migration model mismatch'}}});
 expect(failure?.phase).toBe('run');expect(calls).not.toContain('test feature');expect(steps.at(-1)?.status).toBe('pending');
});
test('migration failure stops before application launch',async()=>{
 const steps=compile();const failure=await executeSteps(steps,{cancelled:()=>false,persist:async()=>{},run:async(_,c)=>({exitCode:c==='migrate'?1:0,output:'migration failed'})});
 expect(failure?.phase).toBe('schema');expect(steps.find(s=>s.phase==='run')?.status).toBe('pending');
});
test('clean replay always includes installation, build, schema, feature routes and tests',()=>{
 expect(compile().map(s=>s.command)).toEqual(['config','install','build','migrate','start','http /','http /feature','test feature']);
});
const evidence:ValidationEvidence={id:'id',projectId:'p',branch:'epic/a',revision:'a',tree:'t',baseline:'b',planHash:'plan',environmentHash:'env',kind:'integration',status:'passed',freshPassed:true,upgradePassed:true};
test('fresh pass alone and stale commit, plan, baseline or environment cannot authorize publication',()=>{
 const expected={projectId:'p',branch:'epic/a',revision:'a',baseline:'b',planHash:'plan',environmentHash:'env'};
 expect(()=>assertEvidence(evidence,expected)).not.toThrow();
 for(const change of [{revision:'other'},{baseline:'other'},{planHash:'other'},{environmentHash:'other'}])expect(()=>assertEvidence(evidence,{...expected,...change})).toThrow();
 expect(()=>assertEvidence({...evidence,upgradePassed:false},expected)).toThrow();
 expect(()=>assertEvidence({...evidence,status:'failed'},expected)).toThrow();
});
test('moving either merge input blocks publication',()=>{
 for(const actual of [{source:'new',target:'b'},{source:'a',target:'new'}])expect(()=>assertHeadsUnchanged({source:'a',target:'b'},actual)).toThrow();
});
test('provisions every engine with real readiness checks and scoped dynamic host ports',()=>{
 const dir=mkdtempSync(join(tmpdir(),'validation-engines-'));const bin=join(dir,'bin');mkdirSync(bin);
 const calls=join(dir,'calls');
 writeFileSync(join(bin,'docker'),`#!/bin/sh\necho "$1" >> "$CALLS"\ncase "$1" in port) echo 127.0.0.1:49123;; *) echo OK;; esac\n`,{mode:0o755});
 try {
  const script=environmentScript(dir,'val-abcdef',[{engine:'mssql',connectionEnvVar:'ConnectionStrings__App',connectionFormat:'dotnet-sqlserver'},{engine:'postgres',connectionEnvVar:'PG',connectionFormat:'url'},{engine:'mysql',connectionEnvVar:'MY',connectionFormat:'url'},{engine:'redis',connectionEnvVar:'REDIS_URL',connectionFormat:'url'}]);
  const r=spawnSync('bash',['-c',script.replace("sock=socket.socket();sock.bind(('127.0.0.1',0));app_port=sock.getsockname()[1];sock.close()", "app_port=49124 # host sandbox forbids bind; Docker lifecycle still executes")],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:calls}});
  expect(r.stderr).toBe('');expect(r.status).toBe(0);
  const env=JSON.parse(readFileSync(join(dir,'environment.json'),'utf8'));
  expect(env.engines.length).toBe(4);expect(env.vars.ConnectionStrings__App).toContain('127.0.0.1,49123');expect(env.engines[0].password).toMatch(/^Lfg!/);
  expect(readFileSync(calls,'utf8').split('\n').filter(x=>x==='exec').length).toBe(4);
  expect(script).toContain("'127.0.0.1::'+str(port)");expect(script).toContain("'lfg.validation='+c['scope']");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('cleanup refuses foreign roots and only removes containers bearing its exact label',()=>{
 expect(()=>cleanupEnvironmentScript('val-abc','/data/project')).toThrow();
 expect(()=>cleanupEnvironmentScript('val-abc;evil','/data/validation/val-abc')).toThrow();
 expect(cleanupEnvironmentScript('val-abc','/data/validation/val-abc')).toContain('label=lfg.validation=val-abc');
});

test('upgrade fixtures execute after build and before migrations',()=>{
 const steps=compileRuntimePlan(recipe,{dir:'/repo',localize:c=>c,configure:'config',start:'start',sql:f=>f,http:p=>p,beforeSchema:['seed old rows'],tests:['assert retained rows']});
 const commands=steps.map(s=>s.command);
 expect(commands.indexOf('seed old rows')).toBeGreaterThan(commands.indexOf('build'));
 expect(commands.indexOf('seed old rows')).toBeLessThan(commands.indexOf('migrate'));
});
