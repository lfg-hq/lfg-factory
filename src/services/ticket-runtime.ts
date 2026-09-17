import {z} from 'zod';
import {requiredRuntimeChecks,verifyRuntimeCoverage} from './ticket-runtime-checks.ts';
import {shellQuote as q} from './preview-plan.ts';
import {runtimeRedactor, loadRuntimeEnvironment} from './ticket-runtime-environment.ts';
import type {PublicationOptions} from './validated-git.ts';

export const TICKET_RUNTIME_INSTRUCTION = `Use the existing ticket sandbox and its installed tools, caches, local configuration and database containers. Check database connectivity first; start its existing container if needed. If the required local database container or database is absent, you are authorized to create it inside this ticket development sandbox, using the installed engine or cached Docker image, the intended database names and checked-in migrations and seed data. Configure sandbox-local credentials securely and verify connectivity before running migrations. Preserve any existing database data. Missing local services are repair work, not a reason to stop and ask the user. Restore dependencies, run the app, inspect actual errors and repair any required layer. Reuse the current VM and checkout; do not reconstruct a separate baseline-upgrade validation environment. Repair or provision missing local services in this VM as needed. Run relevant feature checks. Explain the current error and your next repair in short user-facing progress messages. Do not commit or push: the server commits the accumulated implementation and repairs together only after runtime checks pass. Preserve unrelated work and never alter the main preview or external databases.`;
const reportSchema=z.object({
 runId:z.string(), status:z.enum(['passed','blocked']), summary:z.string().min(1),
 checks:z.array(z.object({label:z.string().min(1),command:z.string().min(1),category:z.string().optional(),execution:z.enum(['runtime','static']).optional()})),
 repairSummary:z.string().optional(),
 stopCommand:z.string().optional(),appUrl:z.string().optional(),kind:z.enum(['application','library','documents']).default('application'),
});
export type RuntimeDependencies={
 shell:(command:string)=>Promise<{exitCode:number;output:string}>;
 agent:(prompt:string)=>Promise<unknown>;
 check:(command:string)=>Promise<{exitCode:number;output:string}>;
 recover?:()=>Promise<string>;
 close?:()=>Promise<void>;
 now?:()=>number;
 progress:(message:string)=>Promise<void>;
};

