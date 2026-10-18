import {z} from 'zod';
import {createHash} from 'node:crypto';
export const runtimePolicySchema=z.object({
 requiredCategories:z.array(z.string().min(1).max(80)).max(40).default([]),
 styleChecks:z.array(z.string().min(1)).max(20).default([]),
}).strict();
export type RuntimePolicy=z.infer<typeof runtimePolicySchema>;
export function validationScope(paths:string[],policy:RuntimePolicy) {
 const styleOnly=paths.length>0 && paths.every(p=>/\.(css|scss|sass|less)$/i.test(p));
 return {kind:styleOnly&&policy.styleChecks.length?'focused':'full',commands:styleOnly?policy.styleChecks:[],reason:styleOnly&&policy.styleChecks.length?'Only styles changed; run the repository’s configured style checks and app availability.':'Run affected feature checks; changes may affect application behavior.'};
}
export function requirementsEvidence(requirements:string) {return createHash("sha256").update(requirements).digest("hex");}
export function environmentEvidence(vars:Record<string,string>,settings:unknown,local:string) {
 return createHash('sha256').update(JSON.stringify([Object.entries(vars).sort(([a],[b])=>a.localeCompare(b)),settings,local])).digest('hex');
}
export function reusableMergeEvidence(e:any,expected:{projectId:string;ticketId?:string;workspaceId:string;revision:string;tree:string;baseline:string;environmentHash:string;requirementsHash?:string;now?:number}) {
 return (!expected.requirementsHash || e?.requirementsHash===expected.requirementsHash) && e?.status==='passed' && e.runtimePassed===true && e.kind==='ticket' && e.projectId===expected.projectId && e.ticketId===expected.ticketId && e.workspaceId===expected.workspaceId && e.revision===expected.revision && e.tree===expected.tree && e.baseline===expected.baseline && e.environmentHash===expected.environmentHash && typeof e.verifiedAt==='number' && (expected.now??Date.now())-e.verifiedAt>=0 && (expected.now??Date.now())-e.verifiedAt<10*60_000;
}

export async function readReusableMergeEvidence(o:import('./validated-git.ts').PublicationOptions,expected:{revision:string;tree:string;baseline:string},localEnvironment:string) {
 if(!o.validation.ticketId)return null;
 const [{db},{runtimeValidations},{eq,and,desc},{loadRuntimeEnvironment},{loadBuildStageSettings}]=await Promise.all([
  import('../config/db.ts'),import('../db/schema/runtime-validation.ts'),import('drizzle-orm'),import('./ticket-runtime-environment.ts'),import('./build-stage-settings.ts')]);
 const settings=await loadBuildStageSettings(o.validation.projectId);
 if(settings.validationEnabled===false)return null;
 const vars=await loadRuntimeEnvironment(o.validation.projectId);
 const {projectTickets}=await import('../db/schema/tickets.ts');
 const [ticket]=await db.select({name:projectTickets.name,description:projectTickets.description,details:projectTickets.details}).from(projectTickets).where(and(eq(projectTickets.id,o.validation.ticketId),eq(projectTickets.projectId,o.validation.projectId)));
 if(!ticket)return null;
 const requirementsHash=requirementsEvidence(JSON.stringify(ticket));
 const rows=await db.select().from(runtimeValidations).where(and(eq(runtimeValidations.projectId,o.validation.projectId),eq(runtimeValidations.ticketId,o.validation.ticketId),eq(runtimeValidations.revision,expected.revision),eq(runtimeValidations.status,'passed'))).orderBy(desc(runtimeValidations.createdAt)).limit(5);
 for(const row of rows){let evidence;try{evidence=JSON.parse(row.evidence);}catch{continue;}
  if(reusableMergeEvidence(evidence,{...expected,requirementsHash,projectId:o.validation.projectId,ticketId:o.validation.ticketId,workspaceId:o.workspaceId,environmentHash:environmentEvidence(vars,settings,localEnvironment)}))return evidence;
 }
 return null;
}
