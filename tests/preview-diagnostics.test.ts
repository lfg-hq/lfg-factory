import { test, expect } from 'bun:test';
import { previewDiagnosticsTool, redactDiagnosticLog } from '../src/ai/tools/preview-diagnostics.ts';
test('diagnostics reads selected URL and web/worker logs without runtime mutations', async () => {
  const calls: string[]=[];
  const tool=previewDiagnosticsTool({projectId:'p',publicProjectId:'public',userId:'u'}, {
    access:async()=>({project:{id:'p'},permissions:{canChat:true}}),
    state:async()=>({previewStatus:'running',previewUrl:'https://preview.example',branch:'epic/a',services:[]}),
    logs:async(p:string,n:number)=>{calls.push(`${p}:${n}`);return 'Web ready\nWorker job=42 failed code=PROVIDER_RATE_LIMIT\nOPENAI_API_KEY=hidden';},
  } as any);
  const result:any=await tool.execute!({lines:80},{} as any);
  expect(result.previewUrl).toBe('https://preview.example');expect(result.branch).toBe('epic/a');
  expect(result.logs).toContain('job=42');expect(result.logs).not.toContain('hidden');expect(calls).toEqual(['p:80']);
});
test('diagnostics enforces access and reports unavailable logs without claiming success', async () => {
  let reads=0;const deps:any={access:async()=>null,state:async()=>{reads++;throw Error('offline');},logs:async()=>{reads++;return '';}};
  const context={projectId:'p',publicProjectId:'public',userId:'u'};
  expect(await previewDiagnosticsTool(context,deps).execute!({},{} as any)).toHaveProperty('error');expect(reads).toBe(0);
  deps.access=async()=>({project:{id:'p'},permissions:{canChat:true}});
  const result:any=await previewDiagnosticsTool(context,deps).execute!({},{} as any);
  expect(result.status).toBe('unknown');expect(result.logStatus).toBe('unavailable');
});
test('common structured credentials are redacted',()=>{
  const result=redactDiagnosticLog('password="hello world" access_token=abc Authorization: Bearer xyz postgres://me:pass@host/db');
  for(const secret of ['hello world','abc','xyz','me:pass'])expect(result).not.toContain(secret);
});
