import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runTicketRuntime,type RuntimeDependencies} from '../src/services/ticket-runtime.ts';
async function fixture(body:(x:any)=>Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),'ticket-runtime-'));
 const exec=(cmd:string)=>{const r=spawnSync('bash',['-c',cmd],{cwd:dir,encoding:'utf8'});return {exitCode:r.status??1,output:r.stdout+r.stderr};};
 exec("git init -q -b feature/test && git config user.name Test && git config user.email test@example.test");
 writeFileSync(join(dir,'app.txt'),'initial');exec('git add . && git commit -qm initial');
 const original=exec('git rev-parse HEAD').output.trim();let report:any;let agents=0;let clock=0;let checks=0;const messages:string[]=[];
 const o={workspaceId:'existing-vm',projectDir:dir,featureBranch:'feature/test',repoUrl:'https://example.test/repo.git',validation:{projectId:'p',userId:'u'}};
 const deps:RuntimeDependencies={
 now:()=>clock,
 shell:async cmd=>cmd.includes('cat \'/data/lfg-runtime/') ? {exitCode:0,output:JSON.stringify(report)} : cmd.includes('mkdir -p \'/data/lfg-runtime/') || cmd.includes('rm -f \'/data/lfg-runtime/') ? {exitCode:0,output:''}:exec(cmd),
 agent:async prompt=>{agents++;clock+=9*60_000;expect(exec('git rev-parse HEAD').output.trim()).toBe(original);writeFileSync(join(dir,'app.txt'),'fixed-'+agents);report={runId:prompt.match(/"runId":"([^"]+)"/)![1],status:'passed',summary:'Feature verified',kind:'library',checks:[{label:'feature assertion',command:'test -s app.txt'}]};},
 check:async cmd=>{checks++;expect(exec('git rev-parse HEAD').output.trim()).toBe(original);return exec(cmd);},
 progress:async msg=>{messages.push(msg);},
 };
 try{await body({dir,exec,original,o,deps,agents:()=>agents,checks:()=>checks,messages});}finally{rmSync(dir,{recursive:true,force:true});}
}
test('runs saved uncommitted changes and commits once after checks pass',()=>fixture(async x=>{
 writeFileSync(join(x.dir,'pending.txt'),'preserved');
 const sha=await runTicketRuntime(x.o,x.deps);
 expect(x.exec('git rev-list --count HEAD').output.trim()).toBe('2');
 expect(x.exec('git status --porcelain').output.trim()).toBe('');
 expect(readFileSync(join(x.dir,'pending.txt'),'utf8')).toBe('preserved');
 expect(sha).not.toBe(x.original);expect(x.checks()).toBe(1);
}));
test('failed check returns to agent without intermediate commits or environment recreation',()=>fixture(async x=>{
 const check=x.deps.check;let failed=false;
 x.deps.check=async(cmd:string)=>{if(!failed){failed=true;return {exitCode:1,output:'database not ready'};}return check(cmd);};
 await runTicketRuntime(x.o,x.deps);
 expect(x.agents()).toBe(2);expect(x.exec('git rev-list --count HEAD').output.trim()).toBe('2');
 expect(x.messages.join('\n')).toContain('database not ready');
}));
test('persistent runtime failure leaves repairs uncommitted and never publishes',()=>fixture(async x=>{
 x.deps.check=async()=>({exitCode:1,output:'assertion failed'});
 await expect(runTicketRuntime(x.o,x.deps)).rejects.toThrow('assertion failed');
 expect(x.exec('git rev-parse HEAD').output.trim()).toBe(x.original);expect(x.agents()).toBe(4);
 expect(x.exec('git diff --cached --name-only').output).toContain('app.txt');
}));
test('wrong branch and cancellation do not run the agent',()=>fixture(async x=>{
 await expect(runTicketRuntime({...x.o,featureBranch:'wrong'},x.deps)).rejects.toThrow('different branch');
 x.o.validation.cancelled=()=>true;
 await expect(runTicketRuntime(x.o,x.deps)).rejects.toThrow('cancelled');expect(x.agents()).toBe(0);
}));
test('agent cannot create a premature commit',()=>fixture(async x=>{
 const agent=x.deps.agent;x.deps.agent=async(p:string)=>{await agent(p);x.exec('git add . && git commit -qm premature');};
 await expect(runTicketRuntime(x.o,x.deps)).rejects.toThrow('committed before');expect(x.checks()).toBe(0);
}));
test('cancellation during a feature check prevents commit and another repair',()=>fixture(async x=>{
 let cancelled=false;x.o.validation.cancelled=()=>cancelled;
 x.deps.check=async()=>{cancelled=true;return {exitCode:0,output:'passed'};};
 await expect(runTicketRuntime(x.o,x.deps)).rejects.toThrow('cancelled');
 expect(x.exec('git rev-parse HEAD').output.trim()).toBe(x.original);expect(x.agents()).toBe(1);
}));

