import {test,expect} from 'bun:test';
import {linkTicketDocumentsTool} from '../src/ai/tools/ticket-document-tools.ts';
import {mergeTicketDocumentIds,selectTicketContextDocuments} from '../src/services/ticket-context-documents.ts';
const context={projectId:'internal',publicProjectId:'public',userId:'actor'};
const request={ticketId:'existing',documentIds:['doc']};
const access=async()=>({project:{id:'internal'},permissions:{canChat:true,canManageTickets:true}});
const invoke=(tool:any,input=request)=>tool.execute(input,{});
test('existing ticket links are updated using server-bound identity',async()=>{
 const calls:any[]=[];
 const tool=linkTicketDocumentsTool(context,{access,link:async(...args)=>{calls.push(args);return {success:true};}});
 expect(await invoke(tool)).toEqual({success:true});expect(calls).toEqual([['internal',request]]);
});
test('missing access, wrong project and read-only users cannot attach documents',async()=>{
 let calls=0;const link=async()=>{calls++;};
 for(const result of [null,{project:{id:'other'},permissions:{canChat:true,canManageTickets:true}},{project:{id:'internal'},permissions:{canChat:true,canManageTickets:false}},{project:{id:'internal'},permissions:{canChat:false,canManageTickets:true}}]) {
  expect(await invoke(linkTicketDocumentsTool(context,{access:async()=>result,link}))).toHaveProperty('error');
 }
 expect(calls).toBe(0);
});
test('primary source must be in the requested documents',async()=>{
 let calls=0;const tool=linkTicketDocumentsTool(context,{access,link:async()=>{calls++;}});
 expect(await invoke(tool,{...request,sourceDocumentId:'different'} as any)).toHaveProperty('error');expect(calls).toBe(0);
});
test('linking is additive and repeatable and keeps unrelated ticket details',()=>{
 const before={implementationPlan:['Existing milestone'],sourceDocumentIds:['original']};
 const once=mergeTicketDocumentIds(before,['new','new']);
 expect(once).toEqual({implementationPlan:['Existing milestone'],sourceDocumentIds:['original','new']});
 expect(mergeTicketDocumentIds(once,['new'])).toEqual(once);
 expect(before.sourceDocumentIds).toEqual(['original']);
 const docs=[{id:'new',projectId:'p',epicId:'',isActive:true,fileType:'research',name:'Detailed requirements'}];
 expect(selectTicketContextDocuments(docs,{projectId:'p',text:'No document IDs in prose',linkedIds:[],sourceDocumentIds:['new']})).toEqual(docs);
 expect(()=>selectTicketContextDocuments([],{projectId:'p',text:'',linkedIds:[],sourceDocumentIds:['new']})).toThrow('missing or inactive');
});
