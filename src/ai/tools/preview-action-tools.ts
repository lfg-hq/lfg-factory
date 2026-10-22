import {tool, zodSchema} from 'ai';
import {z} from 'zod';

type Context = {projectId:string;publicProjectId:string;userId:string;conversationId:string;abortSignal?:AbortSignal;onActivity?:()=>void;onProgress?:(detail:string)=>void};
type Dependencies = {
 access: (projectId:string,userId:string)=>Promise<{project:{id:string};permissions:{canChat:boolean;canEditFiles:boolean}}|null>;
  restart: typeof import('../../services/dev-preview.ts').restartPreviewApp;
  operate?: typeof import('../../services/dev-preview.ts').runPreviewDataOperation;
  expose?: typeof import('../../services/dev-preview.ts').exposePreviewPort;
};
const input = z.discriminatedUnion('action',[
 z.object({action:z.literal('restart_app')}).strict(),
 z.object({action:z.literal('manage_data'),instruction:z.string().min(1).max(6000)}).strict(),
 z.object({action:z.literal('expose_port'),name:z.string().min(1).max(40).describe('Short name for the subdomain, e.g. "media"'),port:z.number().int().min(1).max(65535).describe('Port the running process listens on in the preview')}).strict(),
]);

/** Data requests use constrained operation tools; source repairs belong to ticket execution. */
export function previewActionTool(context:Context, dependencies?:Dependencies) {
 return tool({
  description: 'Perform requested preview operations without building tickets: expose_port opens an extra running port of the preview (a WebSocket/audio worker, webhook receiver or API) on its own public https/wss URL, kept across restarts — use it instead of a ticket when a service needs a public address; restart_app applies saved settings and restarts the prepared app; manage_data handles development accounts, passwords, data edits and processing-history cleanup in the selected running preview. It can inspect source/schema, pause and resume background workers, and change related records atomically in one database transaction with verification and rollback. It preserves unrelated accounts/settings. It has no source editing or build tools. PostgreSQL with installed pg and managed SQL Server are supported; password hashing supports Better Auth, bcrypt and ASP.NET Core Identity v3 after source inspection. Environment changes use the environment tools. Only application code, dependency, script or schema changes go through tickets. Never rebuild a ticket for an operational data request.',
  inputSchema:zodSchema(input),
  execute:async(args:z.infer<typeof input>)=>{
   // Validate again for direct callers and old conversations replaying legacy inputs.
   if(!input.safeParse(args).success) return {status:'error',reply:'Choose restart_app for a restart, expose_port to open a running port publicly, or manage_data for an account or data request. Only application code changes belong in tickets. No preview operation was started.'};
   const d=dependencies ?? {access:(await import('../../auth/project-access.ts')).getProjectAccess,restart:(await import('../../services/dev-preview.ts')).restartPreviewApp,operate:(await import('../../services/dev-preview.ts')).runPreviewDataOperation,expose:(await import('../../services/dev-preview.ts')).exposePreviewPort};
   const access=await d.access(context.publicProjectId,context.userId);
   if(!access || access.project.id!==context.projectId || !access.permissions.canChat || !access.permissions.canEditFiles) return {status:'error',reply:'Project chat and edit permissions are required to operate this preview.'};
   if(context.abortSignal?.aborted)return {status:'error',reply:'Preview operation cancelled.'};
   context.onActivity?.();
   if(args.action==='expose_port'){
    if(!d.expose)return {status:'error',reply:'Opening preview ports is unavailable here.'};
    context.onProgress?.(`Opening port ${args.port} publicly`);
    const opened=await d.expose(context.projectId,context.userId,{name:args.name,port:args.port});
    return opened.ok ? {status:'ok',url:opened.url,wsUrl:opened.wsUrl,reply:`Port ${opened.port} is public at ${opened.url} (WebSocket: ${opened.wsUrl}). Kept across restarts. Set any setting that needs this address, restart_app, then verify the connection.`} : {status:'error',reply:opened.error};
   }
   if(args.action==='manage_data'){
    if(!d.operate)return {status:'error',reply:'Preview data operations are unavailable; no ticket was started.'};
    context.onProgress?.('Working on your request');
    return d.operate({...context,instruction:args.instruction});
   }
   context.onProgress?.('Restarting the prepared preview app');
   const result=await d.restart(context.projectId,{userId:context.userId});
   return 'error' in result ? {status:'error',reply:result.error} : {status:'ok',previewUrl:result.previewUrl,reply:'App restarted with saved settings. This did not implement or verify a feature.'};
  },
 });
}
