import { readFileSync } from 'node:fs';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execOnWorkspace } from './mags.ts';
import { shellQuote } from './ticket-code.ts';
const worker = readFileSync(new URL('./ticket-workspace-checkpoint.py', import.meta.url), 'utf8');
const directory = resolve(process.env.TICKET_CHECKPOINT_DIR || 'data/ticket-checkpoints');
const limit = 64 * 1024 * 1024;
const chunkSize = 16 * 1024;
function location(ticketId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(ticketId)) throw new Error('Invalid ticket identifier');
  return join(directory, ticketId + '.json');
}
async function exec(workspace: string, command: string) {
  const r = await execOnWorkspace(workspace, command, { timeout: 120_000 });
  if (r.exitCode !== 0) throw new Error('Could not transfer the workspace checkpoint. The sandbox must stay awake.');
  return r.output.trim();
}
async function run(workspace: string, args: object) {
  const command = `python3 -c ${shellQuote(`import base64; exec(base64.b64decode('${Buffer.from(worker).toString('base64')}'))`)} ${shellQuote(JSON.stringify(args))}`;
  const r = await execOnWorkspace(workspace, command, { timeout: 120_000 });
  let data: any;
  try { data = JSON.parse(r.output.trim()); } catch { throw new Error('Workspace checkpoint did not complete. The sandbox must stay awake.'); }
  if (r.exitCode !== 0 || data.error) throw new Error(data.error || 'Workspace checkpoint failed');
  return data;
}
// Checkpoints go to object storage when it is configured: the app directory in production
// is not writable by the app user, so every local save failed and each build sandbox was
// kept awake indefinitely. The local directory remains for development.
const storageKey = (ticketId: string) => { location(ticketId); return `ticket-checkpoints/${ticketId}.json`; };
async function writeCheckpoint(ticketId: string, json: string) {
  const s3 = await import('./s3.ts');
  if (s3.isS3Enabled) { await s3.uploadBinary(storageKey(ticketId), Buffer.from(json), 'application/json'); return; }
  await mkdir(directory, {recursive:true, mode:0o700});
  const path = location(ticketId), temp = path + '.' + crypto.randomUUID();
  try {
    const file = await open(temp,'wx',0o600);
    try { await file.writeFile(json); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, {force:true}); }
}
async function readCheckpointRaw(ticketId: string): Promise<string | null> {
  const s3 = await import('./s3.ts');
  if (s3.isS3Enabled) {
    try {
      const { body } = await s3.downloadBinary(storageKey(ticketId));
      if (body.length) return body.toString('utf8');
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw e;
    }
  }
  // Older checkpoints (and development) live on local disk.
  try { return await readFile(location(ticketId), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function readTicketCheckpoint(ticketId: string): Promise<{branch:string;head:string;sha256:string;archive:string} | null> {
  const raw = await readCheckpointRaw(ticketId);
  if (raw === null) return null;
  const checkpoint = JSON.parse(raw);
  const data = Buffer.from(checkpoint.archive, 'base64');
  if (data.length > limit || createHash('sha256').update(data).digest('hex') !== checkpoint.sha256) throw new Error('The saved workspace checkpoint failed verification. Recovery stopped.');
  return checkpoint;
}
export async function checkpointTicketWorkspace(ticketId:string, workspace:string, root:string, expectedBranch?:string) {
  const remote = '/tmp/lfg-checkpoint-' + crypto.randomUUID();
  try {
    const meta = await run(workspace, { action:'pack', root, archive:remote });
    if (expectedBranch && meta.branch !== expectedBranch) throw new Error('Checkout branch changed. The prior checkpoint is retained and the sandbox stays awake.');
    if (!Number.isInteger(meta.size) || meta.size < 1 || meta.size > limit) throw new Error('Invalid workspace checkpoint size');
    const chunks: Buffer[] = [];
    for (let offset=0; offset<meta.size; offset+=chunkSize) {
      const script = `import base64; f=open(${JSON.stringify(remote)},'rb'); f.seek(${offset}); print(base64.b64encode(f.read(${chunkSize})).decode())`;
      chunks.push(Buffer.from(await exec(workspace, `python3 -c ${shellQuote(script)}`), 'base64'));
    }
    const data = Buffer.concat(chunks);
    if (data.length !== meta.size || createHash('sha256').update(data).digest('hex') !== meta.sha256) throw new Error('Workspace checkpoint transfer failed verification');
    await writeCheckpoint(ticketId, JSON.stringify({...meta, archive:data.toString('base64')}));
  } finally { await execOnWorkspace(workspace, `rm -f ${shellQuote(remote)}`, {timeout:10_000}).catch(()=>{}); }
}
export async function restoreTicketCheckpoint(ticketId:string, workspace:string, root:string, branch:string) {
  const checkpoint = await readTicketCheckpoint(ticketId);
  if (!checkpoint) return false;
  if (checkpoint.branch !== branch) throw new Error('Saved workspace belongs to a different branch; automatic recovery stopped');
  const remote = '/tmp/lfg-restore-' + crypto.randomUUID();
  try {
    await exec(workspace, `umask 077; : > ${shellQuote(remote)}`);
    const bytes = Buffer.from(checkpoint.archive, 'base64');
    for (let offset=0; offset<bytes.length; offset+=chunkSize) {
      await exec(workspace, `python3 -c 'import base64,sys; open(sys.argv[1],"ab").write(base64.b64decode(sys.argv[2]))' ${shellQuote(remote)} ${shellQuote(bytes.subarray(offset, offset+chunkSize).toString('base64'))}`);
    }
    const digest = await exec(workspace, `python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' ${shellQuote(remote)}`);
    if (digest !== checkpoint.sha256) throw new Error('Restored checkpoint transfer failed verification');
    await run(workspace, {action:'unpack', archive:remote, root, branch});
    return true;
  } finally { await execOnWorkspace(workspace, `rm -f ${shellQuote(remote)}`, {timeout:10_000}).catch(()=>{}); }
}
