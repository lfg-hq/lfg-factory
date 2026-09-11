import { execOnWorkspace } from './mags.ts';
import { prepareBuildRuntime, redactSetupOutput } from './build-preflight.ts';
import { shellQuote as q } from './preview-plan.ts';

/** Freeze tracked manifests before coding starts; never probe a concurrently edited checkout. */
export async function startBuildEnvironmentWorker(opts: Parameters<typeof prepareBuildRuntime>[0]) {
  const dir = `/data/build-sdk-check-${crypto.randomUUID()}`;
  const snapshot = await execOnWorkspace(opts.workspaceId,
    `set -e; mkdir -p ${q(dir)}; git -C ${q(opts.dir)} archive --format=tar HEAD -o ${q(dir+'/source.tar')}; tar -xf ${q(dir+'/source.tar')} -C ${q(dir)}; rm ${q(dir+'/source.tar')}; git -C ${q(dir)} init -q; git -C ${q(dir)} add .`, {timeout:60_000});
  if (snapshot.exitCode !== 0) throw new Error(`Could not prepare SDK manifest snapshot: ${redactSetupOutput(snapshot.stderr)}`);
  opts.onLog('Environment worker checking SDK in parallel with implementation; validation waits for both.');
  const done = prepareBuildRuntime({...opts,dir}).then(() => null, error => error instanceof Error ? error : new Error(String(error)))
    .finally(async () => { await execOnWorkspace(opts.workspaceId, `rm -rf ${q(dir)}`, {timeout:30_000}).catch(() => {}); });
  return {done};
}
