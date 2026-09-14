import { spawn } from 'node:child_process';

/** Never let an interactive data-loss prompt be mistaken for a successful sync. */
export function safeSchemaPush(command = ['bun', 'run', 'db:push']): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', blocked = false;
    const consume = (chunk: Buffer, target: NodeJS.WriteStream) => {
      target.write(chunk);
      tail = (tail + chunk.toString()).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-16000);
      if (!blocked && /data.loss statements|will cause data loss|do you still want to push changes/i.test(tail)) {
        blocked = true;
        process.stderr.write('\nSchema sync blocked: review the proposed destructive changes. The application will not start with an aborted schema sync.\n');
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', c => consume(c, process.stdout));
    child.stderr.on('data', c => consume(c, process.stderr));
    child.on('error', error => { process.stderr.write(error.message + '\n'); resolve(1); });
    child.on('close', code => resolve(blocked ? 1 : code ?? 1));
  });
}
if (import.meta.main) process.exitCode = await safeSchemaPush();