test('missing repair report retains the actual database failure and never commits',()=>fixture(async x=>{
 let time=0;x.deps.now=()=>time;
 const agent=x.deps.agent;const shell=x.deps.shell;
 x.deps.agent=async(p:string)=>{time+=9*60_000;if(x.agents()===0)await agent(p);else throw new Error('provider unavailable');};
 let reports=0;
 x.deps.shell=async(cmd:string)=>{
  if(cmd.includes("cat '/data/lfg-runtime/")) {
   if(reports++===0){const r=await shell(cmd);const report=JSON.parse(r.output);report.status='blocked';report.summary='SQL Client rejected the protected connection string';return {exitCode:0,output:JSON.stringify(report)};}
   return {exitCode:1,output:'cat: result.json: No such file or directory'};
  }
  return shell(cmd);
 };
 try {await runTicketRuntime(x.o,x.deps);throw new Error('Unexpected pass');}
 catch(error) {expect((error as Error).message).toContain('SQL Client rejected');expect((error as Error).message).toContain('provider unavailable');expect((error as Error).message).not.toContain('cat:');}
 expect(x.exec('git rev-parse HEAD').output.trim()).toBe(x.original);expect(x.checks()).toBe(0);
}));

test('resource recovery runs before each repair and failure prevents agent restart',()=>fixture(async x=>{
 let recoveries=0;
 x.deps.recover=async()=>{recoveries++;expect(x.agents()).toBe(recoveries-1);if(recoveries===2)throw new Error('resource inspection unavailable');return 'available memory';};
 x.deps.check=async()=>({exitCode:1,output:'build failed'});
 await expect(runTicketRuntime(x.o,x.deps)).rejects.toThrow('resource inspection unavailable');
 expect(recoveries).toBe(2);expect(x.agents()).toBe(1);
}));

test('full data disk reaches repair agent before runtime directory allocation',()=>fixture(async x=>{
 const shell=x.deps.shell;const agent=x.deps.agent;
 x.deps.shell=async(cmd:string)=>cmd.includes('mkdir -p') ? {exitCode:1,output:'No space left on device'} : shell(cmd);
 x.deps.recover=async()=> 'Disk bytes: free=0';
 x.deps.agent=async(prompt:string)=>{expect(prompt).toContain('free=0');expect(prompt).toContain('git worktree remove');expect(prompt).toContain('2 GiB');await agent(prompt);};
 await runTicketRuntime(x.o,x.deps);expect(x.agents()).toBe(1);
}));

test('runtime agent receives authority to create a missing local development database',()=>fixture(async x=>{
 const agent=x.deps.agent;
 x.deps.agent=async(prompt:string)=>{
  expect(prompt).toContain('you are authorized to create it inside this ticket development sandbox');
  expect(prompt).toContain('checked-in migrations and seed data');
  expect(prompt).toContain('supersede old validation notes');
  expect(prompt).not.toContain('Do not recreate the environment');
  await agent(prompt);
 };
 await runTicketRuntime(x.o,x.deps);
}));

