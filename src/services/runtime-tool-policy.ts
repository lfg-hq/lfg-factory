/** Loaded only for the ticket repair session. Pi applies mutated bash timeout arguments. */
export function installRuntimeToolPolicy(pi:any){
 let generation=0;
 const failures=new Map<string,number>();
 const commands=new Map<string,string>();
 const normalize=(command:string)=>command.trim().replace(/\s+/g,' ');
 pi.on('tool_call',async(event:any)=>{
  if(event.toolName!=='bash')return;
  const command=String(event.input.command??'');const key=normalize(command);
  if(failures.get(key)===generation)return {block:true,reason:'This command already failed without an intervening repair. Diagnose the output and change source, configuration, dependencies or resource state before repeating it. Do not merely change whitespace or extend its timeout.'};
  const limit=/\b(dotnet\s+(restore|build|publish)|npm\s+(ci|install|run\s+build)|yarn\s+(install|build)|pnpm\s+(install|build))\b/i.test(command) ? 300 : /\b(test|pytest|vitest|jest|playwright|verify)\b/i.test(command) ? 120 : 30;
  event.input.timeout=Math.min(Number(event.input.timeout)>0 ? Number(event.input.timeout) : limit,limit);
  commands.set(event.toolCallId,key);
 });
 pi.on('tool_result',async(event:any)=>{
  const key=commands.get(event.toolCallId);commands.delete(event.toolCallId);
  if(event.toolName==='bash' && key){
   if(event.isError)failures.set(key,generation);
   else if(!/^(?:timeout\s+\S+\s+)?(?:df|free|ps|du|ls|cat|head|tail|grep|rg|find|stat|ss|netstat|docker\s+(?:ps|inspect|stats|logs|info)|git\s+(?:status|diff|log))\b/.test(key))generation++;
  }else if(!event.isError && ['write','edit'].includes(event.toolName))generation++;
 });
}
export const runtimeToolPolicySource='export default '+installRuntimeToolPolicy.toString();

/** Transport tool requests over Pi's event stream; replies stay in the ticket VM. */
export function browserToolExtensionSource(replyDir:string){
 return `import {Type} from '@sinclair/typebox';
import {readFile,unlink} from 'node:fs/promises';
${runtimeToolPolicySource.replace('export default ','const installPolicy = ')}
export default function(pi){
 installPolicy(pi);
 pi.registerTool({name:'lfg_browser',label:'Live test browser',description:'Control the visible recorded browser: applicability, start, goto, snapshot, click, fill, select, press, assertVisible, assertText, assertValue, finish.',parameters:Type.Object({action:Type.String(),kind:Type.Optional(Type.String()),reason:Type.Optional(Type.String()),appUrl:Type.Optional(Type.String()),checks:Type.Optional(Type.Array(Type.String())),authStatePath:Type.Optional(Type.String()),path:Type.Optional(Type.String()),label:Type.Optional(Type.String()),checkLabel:Type.Optional(Type.String()),value:Type.Optional(Type.String()),ignoreCase:Type.Optional(Type.Boolean()),locator:Type.Optional(Type.Object({role:Type.Optional(Type.String()),name:Type.Optional(Type.String()),label:Type.Optional(Type.String()),text:Type.Optional(Type.String()),selector:Type.Optional(Type.String())}))}),async execute(_id,input,signal){
 const id=crypto.randomUUID();const file=${JSON.stringify(replyDir)}+'/'+id+'.json';
 console.log(JSON.stringify({type:'lfg_browser_request',id,input}));
 const deadline=Date.now()+150000;
 while(Date.now()<deadline){
 if(signal?.aborted)throw Error('Browser request cancelled');
 try{const result=JSON.parse(await readFile(file,'utf8'));await unlink(file);return {content:[{type:'text',text:JSON.stringify(result)}],isError:result.passed===false};}catch(e){if(e.code!=='ENOENT')throw e;}
 await new Promise(r=>setTimeout(r,250));
 }throw Error('Browser controller did not respond');
 }});
}`;
}
