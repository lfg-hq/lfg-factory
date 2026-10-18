import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {piLogCompactorSource} from '../src/services/pi-log-compact.ts';

test('large streaming snapshots become small activity records; completed events and forwarding survive',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-compact-'));
 try {
  const script=join(dir,'compact.cjs'), file=join(dir,'log');writeFileSync(script,piLogCompactorSource);
  const complete={type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Repair complete'}],usage:{input:42},stopReason:'stop'}};
  const tool={type:'tool_execution_end',toolName:'write',toolCallId:'id-1',isError:false};
  const lines=[...Array.from({length:100},()=>({type:'message_update',assistantMessageEvent:{type:'thinking_delta'},message:{content:'x'.repeat(20_000)}})),tool,complete];
  const input=lines.map(e=>JSON.stringify(e)).join('\n')+'\n';
  const r=spawnSync('node',[script,file,'--forward'],{input,encoding:'utf8',maxBuffer:4_000_000});
  expect(r.status).toBe(0);expect(r.stdout).toBe(input);
  const log=readFileSync(file,'utf8');expect(log.length).toBeLessThan(2000);
  expect(log).toContain(JSON.stringify(complete));expect(log).toContain(JSON.stringify(tool));
  expect(log).toContain('Thinking through the next step');expect(log).not.toContain('x'.repeat(100));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
