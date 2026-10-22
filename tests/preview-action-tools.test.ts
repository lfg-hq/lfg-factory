import {test,expect} from 'bun:test';
import {previewActionTool} from '../src/ai/tools/preview-action-tools.ts';
import {withConversationContext} from '../src/ai/tools/conversation-context.ts';
const context={projectId:'internal',publicProjectId:'public',userId:'actor',conversationId:'conversation'};
const access=async()=>({project:{id:'internal'},permissions:{canChat:true,canEditFiles:true}});
test('chat context wrapper preserves strict preview payloads and closure-bound identity',async()=>{
 let operation:any;let restarted=0;
 const tool=previewActionTool(context,{access,restart:async()=>{restarted++;return {previewUrl:'https://preview.example'};},operate:async(args)=>{operation=args;return {status:'ok',reply:'Account updated'};}});
 const wrapped=withConversationContext({handlePreview:tool},'wrapper-conversation','wrapper-user','wrapper-project').handlePreview;
 expect((await wrapped.execute({action:'manage_data',instruction:'Reset the existing administrator password in the selected development preview.'},{})).status).toBe('ok');
 expect(operation.conversationId).toBe(context.conversationId);
 expect(operation.userId).toBe(context.userId);
 expect(operation.projectId).toBe(context.projectId);
 expect(restarted).toBe(0);
 expect((await wrapped.execute({action:'restart_app'},{})).status).toBe('ok');
 expect(restarted).toBe(1);
 operation=null;
 expect((await wrapped.execute({action:'manage_data',instruction:'Reset password',conversationId:'spoofed'},{})).status).toBe('error');
 expect(operation).toBeNull();
});
test('chat can restart only the prepared app with server-bound identity',async()=>{
 let received:any;
 const t=previewActionTool(context,{access,restart:async(...args)=>{received=args;return {previewUrl:'https://preview.example'};}});
 const result=await (t.execute as any)({action:'restart_app'},{});
 expect(received).toEqual(['internal',{userId:'actor'}]);
 expect(result.status).toBe('ok');
});
test('free-form repairs and extra commands cannot reach the preview runner',async()=>{
 let calls=0;
 const t=previewActionTool(context,{access,restart:async()=>{calls++;return {previewUrl:'x'};}});
 for(const args of [{instruction:'Fix the model integration'},{action:'repair'},{action:'restart_app',instruction:'edit source'},{action:'restart_app',projectId:'another'}]) {
  expect((await (t.execute as any)(args,{})).status).toBe('error');
 }
 expect(calls).toBe(0);
});
test('denied access, mismatched project and cancellation never restart',async()=>{
 let calls=0;const restart=async()=>{calls++;return {previewUrl:'x'};};
 for(const permissions of [{canChat:false,canEditFiles:true},{canChat:true,canEditFiles:false}]) {
  const t=previewActionTool(context,{access:async()=>({project:{id:'internal'},permissions}),restart});
  expect((await (t.execute as any)({action:'restart_app'},{})).status).toBe('error');
 }
 for(const check of [async()=>null,async()=>({project:{id:'other'},permissions:{canChat:true,canEditFiles:true}})]) {
  await (previewActionTool(context,{access:check,restart}).execute as any)({action:'restart_app'},{});
 }
 const controller=new AbortController();controller.abort();
 await (previewActionTool({...context,abortSignal:controller.signal},{access,restart}).execute as any)({action:'restart_app'},{});
 expect(calls).toBe(0);
});
test('restart failure does not dispatch an automatic repair',async()=>{
 const t=previewActionTool(context,{access,restart:async()=>({error:'Prepared checkout missing'})});
 expect(await (t.execute as any)({action:'restart_app'},{})).toEqual({status:'error',reply:'Prepared checkout missing'});
});

test('requested password reset uses data operations without restarting or building',async()=>{
 let restarted=0;let operation:any;
 const t=previewActionTool(context,{access,restart:async()=>{restarted++;return {previewUrl:'unused'};},operate:async(args)=>{operation=args;return {status:'ok',reply:'Account updated'};}});
 expect(await (t.execute as any)({action:'manage_data',instruction:'Reset the existing preview admin password'},{})).toEqual({status:'ok',reply:'Account updated'});
 expect(operation.projectId).toBe('internal');expect(operation.userId).toBe('actor');expect(operation.instruction).toContain('Reset');expect(restarted).toBe(0);
});
test('data operations enforce the same permission and cancellation boundary',async()=>{
 let calls=0;const d={access:async()=>null,restart:async()=>({previewUrl:'x'}),operate:async()=>{calls++;return {status:'ok' as const,reply:'x'};}};
 await (previewActionTool(context,d).execute as any)({action:'manage_data',instruction:'Reset password'},{});
 const ac=new AbortController();ac.abort();
 await (previewActionTool({...context,abortSignal:ac.signal},{...d,access}).execute as any)({action:'manage_data',instruction:'Reset password'},{});
 expect(calls).toBe(0);
});
test('expose_port opens a running port publicly for this project only',async()=>{
 let call:any;
 const tool=previewActionTool(context,{access,restart:async()=>({previewUrl:'x'}),expose:async(projectId,userId,input)=>{call={projectId,userId,...input};return {ok:true,url:'https://p-abc-media.app.lfg.run',wsUrl:'wss://p-abc-media.app.lfg.run',name:'media',port:8081};}});
 const result:any=await (tool.execute as any)({action:'expose_port',name:'media',port:8081},{});
 expect(result.status).toBe('ok');expect(result.wsUrl).toBe('wss://p-abc-media.app.lfg.run');
 expect(call).toEqual({projectId:'internal',userId:'actor',name:'media',port:8081});
 const refused:any=await (previewActionTool(context,{access,restart:async()=>({previewUrl:'x'}),expose:async()=>({ok:false,error:'Nothing is listening on port 9999 in the preview.'})}).execute as any)({action:'expose_port',name:'x',port:9999},{});
 expect(refused).toEqual({status:'error',reply:'Nothing is listening on port 9999 in the preview.'});
});
