import {test,expect} from 'bun:test';
import {installRuntimeToolPolicy,runtimeToolPolicySource} from '../src/services/runtime-tool-policy.ts';
function policy(){const handlers:any={};installRuntimeToolPolicy({on:(name:string,handler:any)=>handlers[name]=handler});return handlers;}
test('enforces diagnostic, build and test timeouts on actual tool input',async()=>{
 const h=policy();for(const [command,seconds] of [['df -h',30],['dotnet build App.csproj',300],['dotnet test Tests.csproj',120]] as const){
 const e={toolName:'bash',toolCallId:command,input:{command,timeout:9999}};await h.tool_call(e);expect(e.input.timeout).toBe(seconds);
 }
 expect(runtimeToolPolicySource).toStartWith('export default function');
});
test('blocks unchanged failed command until a repair occurs',async()=>{
 const h=policy();const e={toolName:'bash',toolCallId:'1',input:{command:'dotnet build App.csproj'}};
 await h.tool_call(e);await h.tool_result({...e,isError:true});expect((await h.tool_call(e)).block).toBe(true);
 await h.tool_result({toolName:'edit',isError:false});expect(await h.tool_call(e)).toBeUndefined();
});
test('reading diagnostics alone does not authorize identical retry',async()=>{
 const h=policy();const e={toolName:'bash',toolCallId:'1',input:{command:'dotnet build App.csproj'}};
 await h.tool_call(e);await h.tool_result({...e,isError:true});
 const diagnostic={toolName:'bash',toolCallId:'2',input:{command:'df -h'}};
 await h.tool_call(diagnostic);await h.tool_result({...diagnostic,isError:false});expect((await h.tool_call(e)).block).toBe(true);
});
