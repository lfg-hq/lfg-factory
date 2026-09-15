import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {validationHttpCommand} from '../src/services/validation-http.ts';
import {validationStepFailure} from '../src/services/validation-step-failure.ts';
import {ValidationHttpFailure} from '../src/services/validation-contract.ts';
function check(mode:string) {
 const root=mkdtempSync(join(tmpdir(),'http-check-'));mkdirSync(join(root,'bin'));
 try {
  writeFileSync(join(root,'app.log'),'[INF] Starting scheduler\n[ERR] Address already in use\n[ERR] Address already in use\n');
  writeFileSync(join(root,'bin','curl'),`#!/bin/sh\necho attempt >> "$COUNT_FILE"\nif [ "$MODE" = pass ]; then printf 200; exit 0; fi\nif [ "$MODE" = server ]; then printf 500; exit 0; fi\nprintf 000; echo 'Connection refused' >&2; exit 7\n`,{mode:0o755});
  const command=validationHttpCommand('http://127.0.0.1:5555/',root);
  expect(command).toContain('range(1,6)');expect(command).toContain("'--max-time','3'");
  const result=spawnSync('bash',['-c',command.replace('time.sleep(2)','time.sleep(0)')],{encoding:'utf8',env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,MODE:mode,COUNT_FILE:join(root,'count')}});
  return {...result,count:readFileSync(join(root,'count'),'utf8').trim().split('\n').length};
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('connection refusal stops after exactly five attempts with transport and startup diagnostics',()=>{
 const r=check('refused');expect(r.status).toBe(1);expect(r.count).toBe(5);expect(r.stdout).toContain('curl exit 7: Connection refused');expect(r.stdout).toContain('App process: exited');expect(r.stdout).toContain('Address already in use');expect(r.stdout.split('Address already in use').length).toBe(2);
});
test('HTTP 500 is distinguished from connection failure',()=>{const r=check('server');expect(r.status).toBe(1);expect(r.count).toBe(5);expect(r.stdout).toContain('HTTP 500, curl exit 0');});
test('successful HTTP response ends polling immediately',()=>{const r=check('pass');expect(r.status).toBe(0);expect(r.count).toBe(1);});
test('HTTP stage stays HTTP even when text mentions a schema repair budget',()=>{
 const e=validationStepFailure({id:'fresh-candidate-http-0',phase:'verify',command:'probe',label:'Verify route /',error:'source/schema repair attempts failed',status:'failed'},false,'candidate');
 expect(e).toBeInstanceOf(ValidationHttpFailure);expect(e.failureKind).toBe('http');
});
