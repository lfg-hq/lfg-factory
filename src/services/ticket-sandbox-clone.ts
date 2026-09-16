import { db } from '../config/db.ts';
import { sandboxes } from '../db/schema/sandbox.ts';
import { projectEnvironments } from '../db/schema/project-environments.ts';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { submitClone, waitForClone } from './sandbox/clone-v2.ts';
import { setNoSleep } from './mags.ts';

/** Saved separately from ready ticket registrations so a pending clone is never exec-probed. */
export async function createTicketSandbox(options: {
  projectId: string; ticketId: string; userId: string;
  fresh: () => Promise<{jobId:string;workspaceId:string}>;
  log: (message:string) => Promise<unknown>;
}): Promise<{jobId:string;workspaceId:string;cloneIntentId?:string}> {
  if (process.env.SANDBOX_BACKEND === 'docker') return options.fresh();
  const [pending] = await db.select().from(sandboxes).where(and(
    eq(sandboxes.ticketId, options.ticketId), eq(sandboxes.workspaceType, 'ticket-clone'),
    inArray(sandboxes.status, ['cloning','submitting','unconfirmed']),
  )).orderBy(desc(sandboxes.updatedAt)).limit(1);
  let intent = pending;
  const recoverUnconfirmed = async () => {
    await db.update(sandboxes).set({status:'unconfirmed',updatedAt:new Date()}).where(eq(sandboxes.id,intent!.id));
    await options.log(`Clone intent ${intent!.id} is unconfirmed and retained for reconciliation. No clone will be resubmitted. The ticket will wait for clone reconciliation; no empty sandbox will be created.`);
    throw new Error("Preview clone is unconfirmed. Reconcile the saved clone request before starting this ticket; no empty sandbox was created.");
  };
  if (intent && !intent.magsJobId) return recoverUnconfirmed();
  if (!intent) {
    const [source] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, options.projectId));
    if (!source?.workspaceId || !source.setupComplete || source.previewStatus === 'error') {
      throw new Error('A working prepared preview is required to clone this ticket sandbox.');
    }
    await options.log('Cloning the prepared preview disks into an independent ticket sandbox…');
    [intent] = await db.insert(sandboxes).values({projectId:options.projectId,ticketId:options.ticketId,userId:options.userId,
      workspaceType:"ticket-clone",status:"submitting",magsBaseWorkspaceId:source.workspaceId}).returning();
    if (!intent) throw new Error("Could not register clone intent");
    let requestId: string;
    try { requestId = await submitClone(source.workspaceId); }
    catch (error) {
      // Explicit rejection has allocated nothing. Unknown POST outcomes must not be retried.
      if ([404,409].includes((error as any).statusCode)) {
        await db.update(sandboxes).set({status:'rejected'}).where(eq(sandboxes.id,intent.id));
        throw new Error('Preview clone was rejected; no empty replacement sandbox was created.');
      }
      await options.log(`Clone submission could not be confirmed: ${(error as Error).message}`);
      return recoverUnconfirmed();
    }
    await db.update(sandboxes).set({status:'cloning',magsJobId:requestId}).where(eq(sandboxes.id,intent.id));
    intent = {...intent,status:'cloning',magsJobId:requestId};
  }
  if (!intent?.magsJobId) throw new Error('Clone submission outcome is unknown; inspect Magpie before retrying. Automatic resubmission is blocked.');
  await options.log(`Waiting for clone ${intent.magsJobId}; checking every 10 seconds…`);
  const clone = await waitForClone(intent.magsJobId);
  if (clone.workspaceId === intent.magsBaseWorkspaceId) throw new Error('Clone returned the source identity; refusing to modify it');
  await setNoSleep(clone.jobId, true);
  // Preserve the cloned working configuration and caches. Git setup selects the
  // ticket branch without deleting the entire inherited application directory.
  await db.update(sandboxes).set({magsWorkspaceId:clone.workspaceId,updatedAt:new Date()}).where(eq(sandboxes.id,intent.id));
  await options.log('Clone ready. Installed SDKs retained; ticket source will be restored from Git.');
  return {...clone,cloneIntentId:intent.id};
}
