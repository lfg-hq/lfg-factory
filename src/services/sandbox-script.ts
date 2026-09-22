import { shellQuote } from './preview-plan.ts';
type Result = { output?: string; stderr?: string; exitCode?: number };
/** Keep every remote exec argument small, including the script-launch command. */
export async function executeSandboxScript(script:string, timeout:number, exec:(command:string,timeout:number)=>Promise<Result>):Promise<Result> {
  const encoded=Buffer.from(script).toString('base64');
  if(encoded.length<=24000) return exec(`printf '%s' '${encoded}' | base64 -d | bash`,timeout);
  const path=`/tmp/lfg-script-${crypto.randomUUID()}`;
  try {
    const create=await exec(`umask 077; mkdir ${shellQuote(path)}`,30000);
    if(create.exitCode!==0) return create;
    for(let offset=0;offset<encoded.length;offset+=24000) {
      const result=await exec(`printf '%s' '${encoded.slice(offset,offset+24000)}' >> ${shellQuote(path+'/encoded')}`,30000);
      if(result.exitCode!==0) return result;
    }
    return await exec(`python3 -c 'import base64,sys; open(sys.argv[2],"wb").write(base64.b64decode(open(sys.argv[1],"rb").read()))' ${shellQuote(path+"/encoded")} ${shellQuote(path+"/run.sh")} && bash ${shellQuote(path+"/run.sh")}`,timeout);
  } finally { await exec(`rm -rf ${shellQuote(path)}`,30000).catch(()=>{}); }
}
