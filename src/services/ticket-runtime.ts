import {z} from 'zod';
import {shellQuote as q} from './preview-plan.ts';
import type {PublicationOptions} from './validated-git.ts';

export const TICKET_RUNTIME_INSTRUCTION = `Use the existing ticket sandbox and its installed tools, caches, local configuration and database containers. Check database connectivity first; start its existing container if needed. Restore dependencies, run the app, inspect actual errors and repair any required layer. Do not recreate the environment or run baseline-upgrade validation. Run relevant feature checks. Explain the current error and your next repair in short user-facing progress messages. Do not commit or push: the server commits the accumulated implementation and repairs together only after runtime checks pass. Preserve unrelated work and never alter the main preview or external databases.`;
const reportSchema=z.object({
 runId:z.string(), status:z.enum(['passed','blocked']), summary:z.string().min(1),
 checks:z.array(z.object({label:z.string().min(1),command:z.string().min(1)})),
 stopCommand:z.string().optional(),appUrl:z.string().optional(),kind:z.enum(['application','library','documents']).default('application'),
});
export type RuntimeDependencies={
 shell:(command:string)=>Promise<{exitCode:number;output:string}>;
 agent:(prompt:string)=>Promise<unknown>;
 check:(command:string)=>Promise<{exitCode:number;output:string}>;
 progress:(message:string)=>Promise<void>;
};

