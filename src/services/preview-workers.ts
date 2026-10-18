import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {shellQuote} from './preview-plan.ts';

export const backgroundProcessSchema=z.object({
 name:z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
 runCmd:z.string().min(1).describe('Repository command for this required background worker, in the foreground. Never include &, nohup, setsid, provisioning, or account initialization.'),
 dir:z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).*$/).optional(),
 readyLog:z.string().optional().describe('Literal startup-ready message emitted by this worker, if known. No regex.'),
 entrypoint:z.string().optional().describe('Repository-relative executable source path from the command, used only to identify legacy unmanaged copies.'),
 environmentFiles:z.array(z.string().regex(/^\.env(?:\.[\w.-]+)?$/)).optional().describe('Environment filenames explicitly required by the repository command. Only .env is supported at startup; legacy alternate filenames are retained for diagnosis and require a ticket correction, never a compatibility alias.'),
});
export type BackgroundProcess=z.infer<typeof backgroundProcessSchema>;

/** Upgrade older Node profiles using explicit repository scripts, never invent a worker. */
export function discoverBackgroundProcesses(pkg:{scripts?:Record<string,string>},existing:BackgroundProcess[]=[]):BackgroundProcess[]{
 const result=[...existing];
 for(const [name,command] of Object.entries(pkg.scripts||{})){
  if(!/^worker(?::[a-z0-9-]+)?$/.test(name))continue;
  const slug=name.replaceAll(':','-');
  const previous=result.find(p=>p.name===slug);
  if(previous && previous.runCmd!==`npm run ${name}`)continue;
  if(/[;&|`\n]|\$\(/.test(command))throw Error(`Worker script ${name} must run in the foreground; configure its processes separately.`);
  const environmentFiles=[...command.matchAll(/(?:^|\s)--env-file(?:=|\s+)["']?(\.env(?:\.[\w.-]+)?)["']?(?=\s|$)/g)].map(m=>m[1]!);
  if(previous){previous.environmentFiles=environmentFiles;continue;}
  const entrypoint=command.match(/(?:^|\s)((?:src|scripts|workers)\/[\w./-]+\.(?:[cm]?js|tsx?|py))(?:\s|$)/)?.[1];
  result.push({name:slug,runCmd:`npm run ${name}`,entrypoint,environmentFiles});
 }
 return result;
}
const supervisor=readFileSync(new URL('./preview-workers.py',import.meta.url),'utf8');
export function previewWorkerCommand(action:'start'|'stop'|'status'|'cleanup',dir:string,workers:BackgroundProcess[]=[],databaseKeys:string[]=[],options:{stateFile?:string;webPort?:number;timeout?:number}={}):string{
 const payload={action,dir,workers:workers.map(w=>backgroundProcessSchema.parse(w)),databaseKeys,...options};
 return `python3 -c ${shellQuote(supervisor)} ${shellQuote(Buffer.from(JSON.stringify(payload)).toString('base64'))}`;
}
