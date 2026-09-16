import {shellQuote} from './preview-plan.ts';

/** Use the same stored configuration as normal preview startup, without logging values. */
export async function loadRuntimeEnvironment(projectId:string):Promise<Record<string,string>> {
 const [{db},{projectEnvironmentVariables},{decryptSecret},{eq,and}]=await Promise.all([
  import('../config/db.ts'),import('../db/schema/projects.ts'),
  import('../utils/crypto.ts'),import('drizzle-orm'),
 ]);
 const rows=await db.select({key:projectEnvironmentVariables.key,encryptedValue:projectEnvironmentVariables.encryptedValue})
  .from(projectEnvironmentVariables).where(and(eq(projectEnvironmentVariables.projectId,projectId),eq(projectEnvironmentVariables.hasValue,true)));
 return Object.fromEntries(rows.map(row=>[row.key,decodeRuntimeValue(row.key,row.encryptedValue,decryptSecret)]));
}

/** Background commands include exports in progress messages; redact before persisting them. */
export function runtimeRedactor(vars:Record<string,string>):(message:string)=>string {
 const values=[...new Set(Object.values(vars).filter(Boolean).flatMap(value=>[value,shellQuote(value),JSON.stringify(value).slice(1,-1)]))].sort((a,b)=>b.length-a.length);
 return message=>values.reduce((text,value)=>text.split(value).join('[redacted]'),message);
}

/** Never pass an unreadable stored secret through as application configuration. */
export function decodeRuntimeValue(key:string, stored:string, decode:(value:string)=>string):string {
 try { return decode(stored); }
 catch { throw new Error(`Cannot decrypt project variable ${key}; verify the server encryption key before running the ticket.`); }
}