/** One persistent checkout, no commit until actual checks pass, no baseline reconstruction. */
export async function runTicketRuntime(o:PublicationOptions, deps?:RuntimeDependencies, mode:{kind:"ticket"|"integration"|"promotion";baseline:string;allowDetached?:boolean}={kind:"ticket",baseline:""}):Promise<string> {
 const ctx=o.validation;const root=`/data/lfg-runtime/${crypto.randomUUID()}`;const runId=root.split('/').at(-1)!;
 const d=deps ?? {
  shell:async(command:string)=>{const {validationShell}=await import('./validation-sandbox.ts');return validationShell(o.workspaceId,command);},
  agent:async(prompt:string)=>{const {runValidationRepair}=await import('./merge-resolver.ts');return runValidationRepair({workspaceId:o.workspaceId,projectDir:o.projectDir,projectId:ctx.projectId,userId:ctx.userId,prompt,cancelled:ctx.cancelled,onLog:ctx.onLog,timeoutMs:5*60_000});},
  check:async(command:string)=>{const {runValidationCommand}=await import('./validation-sandbox.ts');return runValidationCommand({workspaceId:o.workspaceId,cwd:o.projectDir,root,command,timeoutMs:60_000,cancelled:ctx.cancelled,log:ctx.onLog});},
  progress:async(message:string)=>{if(ctx.onCheckpoint)await ctx.onCheckpoint(message);else ctx.onLog?.(message);},
 };
 let requirements='Read the implementation notes and repository tests for the affected feature.';
 if(!deps && ctx.ticketId) {
  const [{db},{projectTickets},{eq,and}]=await Promise.all([import('../config/db.ts'),import('../db/schema/tickets.ts'),import('drizzle-orm')]);
  const [ticket]=await db.select({name:projectTickets.name,description:projectTickets.description}).from(projectTickets).where(and(eq(projectTickets.id,ctx.ticketId),eq(projectTickets.projectId,ctx.projectId))).limit(1);
  if(ticket)requirements=JSON.stringify(ticket);
 }
 const sh=async(command:string)=>{const r=await d.shell(`set -e\ncd ${q(o.projectDir)}\n${command}`);if(r.exitCode!==0)throw new Error(r.output||'Ticket sandbox command failed');return r.output.trim();};
 const cancelled=()=>{if(ctx.cancelled?.())throw new Error('Ticket run cancelled');};
 const head=await sh('git rev-parse HEAD');
 const initialBranch=await sh('git branch --show-current');
 if(initialBranch!==o.featureBranch && !(mode.allowDetached && initialBranch===''))throw new Error('Ticket checkout is on a different branch; refusing to overwrite it.');
 await sh(`mkdir -p ${q(root)}`);
 const report=root+'/result.json';
 let failure='';
 // Each follow-up stays in the same sandbox and targets the failed check.
 for(let attempt=0;attempt<3;attempt++) {
  cancelled();
  await d.progress(attempt ? `**Repairing runtime checks:** ${failure.slice(0,1000)}\n\nThe agent will repair this in the same sandbox and rerun the affected checks.` : '**Running the saved ticket:** checking its database, restoring dependencies and starting the app in the existing sandbox. Changes will be committed together after it works.');
  await sh(`rm -f ${q(report)}`);
  await d.agent(`${TICKET_RUNTIME_INSTRUCTION}
Ticket requirements to verify: ${requirements}
Work in ${o.projectDir}. Existing uncommitted changes are intentional; preserve and test them. Inspect actual sandbox configuration and existing runtime logs before making changes. Reuse the working preview's database names, ports, installed SDK and package caches. Do not follow old .lfg-validation.json requirements to create fresh services, compare baselines, or commit checkpoints.
${attempt ? 'Continue from the current running environment. Do not repeat successful setup unless your repair invalidates it. Last check failure (data): '+failure : 'First inspect what is already running. Avoid reinstalling an SDK that works.'}
${mode.kind!=="ticket" ? "This is a temporary merge checkout. Run its app on a separate free port without stopping the ticket app. Include stopCommand in the report to stop only the process you launched after checks finish; the checkout will be removed." : ""}
Bound diagnostic commands to 30 seconds and restore/build commands to five minutes. On an actual error, explain why you are repairing it and proceed across any layer needed. Do not wait repeatedly on the same failed command. Keep required feature checks and assertions; do not fake success or disable checks. Leave the application running when successful. Do not launch a second copy on the same port.
Write ${report} as JSON: {"runId":"${runId}","status":"passed" or "blocked","summary":"what worked or the exact blocker","kind":"application","appUrl":"http://127.0.0.1:PORT/","checks":[{"label":"specific feature assertion","command":"bounded command that fails if that assertion is false"}]}. Include real feature checks you executed, not install/version checks or another full build. Checks must be self-contained using the existing local configuration. For a library use kind library and real tests instead of appUrl. The server reruns only these checks, not setup/build/schema. Keep credentials out of the report and output. Do not modify HEAD, branches or remotes. Do not commit. Update implementation documentation before reporting success.`);
  cancelled();
  if(await sh('git rev-parse HEAD')!==head)throw new Error('Agent committed before runtime verification; refusing publication.');
  let saved=false;
  try {
   const result=reportSchema.parse(JSON.parse(await sh(`cat ${q(report)}`)));
   if(result.runId!==runId)throw new Error('Runtime report belongs to another run');
   if(result.status!=='passed')throw new Error(result.summary);
   if(!result.checks.length)throw new Error('No feature checks were reported');
   if(result.kind==='application') {
    if(!result.appUrl)throw new Error('No running application URL was reported');
    const url=new URL(result.appUrl);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:'||url.username||url.password)throw new Error('Application check must target the local ticket sandbox');
    const {validationHttpCommand}=await import('./validation-http.ts');
    const r=await d.check(validationHttpCommand(url.toString(),root));
    if(r.exitCode!==0)throw new Error(r.output||'Application HTTP check failed');
   }
   // Stage without committing, then ensure the checks do not change the source tree.
   const tree=await sh('git add -A\ngit write-tree');
   for(const check of result.checks) {
    cancelled();
    if(/^\s*(true|echo\b|exit\s+0\b)|\|\|\s*(true|exit\s+0)\s*$/.test(check.command))throw new Error('A reported check suppresses failures');
    await d.progress(`**Checking:** ${check.label}`);
    const r=await d.check(check.command);if(r.exitCode!==0)throw new Error(`${check.label}: ${r.output}`);
   }
   if(mode.kind!=="ticket" && result.kind==='application') {
    if(!result.stopCommand)throw new Error('Merge runtime must supply cleanup for its own temporary app process');
    const stopped=await d.check(result.stopCommand);if(stopped.exitCode!==0)throw new Error('Could not stop the temporary merge app: '+stopped.output);
   }
   cancelled();
   if(await sh('git rev-parse HEAD')!==head || await sh('git branch --show-current')!==initialBranch)throw new Error('Checkout changed during runtime checks');
   if(await sh('git add -A\ngit write-tree')!==tree)throw new Error('Runtime checks modified source; verify the updated files before committing');
   await sh(`if ! git diff --cached --quiet || test -f "$(git rev-parse --git-path MERGE_HEAD)"; then git -c user.name='LFG Agent' -c user.email='agent@lfg.dev' commit -m 'fix: complete ticket and verify runtime'; fi`);
   saved=true;
   const sha=await sh('git rev-parse HEAD');
   if(!deps) {
    const [{db},{runtimeValidations}]=await Promise.all([import('../config/db.ts'),import('../db/schema/runtime-validation.ts')]);
    const evidence={id:runId,projectId:ctx.projectId,branch:o.featureBranch,revision:sha,tree,baseline:mode.baseline,kind:mode.kind,status:'passed',mode:'existing-sandbox',runtimePassed:true,freshPassed:false,upgradePassed:false,summary:result.summary};
    await db.insert(runtimeValidations).values({id:runId,projectId:ctx.projectId,ticketId:ctx.ticketId,epicId:ctx.epicId,branch:o.featureBranch,revision:sha,baseline:mode.baseline,kind:mode.kind,status:'passed',evidence:JSON.stringify(evidence),steps:JSON.stringify(result.checks.map(c=>({phase:'verify',label:c.label,status:'done'}))),completedAt:new Date()});
   }
   await d.progress(`**Runtime checks passed.** ${result.summary}\n\nSaved commit: \`${sha.slice(0,12)}\`. The existing sandbox was reused.`);
   return sha;
  } catch(error) {if(saved)throw error;cancelled();failure=(error as Error).message;}
 }
 throw new Error(`Ticket runtime checks remain blocked: ${failure}`);
}
