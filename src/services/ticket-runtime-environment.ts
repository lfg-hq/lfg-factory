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
 const values=[...new Set(Object.entries(vars).filter(([key,value])=>Boolean(value) && /secret|password|passwd|token|credential|authorization|(?:database|db|redis|mongo).*url|dsn|connectionstrings?|(?:api|access|private|encryption|signing)[_-]?key/i.test(key)).map(([,value])=>value).filter(value=>value.length>=4 && !/^(?:\d+|true|false)$/i.test(value)).flatMap(value=>[value,shellQuote(value),JSON.stringify(value).slice(1,-1)]))].sort((a,b)=>b.length-a.length);
 return message=>{
  let text=values.reduce((text,value)=>text.split(value).join('[redacted]'),message);
  for(const [key,value] of Object.entries(vars)){if(!value || (value.length>=4 && !/^(?:\d+|true|false)$/i.test(value)) || !/secret|password|passwd|token|credential|key/i.test(key))continue;const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');text=text.replace(new RegExp('('+escaped+'[\\s]*[=:][\\s]*)([\"\']?)'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\2(?=$|[\\s;,])','g'),'$1[redacted]');}
  return text;
 };
}

/** Never pass an unreadable stored secret through as application configuration. */
export function decodeRuntimeValue(key:string, stored:string, decode:(value:string)=>string):string {
 try { return decode(stored); }
 catch { throw new Error(`Cannot decrypt project variable ${key}; verify the server encryption key before running the ticket.`); }
}
