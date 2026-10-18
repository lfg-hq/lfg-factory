import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';

const source=readFileSync('src/ai/stream-handler.ts','utf8');
const start=source.indexOf('export function toolActionDetail');
const end=source.indexOf('\n/**',start);
const js=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end)).replace('export function','function');
const detail=new Function(js+'; return toolActionDetail;')();

test('skill activity identifies the requested skill and tolerates incomplete arguments',()=>{
 expect(detail('loadSkill',{id:'product-planning'})).toBe('Loading skill: product-planning');
 expect(detail('loadSkill',{id:'document-authoring'})).toBe('Loading skill: document-authoring');
 expect(detail('loadSkill',null)).toBe('Loading skill: unknown');
 expect(detail('loadSkill',{id:42})).toBe('Loading skill: unknown');
 expect(detail('loadSkill',{id:'a'.repeat(500)}).length).toBeLessThan(100);
});
