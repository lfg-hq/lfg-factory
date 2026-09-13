import {test,expect,mock} from 'bun:test';
let options:any,result={exitCode:0,output:'ready'},failure:Error|undefined;
mock.module('../src/services/background-command.ts',()=>({runBackgroundCommand:async(o:any)=>{options=o;if(failure)throw failure;return result;}}));
const {validationPreparation}=await import('../src/services/validation-sandbox.ts');
test('preparation uses polled command with cancellation and finite runtime',async()=>{
 const cancelled=()=>false;
 expect(await validationPreparation({workspaceId:'vm',script:'install-tools',label:'utilities',cancelled})).toBe('ready');
 expect(options.workspaceId).toBe('vm');expect(options.command).toBe('set -e\ninstall-tools');expect(options.cancelled).toBe(cancelled);expect(options.timeoutMs).toBe(900000);
});
test('transport failure identifies the preparation step',async()=>{
 failure=new Error('context deadline exceeded');
 await expect(validationPreparation({workspaceId:'vm',script:'checkout',label:'create candidate checkout'})).rejects.toThrow('Validation preparation failed at create candidate checkout');failure=undefined;
});
test('nonzero command is not reported as ready',async()=>{
 result={exitCode:128,output:'checkout failed'};
 await expect(validationPreparation({workspaceId:'vm',script:'checkout',label:'checkout'})).rejects.toThrow('exit 128');result={exitCode:0,output:'ready'};
});
test('progress exposes job status without leaking script or output',async()=>{
 const logs:string[]=[];
 await validationPreparation({workspaceId:'vm',script:'secret command',label:'utilities',onLog:s=>logs.push(s)});
 options.log('Background job abc started; command: secret command; logs: /data/log');
 options.log('Background job abc finished (exit 0, 30s); secret output');
 expect(logs.join('\n')).not.toContain('secret');expect(logs.join('\n')).toContain('finished (exit 0, 30s)');
});
