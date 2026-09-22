import {test,expect} from 'bun:test';
import {featureTestPlanSchema} from '../src/services/feature-test-plan.ts';
import {apiTestCommand,runTicketFeatureTesting} from '../src/services/ticket-feature-testing.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const base={reason:'Test the changed endpoint',applicability:[{criterion:'API response',applicable:true,reason:'Endpoint changed'}]};
test('requires browser assertions and rejects off-origin navigation',()=>{
 expect(featureTestPlanSchema.safeParse({...base,kind:'browser',steps:[{label:'Navigate',action:'goto',path:'/feature'}]}).success).toBe(false);
 expect(featureTestPlanSchema.safeParse({...base,kind:'api',calls:[{label:'bad',method:'GET',path:'//evil.test',expectedStatus:200}]}).success).toBe(false);
 expect(featureTestPlanSchema.safeParse({...base,kind:'not_applicable'}).success).toBe(false);
});
test('schema-only work is explicitly not applicable without starting browser or curl',async()=>{
 const messages:string[]=[];
 await runTicketFeatureTesting({workspaceId:'vm',ticketId:'ticket',root:'/data/test',deadline:Date.now()+10000,plan:featureTestPlanSchema.parse({...base,kind:'not_applicable',applicability:[{criterion:'Schema migration',applicable:false,reason:'Database checks cover schema; no interface'}]}),progress:async m=>{messages.push(m)},redact:s=>s,shell:async()=>{throw Error('Unexpected execution')},check:async()=>{throw Error('Unexpected execution')}});
 expect(messages.at(-1)).toContain('not applicable');
});
test('curl checks real HTTP status and JSON, rejecting incorrect response',async()=>{
 const server=Bun.serve({port:0,fetch:()=>Response.json({saved:true,id:12},{status:201})});
 const root=await mkdtemp(tmpdir()+'/lfg-api-test-');
 try{
 for(const expected of [true,false]){
 const plan=featureTestPlanSchema.parse({...base,kind:'api',calls:[{label:'Create',method:'POST',path:'/items',body:'{}',expectedStatus:201,jsonEquals:{saved:expected}}]});
 const p=Bun.spawn(['sh','-c',apiTestCommand(plan.calls[0]!,{root,appUrl:server.url.href,plan},0)],{stdout:'pipe',stderr:'pipe'});
 const output=await new Response(p.stdout).text();expect(await p.exited).toBe(expected?0:1);expect(JSON.parse(output).passed).toBe(expected);
 }
 }finally{server.stop(true);await rm(root,{recursive:true,force:true})}
});

import {recordingResponse} from '../src/services/test-recording-response.ts';
test('video supports seeking and rejects invalid ranges',async()=>{
 const blob=new Blob(['0123456789']);
 const r=recordingResponse(blob,'bytes=3-5');expect(r.status).toBe(206);expect(await r.text()).toBe('345');expect(r.headers.get('Content-Range')).toBe('bytes 3-5/10');
 expect(await recordingResponse(blob,'bytes=-2').text()).toBe('89');
 expect(recordingResponse(blob,'bytes=99-').status).toBe(416);
});