test('CoHire cannot commit a static-only report',()=>fixture(async x=>{
 x.exec('git branch -m feature/coh-25-workforce-organisation');x.o.featureBranch='feature/coh-25-workforce-organisation';
 await expect(runTicketRuntime(x.o,x.deps)).rejects.toThrow('running application');
 expect(x.checks()).toBe(0);expect(x.exec('git rev-parse HEAD').output.trim()).toBe(x.original);
}));
test('agent session closes after successful verification',()=>fixture(async x=>{
 let closes=0;x.deps.close=async()=>{closes++;};await runTicketRuntime(x.o,x.deps);expect(closes).toBe(1);
}));
test('all required runtime assertions are re-executed and receipts checked before commit',()=>fixture(async x=>{
 x.exec('git branch -m feature/coh-25-workforce-organisation');x.o.featureBranch='feature/coh-25-workforce-organisation';
 const categories=['database','authentication','crud','persistence','tenant-isolation','hierarchy'];const shell=x.deps.shell;const check=x.deps.check;
 x.deps.shell=async(cmd:string)=>{
  const r=await shell(cmd);
  if(cmd.includes("cat '/data/lfg-runtime/")){
   const report=JSON.parse(r.output);report.kind='application';report.appUrl='http://127.0.0.1:3000/';
   report.checks=categories.map(category=>({label:category,category,execution:'runtime',command:`test -s app.txt && printf '%s\\n' '${JSON.stringify({category,passed:true,execution:'runtime'})}'`}));
   return {exitCode:0,output:JSON.stringify(report)};
  }
  return r;
 };
 x.deps.check=async(cmd:string)=>cmd.includes('LFG_HTTP') ? {exitCode:0,output:'HTTP passed'} : check(cmd);
 await runTicketRuntime(x.o,x.deps);expect(x.checks()).toBe(6);expect(x.exec('git rev-list --count HEAD').output.trim()).toBe('2');
}));

test('browser failure returns to same repair loop and blocks commit until feature testing passes',()=>fixture(async x=>{
 x.o.validation.ticketId='ticket';
 const shell=x.deps.shell;
 x.deps.shell=async(cmd:string)=>{
  const r=await shell(cmd);
  if(cmd.includes("cat '/data/lfg-runtime/")){
   const report=JSON.parse(r.output);report.featureTest={kind:'browser',reason:'Exercise changed UI',applicability:[{criterion:'Save',applicable:true,reason:'UI changed'}],steps:[{label:'Open',action:'goto',path:'/teams'},{label:'Verify',action:'assertVisible',locator:{role:'heading',name:'Teams'}}]};r.output=JSON.stringify(report);
  }
  return r;
 };
 let runs=0;x.deps.featureTest=async()=>{runs++;expect(x.exec('git rev-parse HEAD').output.trim()).toBe(x.original);if(runs===1)throw Error('Browser assertion failed: saved team missing');};
 await runTicketRuntime(x.o,x.deps);
 expect(runs).toBe(2);expect(x.agents()).toBe(2);expect(x.messages.join('\n')).toContain('saved team missing');expect(x.exec('git rev-list --count HEAD').output.trim()).toBe('2');
}));

test('validation-only does not invoke browser testing',()=>fixture(async x=>{
 x.o.validation.ticketId='ticket';x.deps.featureTest=async()=>{throw Error('Browser must not run')};
 await runTicketRuntime(x.o,x.deps,{kind:'ticket',baseline:'',phase:'validation'});
 expect(x.checks()).toBe(1);
}));
test('feature-only skips validation checks and does not commit',()=>fixture(async x=>{
 x.o.validation.ticketId='ticket';const agent=x.deps.agent;const shell=x.deps.shell;let featureRuns=0;
 x.deps.agent=async(p:string)=>{await agent(p);writeFileSync(join(x.dir,'app.txt'),'initial');};
 x.deps.shell=async(cmd:string)=>{const r=await shell(cmd);if(cmd.includes("cat '/data/lfg-runtime/")){const report=JSON.parse(r.output);report.featureTest={kind:'not_applicable',reason:'Schema checks only',applicability:[{criterion:'Schema',applicable:false,reason:'No UI'}]};r.output=JSON.stringify(report);}return r;};
 x.deps.featureTest=async()=>{featureRuns++};
 const sha=await runTicketRuntime(x.o,x.deps,{kind:'ticket',baseline:'',phase:'feature-testing'});
 expect(sha).toBe(x.original);expect(x.checks()).toBe(0);expect(featureRuns).toBe(1);
}));
