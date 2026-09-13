import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/js/ticket-agent.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  function groupOperations'),source.indexOf('  function renderAll'));
const group=new Function(helper+'; return groupOperations;')();
test('poll snapshots become one job card and preserve independent commands',()=>{
 const rows=[{message:'Background job abc started; command: install-sdk; logs: /data/log'},
 {message:'Reading source'},...Array.from({length:20},()=>({message:'Background job abc is still running; waiting'})),
 {message:'Background job abc finished (exit 0, 600s); ready'}];
 const result=group(rows);
 expect(result.length).toBe(2);expect(result[0].message).toBe('install-sdk');expect(result[0].jobStatus).toBe('Completed');expect(result[1].message).toBe('Reading source');
});
test('terminal message does not leave historical job showing running',()=>{
 const result=group([{message:'Background job abc is still running'}, {type:'ai_response',message:'Build failed'}]);
 expect(result[0].jobStatus).toBe('Completion not recorded');
});
