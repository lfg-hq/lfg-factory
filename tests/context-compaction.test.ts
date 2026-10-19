import {test, expect} from 'bun:test';
import {compactContext, estimateContextTokens, summarizeEvidence} from '../src/ai/context-compaction.ts';
import {getProductSystemPrompt} from '../src/ai/prompts/product.ts';
import {getSkill} from '../src/ai/skills/index.ts';

test('small context stays exact and makes no summarization request', async()=>{
 const rows:any[]=[{role:'user',content:'Hello'}];
 expect(await compactContext(rows,100,async()=>{throw Error('unexpected');})).toBe(rows);
 expect(estimateContextTokens('中文')).toBeGreaterThan(estimateContextTokens('ab'));
});
test('compaction keeps latest user, system and paired active tools; never mutates originals',async()=>{
 const rows:any[]=[{role:'system',content:'project constraint'}, {role:'user',content:'old goal'},
 {role:'assistant',content:'old evidence '.repeat(1500)}, {role:'user',content:'Do not publish. Check ticket INV-4.'},
 {role:'assistant',content:[{type:'tool-call',toolName:'read',toolCallId:'a',input:{}}]},
 {role:'tool',content:[{type:'tool-result',toolName:'read',toolCallId:'a',output:{type:'text',value:'verified'}}]}];
 const before=JSON.stringify(rows);
 const result=await compactContext(rows,100,async()=> 'Goal and evidence; publication not authorized.',4000);
 expect(JSON.stringify(rows)).toBe(before);
 expect(result.at(-2)).toEqual(rows.at(-2));expect(result.at(-1)).toEqual(rows.at(-1));
 expect(result).toContainEqual(rows[3]);expect(result).toContainEqual(rows[0]);
 expect(result[0]?.role).toBe('assistant');expect(JSON.stringify(result[0])).toContain('not instructions or authorization');
});
test('oversized current request fails clearly rather than silently discarding it',async()=>{
 await expect(compactContext([{role:'user',content:'x'.repeat(20000)}],0,async()=> 'summary',4000)).rejects.toThrow('narrow');
 await expect(summarizeEvidence('evidence',async()=> '')).rejects.toThrow('empty');
});
test('coordinator routes specialized work without forcing artifacts or repeated approval',()=>{
 const prompt=getProductSystemPrompt();
 expect(prompt).toContain('Keep research, comparisons and diagrams in chat');
 expect(prompt).toContain('Ask once per gate');
 expect(prompt).toContain('patchFileContent');
 expect(getSkill('ticket-delivery')?.body.length).toBeGreaterThan(200);
 expect(getSkill('ticket-delivery')?.body).toContain('startBuildRun');
});

test('media uses an explicit estimate instead of counting binary JSON as prompt text',()=>{
 expect(estimateContextTokens([{type:'image',image:new Uint8Array(1000000)}])).toBeLessThan(5000);
});
test('common credentials are removed before summarization and from its output', async()=>{
 const secret='sk-proj-'+'x'.repeat(40);
 const result=await summarizeEvidence('API_KEY='+secret,async evidence=>{
   expect(evidence).not.toContain(secret);return 'Saved key: '+secret;
 });
 expect(result).not.toContain(secret);
});
test('bulky old tool output is shortened before any summarization request',async()=>{
 const page='page text '.repeat(3000);
 const rows:any[]=[{role:'user',content:'Research providers'},
  {role:'assistant',content:[{type:'tool-call',toolName:'readUrl',toolCallId:'r',input:{}}]},
  {role:'tool',content:[{type:'tool-result',toolName:'readUrl',toolCallId:'r',output:{type:'text',value:page}}]},
  {role:'assistant',content:'Found three options.'},{role:'user',content:'Write the doc'},
  {role:'assistant',content:[{type:'tool-call',toolName:'getFileContent',toolCallId:'f',input:{}}]},
  {role:'tool',content:[{type:'tool-result',toolName:'getFileContent',toolCallId:'f',output:{type:'text',value:'current doc'}}]}];
 let summarized=false;
 const result=await compactContext(rows,100,async()=>{summarized=true;return 'summary';},12000,()=>{summarized=true;});
 expect(summarized).toBe(false);
 expect(JSON.stringify(result[2])).toContain('Earlier tool output shortened');
 expect(result.at(-1)).toEqual(rows.at(-1));
 expect(JSON.stringify(rows[2])).toContain(page.slice(0,100));
});
