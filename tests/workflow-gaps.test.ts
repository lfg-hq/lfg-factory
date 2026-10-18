import {test,expect,setDefaultTimeout} from 'bun:test';
setDefaultTimeout(30_000);
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pbkdf2Sync,timingSafeEqual} from 'node:crypto';
import {refreshPreviewCheckout,runtimeFingerprintCommand,cachedInstallCommand,previewCheckoutDir} from '../src/services/preview-checkout.ts';
import {restartWorktree} from '../src/services/preview-restart.ts';
import {compactToolSteps,selectConversationHistory} from '../src/ai/history-budget.ts';
import {reusableMergeEvidence,validationScope,runtimePolicySchema} from '../src/services/validation-policy.ts';
import {previewDataCommand,previewDataTools} from '../src/services/preview-data-operations.ts';
function shell(command:string,cwd?:string){return spawnSync('bash',['-c',command],{cwd,encoding:'utf8'});}
function git(dir:string,...args:string[]){const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
async function repo(fn:(root:string,work:string,remote:string)=>Promise<void>|void){
 const root=mkdtempSync(join(tmpdir(),'workflow-gaps-')),work=join(root,'work'),remote=join(root,'remote');mkdirSync(work);mkdirSync(remote);
 try{git(remote,'init','--bare','-q');git(work,'init','-q','-b','main');git(work,'config','user.name','Test');git(work,'config','user.email','test@example.test');writeFileSync(join(work,'package.json'),'{}');writeFileSync(join(work,'style.css'),'a{}');writeFileSync(join(work,'.gitignore'),'node_modules\n.env\nbin\n');git(work,'add','.');git(work,'commit','-qm','initial');git(work,'remote','add','origin',remote);git(work,'push','-q','origin','main');await fn(root,work,remote);}finally{rmSync(root,{recursive:true,force:true});}
}
test('refresh uses a detached preview checkout and preserves ticket edits and warm outputs',()=>repo((root,work,remote)=>{
 git(work,'checkout','-qb','feature/ticket');writeFileSync(join(work,'ticket.txt'),'published');git(work,'add','.');git(work,'commit','-qm','ticket');git(work,'push','-q','origin','feature/ticket');
 const dir=join(root,'preview');let result=shell(refreshPreviewCheckout(work,dir,'feature/ticket',remote));expect(result.status).toBe(0);
 writeFileSync(join(work,'uncommitted.txt'),'precious');mkdirSync(join(dir,'bin'));writeFileSync(join(dir,'bin','app'),'warm');writeFileSync(join(dir,'.env'),'DB=retained');
 result=shell(refreshPreviewCheckout(work,dir,'feature/ticket',remote));expect(result.status).toBe(0);expect(readFileSync(join(work,'uncommitted.txt'),'utf8')).toBe('precious');expect(readFileSync(join(dir,'bin','app'),'utf8')).toBe('warm');expect(readFileSync(join(dir,'.env'),'utf8')).toBe('DB=retained');expect(git(dir,'rev-parse','HEAD')).toBe(git(work,'rev-parse','HEAD'));
 const bad=shell(refreshPreviewCheckout(work,dir,'missing',remote));expect(bad.status).not.toBe(0);expect(bad.stdout).not.toContain('WT_OK');
}));
test('runtime recipe fingerprint ignores CSS but notices dependencies and startup source',()=>repo((_root,work)=>{
 const fp=()=>shell(runtimeFingerprintCommand(work)).stdout.trim();const first=fp();writeFileSync(join(work,'style.css'),'a{color:red}');git(work,'commit','-qam','style');expect(fp()).toBe(first);writeFileSync(join(work,'package.json'),'{"scripts":{"start":"new"}}');git(work,'commit','-qam','manifest');expect(fp()).not.toBe(first);
}));
test('dependency receipt reuses installed modules but invalidates changed manifests',()=>repo((_root,work)=>{
 const cmd=cachedInstallCommand(work,'npm install --ignore-scripts --package-lock=false');
 // Execute the real wrapper with a fake installer; no registry/network operations.
 const bin=join(work,'fake');mkdirSync(bin);writeFileSync(join(bin,'npm'),'#!/bin/sh\nmkdir -p node_modules\necho install >> installs\n',{mode:0o755});
 const run=()=>spawnSync('bash',['-c',cmd],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH}});
 expect(run().status).toBe(0);expect(run().status).toBe(0);expect(readFileSync(join(work,'installs'),'utf8').trim()).toBe('install');writeFileSync(join(work,'package.json'),'{"name":"changed"}');git(work,'add','package.json');git(work,'commit','-qm','dependencies');expect(run().status).toBe(0);expect(readFileSync(join(work,'installs'),'utf8').trim().split('\n')).toHaveLength(2);
}));
test('restart prefers the dedicated preview over an active ticket worktree',()=>{
 const branch='feature/a';const dir=previewCheckoutDir(branch);expect(restartWorktree(`worktree /data/ticket\nbranch refs/heads/${branch}\n\nworktree ${dir}\nHEAD abc\ndetached\n`,branch)).toBe(dir);
 expect(()=>restartWorktree('worktree /data/project\nbranch refs/heads/main\n','absent')).toThrow();
});
test('tool history keeps bounded paired evidence and final conclusions',()=>{
 const steps=[{role:'assistant',content:[{type:'tool-call',toolCallId:'a',toolName:'read',input:{path:'app.ts'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'a',toolName:'read',output:{type:'text',value:'x'.repeat(250000)}}]},{role:'assistant',content:'Decision: retain account IDs. Pending operation: abc.'}];
 const result=compactToolSteps(steps);expect(JSON.stringify(result).length).toBeLessThan(48000);expect(result).toHaveLength(3);expect(JSON.stringify(result)).toContain('Pending operation: abc');expect(steps[1].content[0].output.value.length).toBe(250000);
 expect(selectConversationHistory([{userRole:'operation_status'},{userRole:'default'}])).toEqual([{userRole:'default'}]);
});
test('validation reuse fails closed on every changed identity or expired receipt',()=>{
 const expected={projectId:'p',ticketId:'t',workspaceId:'w',revision:'r',tree:'tree',baseline:'base',environmentHash:'env',now:1000};const e={...expected,status:'passed',runtimePassed:true,kind:'ticket',verifiedAt:900};expect(reusableMergeEvidence(e,expected)).toBe(true);
 for(const key of ['projectId','ticketId','workspaceId','revision','tree','baseline','environmentHash'])expect(reusableMergeEvidence({...e,[key]:'changed'},expected)).toBe(false);
 expect(reusableMergeEvidence({...e,verifiedAt:-900000},expected)).toBe(false);expect(reusableMergeEvidence({...e,runtimePassed:false},expected)).toBe(false);
 const p=runtimePolicySchema.parse({styleChecks:['npm test -- styles']});expect(validationScope(['x.css'],p).kind).toBe('focused');expect(validationScope(['auth.ts','x.css'],p).kind).toBe('full');
});
test('ASP.NET Identity password uses the v3 header and verifies its PBKDF2 subkey',()=>{
 const result=shell(previewDataCommand({kind:'password',scheme:'aspnet-identity-v3',iterations:100000}));expect(result.status).toBe(0);const {password,hash}=JSON.parse(result.stdout);const bytes=Buffer.from(hash,'base64');expect(bytes[0]).toBe(1);expect(bytes.readUInt32BE(1)).toBe(2);expect(bytes.readUInt32BE(5)).toBe(100000);const saltLength=bytes.readUInt32BE(9);expect(timingSafeEqual(bytes.subarray(13+saltLength),pbkdf2Sync(password,bytes.subarray(13,13+saltLength),100000,32,'sha512'))).toBe(true);
});
test('test passwords cannot be saved before authenticated verification',async()=>{
 let saved=0;const tools=previewDataTools({connectionKeys:['DB'],previewUrl:'https://preview.test',saveAccount:async()=>{saved++;},run:async()=>({exitCode:0,output:'{}'})});
 const result=await tools.saveTestLogin.execute!({connectionKey:'DB',username:'admin',password:'invented'},{} as any);expect(result).toHaveProperty('error');expect(saved).toBe(0);
});

test('SQL Server adapter scopes the managed container and keeps values out of executable SQL',()=>{
 const root=mkdtempSync(join(tmpdir(),'preview-mssql-'));const bin=join(root,'bin');mkdirSync(bin);const capture=join(root,'statement.sql');
 writeFileSync(join(bin,'docker'),`#!/usr/bin/env python3
import sys,json,os
if sys.argv[1]=='inspect':print(json.dumps([{'NetworkSettings':{'Ports':{'1433/tcp':[{'HostPort':'1433'}]}}}]))
else:
 open(os.environ['CAPTURE'],'w').write(sys.stdin.read())
 print('[{"statement":1,"affectedRows":1,"rows":[{"id":"kept","password":"hash"}]}]')
`,{mode:0o755});
 const run=(host:string)=>spawnSync('bash',['-c',previewDataCommand({kind:'database',connectionKey:'DB',sql:'UPDATE Users SET PasswordHash=@p1 WHERE Id=@p2',params:["x';DROP DATABASE secret;--",'id'],maxAffectedRows:1,expectedRows:1})],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,CAPTURE:capture,DB:`Server=${host},1433;Database=preview;User Id=sa;Password=secret-password;`}});
 try{const result=run('127.0.0.1');expect(result.status).toBe(0);expect(JSON.parse(result.stdout).rows[0].password).toBe('[redacted]');const sql=readFileSync(capture,'utf8');expect(sql).not.toContain('DROP DATABASE');expect(sql).not.toContain('secret-password');expect(sql.indexOf('IF @count<>1')).toBeLessThan(sql.indexOf('COMMIT'));expect(sql).toContain('ROLLBACK');expect(run('production.example').status).not.toBe(0);}finally{rmSync(root,{recursive:true,force:true});}
});

test('Razor changes invalidate generated output only in the preview checkout',()=>repo((root,work,remote)=>{
 git(work,'checkout','-qb','feature/razor');writeFileSync(join(work,'Index.cshtml'),'<p>old</p>');git(work,'add','.');git(work,'commit','-qm','view');git(work,'push','-q','origin','feature/razor');
 const dir=join(root,'preview');expect(shell(refreshPreviewCheckout(work,dir,'feature/razor',remote)).status).toBe(0);mkdirSync(join(dir,'bin'));writeFileSync(join(dir,'bin','views.dll'),'old');mkdirSync(join(work,'bin'));writeFileSync(join(work,'bin','views.dll'),'ticket output');
 writeFileSync(join(work,'Index.cshtml'),'<p>new</p>');git(work,'commit','-qam','new view');git(work,'push','-q','origin','feature/razor');expect(shell(refreshPreviewCheckout(work,dir,'feature/razor',remote)).status).toBe(0);expect(existsSync(join(dir,'bin','views.dll'))).toBe(false);expect(readFileSync(join(work,'bin','views.dll'),'utf8')).toBe('ticket output');
}));