/** One persistent checkout, no commit until actual checks pass, no baseline reconstruction. */
export async function runTicketRuntime(o:PublicationOptions, deps?:RuntimeDependencies, mode:{kind:"ticket"|"integration"|"promotion";baseline:string;allowDetached?:boolean}={kind:"ticket",baseline:""}):Promise<string> {
 const now=deps?.now ?? Date.now;
 const deadline=now()+30*60_000;
 let session:Awaited<ReturnType<typeof import('./merge-resolver.ts').createRuntimeRepairSession>>|undefined;
 const ctx=o.validation;const root=`/data/lfg-runtime/${crypto.randomUUID()}`;const runId=root.split('/').at(-1)!;
 const envVars=deps ? {} : await loadRuntimeEnvironment(ctx.projectId);
 const redact=runtimeRedactor(envVars);
 const log=(message:string)=>ctx.onLog?.(redact(message));
 const d:RuntimeDependencies=deps ?? {
  recover:async()=>{const {ticketResourceRecoveryScript}=await import('./ticket-resource-recovery.ts');const {validationShell}=await import('./validation-sandbox.ts');const r=await validationShell(o.workspaceId,ticketResourceRecoveryScript(o.projectDir),40_000);if(r.exitCode!==0)throw new Error('Resource inspection failed before repair; refusing overlapping retries');return redact(r.output);},
  shell:async(command:string)=>{const {validationShell}=await import('./validation-sandbox.ts');return validationShell(o.workspaceId,command);},
  agent:async(prompt:string)=>{if(!session){const {createRuntimeRepairSession}=await import('./merge-resolver.ts');session=await createRuntimeRepairSession({workspaceId:o.workspaceId,projectDir:o.projectDir,projectId:ctx.projectId,userId:ctx.userId,runId,deadline,envVars,onLog:log,cancelled:ctx.cancelled});}return session.ask(prompt);},
  close:async()=>{await session?.close();},
  check:async(command:string)=>{const {runValidationCommand}=await import('./validation-sandbox.ts');return runValidationCommand({workspaceId:o.workspaceId,cwd:o.projectDir,root,command,timeoutMs:Math.min(120_000,Math.max(1000,deadline-now())),cancelled:()=>!!ctx.cancelled?.() || now()>=deadline,log,vars:envVars});},
  progress:async(message:string)=>{if(ctx.onCheckpoint)await ctx.onCheckpoint(redact(message));else log(message);},
 };
 let requirements='Read the implementation notes and repository tests for the affected feature.';
 if(!deps && ctx.ticketId) {
  const [{db},{projectTickets},{eq,and}]=await Promise.all([import('../config/db.ts'),import('../db/schema/tickets.ts'),import('drizzle-orm')]);
  const [ticket]=await db.select({name:projectTickets.name,description:projectTickets.description}).from(projectTickets).where(and(eq(projectTickets.id,ctx.ticketId),eq(projectTickets.projectId,ctx.projectId))).limit(1);
  if(ticket)requirements=JSON.stringify(ticket);
 }
 const required=requiredRuntimeChecks(requirements,o.featureBranch);
 const sh=async(command:string)=>{const r=await d.shell(`set -e\ncd ${q(o.projectDir)}\n${command}`);if(r.exitCode!==0)throw new Error(redact(r.output)||'Ticket sandbox command failed');return r.output.trim();};
 const cancelled=()=>{if(ctx.cancelled?.())throw new Error('Ticket run cancelled');};
 const head=await sh('git rev-parse HEAD');
 const initialBranch=await sh('git branch --show-current');
 if(initialBranch!==o.featureBranch && !(mode.allowDetached && initialBranch===''))throw new Error('Ticket checkout is on a different branch; refusing to overwrite it.');

 const report=root+'/result.json';
 let failure='';
 let lastDiagnosis='';
 const failedChecks=new Map<string,{tree:string;repair:string;error:string}>();
 // Keep one conversation and budget across all repair/verification turns.
 try {
 for(let attempt=0;now()<deadline;attempt++) {
  cancelled();
  await d.progress(attempt ? `**Repairing runtime checks:** ${failure.slice(0,1000)}\n\nThe same agent session will repair this and rerun the affected checks.` : '**Running the saved ticket:** checking its database, restoring dependencies and starting the app in the existing sandbox. Changes will be committed together after it works.');
  const resources=await d.recover?.() ?? "Resource inventory unavailable; inspect it before starting heavy commands.";
  await sh(`rm -f ${q(report)}`);
  let agentFailure="";
  try { await d.agent(`${TICKET_RUNTIME_INSTRUCTION}
Current sandbox resource inventory (data): ${resources}
Before any restore/build, check disk bytes and inodes and inspect git worktree list --porcelain, /data/validation and /data/validation-merge. You are authorized to remove obsolete validation worktrees and their generated build outputs in this development sandbox. For registered worktrees use git worktree remove and prune stale metadata. Verify no active job uses a candidate and it has no uncommitted or unique unmerged work before deleting it. Preserve the current checkout, active worktrees, source edits, database data and required tooling. Inspect disk usage rather than assume worktrees exist. Reclaim additional disposable artifacts as needed. Aim for at least 2 GiB free before heavy work, and more when estimated restore/build output requires it. Do not consider 1 GiB automatically sufficient. Report what you removed and measured free space; if safe cleanup cannot provide enough, report the required disk capacity. Never repeat a build on a full disk. Runtime-directory creation belongs after this cleanup, not before it.
You are authorized to manage resources in this ticket sandbox: inspect and stop confirmed stale app/build processes and unused containers before heavy work. Preserve required database containers and volumes. Do not stop a process just because it uses memory; establish its role first. Use serial restore/build and disable persistent compiler/build servers when memory is tight. After an OOM, change resource usage before retrying; do not repeat the identical command.
Ticket requirements to verify: ${requirements}
Required runtime categories: ${JSON.stringify(required)}. For each required category report at least one check with category set to that exact name and execution="runtime". Database: query the actual database and verify migrations. Authentication: establish a real authenticated session and verify an unauthenticated request is denied. CRUD: create, read, update and delete a test record over authenticated HTTP. Persistence: verify the write with an independent database query or fresh session. Tenant isolation: verify another tenant cannot read or mutate that record. Hierarchy: exercise invalid parent/cycle rejection and valid relationships through the app. Static source inspection cannot substitute for these runtime assertions. Use disposable test records and clean them up. When repairing a failed server check, set repairSummary in the report to the concrete change and why it addresses that failure. Each required check must print a final JSON line {"category":"...","passed":true,"execution":"runtime"} only after all its assertions succeed; otherwise exit nonzero.
Work in ${o.projectDir}. Existing uncommitted changes are intentional; preserve and test them. Inspect actual sandbox configuration and existing runtime logs before making changes. Reuse the working preview's database names, ports, installed SDK and package caches. Before concluding that Docker data is absent, inspect DockerRootDir and /data/docker: preview persists Docker there. If the daemon is using a different root, restore its configuration to the existing /data/docker in this ticket VM and start the existing database container. Do not delete or overwrite either data directory. Inspect configuration by key and format without printing secrets; an encrypted gcm value is not a filesystem path or connection string. These current instructions supersede old validation notes or previous repair summaries that forbid replacement development databases. Do not follow old .lfg-validation.json requirements to construct separate baseline/candidate environments, compare baselines, or commit checkpoints. If a local database must be created, use its real schema and necessary development seed data; do not disable migrations, mock the database, or claim previous data was restored.
${attempt ? 'Continue from the current running environment. Do not repeat successful setup unless your repair invalidates it. Last check failure (data): '+failure : 'First inspect what is already running. Avoid reinstalling an SDK that works.'}
${mode.kind!=="ticket" ? "This is a temporary merge checkout. Run its app on a separate free port without stopping the ticket app. Include stopCommand in the report to stop only the process you launched after checks finish; the checkout will be removed." : ""}
This is one continuous session with a 30-minute total budget. Shell-tool timeouts are enforced: diagnostics 30 seconds, restore/build five minutes, tests two minutes. A command failure/timeout is a tool result to repair within this session, not a reason to stop. Reuse successful build output while source/dependencies are unchanged; record build inputs and successful steps in ${root}/progress.json after disk cleanup. Only rebuild what your repair invalidates. Keep this progress file and session context current so process recovery resumes instead of restarting setup. Repeating a failed command without a repair is blocked by the tool policy. Explain your diagnosis and concrete intervening change before retrying. On an actual error, explain why you are repairing it and proceed across any layer needed. Do not wait repeatedly on the same failed command. Keep required feature checks and assertions; do not fake success or disable checks. Leave the application running when successful. Do not launch a second copy on the same port.
After reclaiming space, create ${root} and write ${report} as JSON: {"runId":"${runId}","status":"passed" or "blocked","summary":"what worked or the exact blocker","kind":"application","appUrl":"http://127.0.0.1:PORT/","checks":[{"label":"specific feature assertion","command":"bounded command that fails if that assertion is false","category":"required category where applicable","execution":"runtime"}]}. Include real feature checks you executed, not install/version checks or another full build. Checks must be self-contained using the existing local configuration. For a library use kind library and real tests instead of appUrl. The server reruns only these checks, not setup/build/schema. Keep credentials out of the report and output. Do not modify HEAD, branches or remotes. Do not commit. Update implementation documentation before reporting success.`);
  } catch(error) { cancelled(); agentFailure=redact((error as Error).message); if(agentFailure.includes('Could not confirm Pi process cleanup'))throw new Error(agentFailure); }
  cancelled();
  if(await sh('git rev-parse HEAD')!==head)throw new Error('Agent committed before runtime verification; refusing publication.');
  let saved=false;
  try {
   let result:z.infer<typeof reportSchema>;
   try { result=reportSchema.parse(JSON.parse(await sh(`cat ${q(report)}`))); }
   catch { throw new Error([lastDiagnosis, agentFailure ? `Repair agent failed: ${agentFailure}` : 'Repair agent did not produce a valid runtime report; app startup has not been verified.'].filter(Boolean).join('\n\n')); }
   result.summary=redact(result.summary);
   if(result.runId!==runId)throw new Error('Runtime report belongs to another run');
   if(result.status!=='passed') { lastDiagnosis=redact(result.summary); throw new Error(lastDiagnosis); }
   if(agentFailure)throw new Error([lastDiagnosis, `Repair agent failed: ${agentFailure}`].filter(Boolean).join('\n\n'));
   verifyRuntimeCoverage(required,result);
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
    const previous=failedChecks.get(check.command);
    if(previous && previous.tree===tree && previous.repair===(result.repairSummary??''))throw new Error(`${previous.error}\nThis unchanged check is paused until the agent makes a source change or documents a new environment repair in repairSummary.`);
    await d.progress(`**Checking:** ${check.label}`);
    const r=await d.check(check.command);if(r.exitCode!==0){const error=`${check.label}: ${r.output}`;failedChecks.set(check.command,{tree,repair:result.repairSummary??'',error});throw new Error(error);}
    if(required.includes(check.category ?? '')) {
     let receipt:any;try{receipt=JSON.parse(r.output.trim().split('\n').at(-1)!);}catch{}
     if(receipt?.category!==check.category || receipt?.passed!==true || receipt?.execution!=='runtime')throw new Error(`${check.label}: missing successful runtime assertion receipt`);
    }
   }
   if(mode.kind!=="ticket" && result.kind==='application') {
    if(!result.stopCommand)throw new Error('Merge runtime must supply cleanup for its own temporary app process');
    const stopped=await d.check(result.stopCommand);if(stopped.exitCode!==0)throw new Error('Could not stop the temporary merge app: '+stopped.output);
   }
   cancelled();
   if(now()>=deadline)throw new Error('Session deadline reached before commit');
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
  } catch(error) {if(saved)throw error;cancelled();failure=redact((error as Error).message); if(!failure.includes('runtime report') && !failure.includes('Repair agent failed:'))lastDiagnosis=failure;}
 }
 throw new Error(`Ticket runtime checks remain blocked after the 30-minute session budget: ${failure || lastDiagnosis || 'No verified runtime result'}`);
 } finally { await d.close?.(); }
}
