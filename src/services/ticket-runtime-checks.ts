export const COHIRE_RUNTIME_CHECKS=['database','authentication','crud','persistence','tenant-isolation','hierarchy'] as const;
export function requiredRuntimeChecks(requirements:string,branch:string):string[]{
 return /coh-25|workforce.organisation|workforce.organization/i.test(branch+' '+requirements) ? [...COHIRE_RUNTIME_CHECKS] : [];
}
export function verifyRuntimeCoverage(required:string[],report:{kind:string;checks:{category?:string;execution?:string}[]}){
 if(!required.length)return;
 if(report.kind!=='application')throw new Error('This ticket requires a running application, not library/static verification');
 const present=new Set(report.checks.filter(c=>c.execution==='runtime').map(c=>c.category));
 const missing=required.filter(c=>!present.has(c));
 if(missing.length)throw new Error('Missing mandatory runtime checks: '+missing.join(', '));
}
