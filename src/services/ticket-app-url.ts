import {createHash} from 'node:crypto';

type Routing = Pick<typeof import('./mags.ts'), 'enableHttpAccess' | 'setStableUrl'>;

/** Expose the validated app itself; never provision another application sandbox. */
export async function exposeTicketApp(ticketId:string, workspaceId:string, port:number, routing?:Routing):Promise<string> {
 if(!ticketId || !workspaceId || !Number.isInteger(port) || port<1 || port>65535)throw Error('A ticket, saved sandbox and valid app port are required');
 const provider=routing ?? await import('./mags.ts');
 await provider.enableHttpAccess(workspaceId,port);
 // Explicit port binding prevents browser/companion services changing this target.
 const alias='ticket-'+createHash('sha256').update(ticketId+':'+port).digest('hex').slice(0,24);
 try{return await provider.setStableUrl(alias,workspaceId,port);}
 catch(cause){throw new Error(`Could not register the ticket preview for sandbox ${workspaceId} on port ${port}. The existing app was not moved or rebuilt.`,{cause});}
}
