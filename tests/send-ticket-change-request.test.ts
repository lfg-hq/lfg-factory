import {test,expect,mock,beforeEach} from 'bun:test';
// A change sent to an existing ticket must be saved on the ticket (as a pending
// addendum), not only delivered as a one-off message a failed turn can lose.
let inserted:{table:string;values:any}[]=[], created=true;
const db={insert:(table:any)=>({values:async(values:any)=>{inserted.push({table:table===schema.ticketAddenda?'addendum':'log',values});}})};
const schema:any=await import('../src/db/schema/tickets.ts');
mock.module('../src/config/db.ts',()=>({db}));
mock.module('../src/services/ticket-operations.ts',()=>({createTicketOperation:async()=>({operation:{id:'op1',status:'queued'},created})}));
mock.module('../src/events/bus.ts',()=>({bus:{emit:()=>{}}}));
const {sendTicketMessage}=await import('../src/ai/tools/ticket-tools.ts');
const run=(extra:any={})=>(sendTicketMessage as any).execute({ticketId:'t1',message:'Align the checkbox',conversationId:'c',projectId:'p',userId:'u',turnId:'turn',...extra});
beforeEach(()=>{inserted=[];created=true;});
test('a change request is recorded as a pending addendum',async()=>{
  await run();
  expect(inserted.find(i=>i.table==='addendum')?.values).toMatchObject({ticketId:'t1',description:'Align the checkbox',status:'pending',createdById:'u'});
});
test('a question is not recorded as a change',async()=>{
  await run({kind:'question'});
  expect(inserted.some(i=>i.table==='addendum')).toBe(false);
});
test('a repeated operation does not duplicate the request',async()=>{
  created=false; await run();
  expect(inserted).toHaveLength(0);
});
