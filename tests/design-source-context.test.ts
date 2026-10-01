import {test, expect} from 'bun:test';
import {withConversationContext} from '../src/ai/tools/conversation-context.ts';
test('binds correct project for code and file reads without cross-chat leakage', async()=>{
 const tools={queryCodebase:{execute:async(args:any)=>args},getFileList:{execute:async(args:any)=>args}};
 const a=withConversationContext(tools,'a','actor-a','project-a');
 const b=withConversationContext(tools,'b','actor-b','project-b');
 expect((await a.queryCodebase.execute({projectId:'typo',userId:'wrong'},{})).projectId).toBe('project-a');
 expect((await b.getFileList.execute({projectId:'typo'},{})).projectId).toBe('project-b');
 expect((await a.queryCodebase.execute({projectId:'typo',userId:'wrong'},{})).userId).toBe('actor-a');
});
test('only successful exact source reads establish evidence, scoped to this chat turn',async()=>{
 const tools={readDesignSource:{execute:async(args:any)=>args.paths[0]==='missing'?{error:'missing'}:{commit:'sha',files:[{path:'layout.html',content:'<nav>Actual menu</nav>'}]}},probe:{execute:async(_:any,opts:any)=>opts.designSourceRead}};
 const a=withConversationContext(tools,'a','actor','project-a');
 const b=withConversationContext(tools,'b','actor','project-b');
 expect(await a.probe.execute({projectId:'project-a'}, {designSourceRead:true})).toBe(false);
 await a.readDesignSource.execute({projectId:'typo',paths:['missing']},{});
 expect(await a.probe.execute({projectId:'project-a'},{})).toBe(false);
 await a.readDesignSource.execute({projectId:'typo',paths:['layout.html']},{});
 expect(await a.probe.execute({projectId:'project-a'},{})).toBe(true);
 expect(await b.probe.execute({projectId:'project-b'},{})).toBe(false);
});
