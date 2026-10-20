import {createHash} from 'node:crypto';

type Routing = Pick<typeof import('./mags.ts'), 'enableHttpAccess' | 'setStableUrl'> & { reachable?: (url:string)=>Promise<boolean> };

/** Any HTTP answer counts; a hang or connection failure does not. */
async function answers(url:string):Promise<boolean> {
 try { const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)}); await r.body?.cancel(); return true; }
 catch { return false; }
}

/** Expose the validated app itself; never provision another application sandbox. */
export async function exposeTicketApp(ticketId:string, workspaceId:string, port:number, routing?:Routing):Promise<string> {
 if(!ticketId || !workspaceId || !Number.isInteger(port) || port<1 || port>65535)throw Error('A ticket, saved sandbox and valid app port are required');
 const provider=routing ?? await import('./mags.ts');
 const direct=await provider.enableHttpAccess(workspaceId,port);
 // Explicit port binding prevents browser/companion services changing this target.
 const alias='ticket-'+createHash('sha256').update(ticketId+':'+port).digest('hex').slice(0,24);
 let url:string;
 try{url=await provider.setStableUrl(alias,workspaceId,port);}
 catch(cause){throw new Error(`Could not register the ticket preview for sandbox ${workspaceId} on port ${port}. The existing app was not moved or rebuilt.`,{cause});}
 // Mags can keep routing a re-pointed alias to the previous, deleted sandbox. The
 // sandbox's own URL was bound to this port just above, so use it when only it answers.
 const reachable=routing?.reachable ?? answers;
 if(await reachable(url))return url;
 if(direct && await reachable(direct))return direct;
 return url;
}
