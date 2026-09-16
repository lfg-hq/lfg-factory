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
 const original=exec('git rev-parse HEAD').output.trim();let report:any;let agents=0;let checks=0;const messages:string[]=[];
 const o={workspaceId:'existing-vm',projectDir:dir,featureBranch:'feature/test',repoUrl:'https://example.test/repo.git',validation:{projectId:'p',userId:'u'}};
 const deps:RuntimeDependencies={
 shell:async cmd=>cmd.includes('cat \'/data/lfg-runtime/') ? {exitCode:0,output:JSON.stringify(report)} : cmd.includes('mkdir -p \'/data/lfg-runtime/') || cmd.includes('rm -f \'/data/lfg-runtime/') ? {exitCode:0,output:''}:exec(cmd),
 agent:async prompt=>{agents++;expect(exec('git rev-parse HEAD').output.trim()).toBe(original);writeFileSync(join(dir,'app.txt'),'fixed-'+agents);report={runId:prompt.match(/"runId":"([^"]+)"/)![1],status:'passed',summary:'Feature verified',kind:'library',checks:[{label:'feature assertion',command:'test -s app.txt'}]};},
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
 expect(x.exec('git rev-parse HEAD').output.trim()).toBe(x.original);expect(x.agents()).toBe(3);
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
 const agent=x.deps.agent;const shell=x.deps.shell;
 x.deps.agent=async(p:string)=>{if(x.agents()===0)await agent(p);else throw new Error('provider unavailable');};
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
