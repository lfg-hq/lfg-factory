import { test, expect, mock } from 'bun:test';
const pending: any[] = []; const linked: any[] = [];
mock.module('../src/services/document-epic-context.ts', () => ({
 conversationEpic: async (project: string) => project === 'existing' ? 'existing-epic' : undefined,
 rememberPendingDocument: async (...args: any[]) => {pending.push(args);},
 linkPendingDocuments: async (...args: any[]) => {linked.push(args);},
}));
const {withConversationContext} = await import('../src/ai/tools/conversation-context.ts');
test('new documents and previews inherit the active conversation epic', async () => {
 const calls: any[]=[];
 const tools=withConversationContext({previewPage:{execute:async (args:any)=>{calls.push(args);return {saved:true,id:'preview'};}},streamDocumentContent:{execute:async(args:any)=>{calls.push(args);return {saved:true,id:'doc'};}}},'chat','actor');
 await tools.previewPage.execute({projectId:'existing'},{});
 await tools.streamDocumentContent.execute({projectId:'existing',epicId:'explicit'},{});
 expect(calls[0].epicId).toBe('existing-epic');expect(calls[1].epicId).toBe('explicit');
 expect(calls[0].userId).toBe('actor');expect(pending).toHaveLength(0);
});
test('documents before an epic are remembered; opening epic attaches pending documents across turns',async()=>{
 const tools={previewPage:{execute:async()=>({saved:true,id:'preview'})},startEpic:{execute:async()=>({epicId:'new-epic'})}};
 await withConversationContext(tools,'chat','actor').previewPage.execute({projectId:'new'},{});
 await withConversationContext(tools,'chat','actor').startEpic.execute({projectId:'new'},{});
 expect(pending).toEqual([['new','chat','preview']]);expect(linked).toEqual([['new','chat','new-epic','actor']]);
});
test('epic created in this request supplies the context for subsequent documents',async()=>{
 let saved:any;
 const tools=withConversationContext({startEpic:{execute:async()=>({epicId:'created'})},streamDocumentContent:{execute:async(args:any)=>{saved=args;return {saved:true,id:'doc'};}}},'chat','actor');
 await tools.startEpic.execute({projectId:'new'},{});await tools.streamDocumentContent.execute({projectId:'new'},{});
 expect(saved.epicId).toBe('created');
});
