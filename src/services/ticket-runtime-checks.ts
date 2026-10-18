/** Required categories are explicit project/ticket policy, never customer-name matches. */
export function requiredRuntimeChecks(_requirements:string,_branch:string,categories:string[]=[]):string[]{
 return [...new Set(categories.map(c=>c.trim()).filter(Boolean))];
}
export function verifyRuntimeCoverage(required:string[],report:{kind:string;checks:{category?:string;execution?:string}[]}){
 if(!required.length)return;
 if(report.kind!=='application')throw new Error('This ticket requires a running application, not library/static verification');
 const present=new Set(report.checks.filter(c=>c.execution==='runtime').map(c=>c.category));
 const missing=required.filter(c=>!present.has(c));
 if(missing.length)throw new Error('Missing mandatory runtime checks: '+missing.join(', '));
}
