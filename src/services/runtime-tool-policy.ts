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
