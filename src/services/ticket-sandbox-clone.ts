import { db } from '../config/db.ts';
import { sandboxes } from '../db/schema/sandbox.ts';
import { projectEnvironments } from '../db/schema/project-environments.ts';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { submitClone, waitForClone } from './sandbox/clone-v2.ts';
import { setNoSleep, execOnWorkspace } from './mags.ts';

/** Saved separately from ready ticket registrations so a pending clone is never exec-probed. */
// Clone refusals that allocate nothing and usually pass on a later try: the source disk
// busy with another copy, or the provider timing out while exporting it.
const BUSY_SOURCE = /another disk checkpoint or clone is in progress|DeadlineExceeded|context deadline exceeded|code = Unavailable|source export: rpc error/i;
export const BUSY_RETRY_MS = Number(process.env.TICKET_CLONE_BUSY_RETRY_MS ?? 30_000);
export async function createTicketSandbox(options: {
  projectId: string; ticketId: string; userId: string;
  allowPreparedPreviewWithAppError?: boolean;
  fresh: () => Promise<{jobId:string;workspaceId:string}>;
  log: (message:string) => Promise<unknown>;
  busyRetries?: number;
}): Promise<{jobId:string;workspaceId:string;cloneIntentId?:string}> {
  // Mags copies a disk one operation at a time. A clone refused for that reason allocated
  // nothing, so it is marked rejected (never resumed) and submitted again after a pause.
  const retryWhenBusy = async (intentId: string, detail: string) => {
    if (!BUSY_SOURCE.test(detail) || (options.busyRetries ?? 0) >= 6) return null;
    await db.update(sandboxes).set({status:'rejected',updatedAt:new Date()}).where(eq(sandboxes.id,intentId));
    await options.log(/in progress/i.test(detail) ? 'The preview disk is busy with another copy. Trying again in 30 seconds…'
      : `Copying the preview disk timed out on the sandbox provider. Trying again in 30 seconds (attempt ${(options.busyRetries ?? 0) + 2} of 7)…`);
    await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_MS));
    return createTicketSandbox({...options, busyRetries:(options.busyRetries ?? 0) + 1});
  };
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
    if (!source?.workspaceId || !source.setupComplete) {
      await options.log('Preparing the project Preview environment automatically…');
      const {ensureProjectSandbox} = await import('./project-sandbox.ts');
      // Uses the normal project lifecycle lock and persists the environment assignment.
      // An unfinished app cannot pass a running-preview check before its first build.
      await ensureProjectSandbox(options.projectId);
      await options.log('Project environment assigned. Creating an independent build workspace; the builder will prepare the app and its dependencies.');
      return options.fresh();
    }
    if (source.previewStatus === 'error' && !options.allowPreparedPreviewWithAppError) {
      throw new Error('The existing prepared preview has an error. Repair it before cloning the build environment.');
    }
    if (source.previewStatus === 'error') {
      // A failed preview of another ticket does not invalidate the prepared base.
      // Recovery can clone it only when the actual source checkout still responds.
      const probe = await execOnWorkspace(source.workspaceId, 'git -C /data/project rev-parse --show-toplevel', {timeout:20_000}).catch(()=>null);
      if (probe?.exitCode !== 0 || probe.output.trim() !== '/data/project') {
        throw new Error('The prepared project checkout is unavailable. Restore the project Preview, then retry Coding.');
      }
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
        // submitClone already redacts credentials from provider diagnostics. Preserve
        // the reason instead of collapsing missing-source and busy-source failures.
        const detail = error instanceof Error ? error.message : `HTTP ${(error as any).statusCode}`;
        const retried = await retryWhenBusy(intent.id, detail);
        if (retried) return retried;
        console.warn('[ticket-sandbox-clone] rejected', {ticketId:options.ticketId,sourceWorkspaceId:source.workspaceId,detail});
        throw new Error(`Preview clone was rejected: ${detail} No replacement sandbox was created.`);
      }
      await options.log(`Clone submission could not be confirmed: ${(error as Error).message}`);
      return recoverUnconfirmed();
    }
    await db.update(sandboxes).set({status:'cloning',magsJobId:requestId}).where(eq(sandboxes.id,intent.id));
    intent = {...intent,status:'cloning',magsJobId:requestId};
  }
  if (!intent?.magsJobId) throw new Error('Clone submission outcome is unknown; inspect Magpie before retrying. Automatic resubmission is blocked.');
  await options.log(`Waiting for clone ${intent.magsJobId}; checking every 10 seconds…`);
  let clone: {jobId:string;workspaceId:string};
  try { clone = await waitForClone(intent.magsJobId); }
  catch (error) {
    const retried = await retryWhenBusy(intent.id, (error as Error).message ?? '');
    if (retried) return retried;
    throw error;
  }
  if (clone.workspaceId === intent.magsBaseWorkspaceId) throw new Error('Clone returned the source identity; refusing to modify it');
  await setNoSleep(clone.jobId, true);
  // Preserve the cloned working configuration and caches. Git setup selects the
  // ticket branch without deleting the entire inherited application directory.
  await db.update(sandboxes).set({magsWorkspaceId:clone.workspaceId,updatedAt:new Date()}).where(eq(sandboxes.id,intent.id));
  await options.log('Clone ready. Installed SDKs retained; ticket source will be restored from Git.');
  return {...clone,cloneIntentId:intent.id};
}
