import { shellQuote as q } from "./preview-plan.ts";

export interface BackgroundOptions {
  workspaceId: string; command: string; cwd?: string; timeoutMs?: number;
  jobId?: string; cancelled?: () => boolean; log?: (message: string) => void;
}

/** Stable job directories make a retried launch idempotent. Logs and exit status survive HTTP loss. */
export function backgroundLaunch(base: string, command: string, cwd: string, seconds: number): string {
  const body = Buffer.from(`cd ${q(cwd)} || exit 1\n${command}\n`).toString("base64");
  const runner = `timeout -k 10 ${seconds} bash ${q(base+'/command.sh')} > ${q(base+'/output.log')} 2>&1\ncode=$?\necho "$code" > ${q(base+'/exit.tmp')}\nmv ${q(base+'/exit.tmp')} ${q(base+'/exit')}`;
  return `set -e\numask 077\nmkdir -p /data/lfg-jobs\nif mkdir ${q(base)} 2>/dev/null; then
echo ${body} | base64 -d > ${q(base+'/command.sh')}
echo ${q(body)} > ${q(base+'/request')}
setsid bash -c ${q(runner)} </dev/null >/dev/null 2>&1 &
echo $! > ${q(base+'/pid')}
echo STARTED
else
test "$(cat ${q(base+'/request')})" = ${q(body)} || { echo JOB_REQUEST_MISMATCH; exit 1; }
echo ATTACHED
fi`;
}

export function backgroundPoll(base: string): string {
  return `if test -f ${q(base+'/exit')}; then echo DONE; cat ${q(base+'/exit')}; tail -c 24000 ${q(base+'/output.log')};
elif test -f ${q(base+'/pid')}; then p=$(cat ${q(base+'/pid')}); case "$p" in ''|*[!0-9]*) echo INVALID_PID;; *) if kill -0 "$p" 2>/dev/null; then echo RUNNING; tail -c 4000 ${q(base+'/output.log')}; else echo LOST; tail -c 24000 ${q(base+'/output.log')}; fi;; esac;
else echo PENDING; fi`;
}

export async function runBackgroundCommand(o: BackgroundOptions, deps?: {
  exec: (workspace: string, command: string) => Promise<{exitCode:number;output:string;stderr?:string}>;
  wait: () => Promise<void>; now: () => number;
}) {
  const exec = deps?.exec ?? (async (workspace: string, script: string) => {
    const {execOnWorkspace} = await import("./mags.ts");
    return execOnWorkspace(workspace, `echo ${Buffer.from(script).toString('base64')} | base64 -d | bash`, {timeout:20_000});
  });
  const wait = deps?.wait ?? (()=>new Promise<void>(resolve=>setTimeout(resolve,30_000)));
  const now = deps?.now ?? Date.now;
  const id = o.jobId ?? crypto.randomUUID();
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid background job ID");
  const base = `/data/lfg-jobs/${id}`;
  const limit = o.timeoutMs ?? 1_800_000;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("Invalid background command runtime limit");
  const start = now(); let heartbeat=start; let pendingSince:number|undefined;
  o.log?.(`Background job ${id} started; command: ${o.command}; logs: ${base}/output.log`);
  // If the response is lost, the command may already be running. Poll its stable ID.
  try {
    const launch = await exec(o.workspaceId,backgroundLaunch(base,o.command,o.cwd ?? "/data",Math.ceil(limit/1000)));
    if (launch.exitCode!==0) throw new Error(`Background launch failed: ${launch.output} ${launch.stderr ?? ""}`);
  } catch (e) {
    if ((e as Error).message.startsWith("Background launch failed:")) throw e;
    o.log?.(`Launch response unavailable; checking existing job ${id} before taking further action…`);
  }
  const stop=async()=>{
    const result=await exec(o.workspaceId,`p=$(cat ${q(base+'/pid')}); case "$p" in ''|*[!0-9]*) exit 1;; esac; kill -TERM -- -"$p" 2>/dev/null || true`);
    if(result.exitCode!==0) throw new Error(`Could not confirm stop of background job ${id}; its sandbox runtime limit remains active`);
  };
  while (now()-start < limit+15_000) {
    if(o.cancelled?.()) { await stop(); throw new Error(`Background job ${id} cancelled`); }
    let state;
    try { state=await exec(o.workspaceId,backgroundPoll(base)); }
    catch { await wait(); continue; } // Reconnect to this job, never rerun its command.
    if(state.exitCode===0 && state.output.startsWith("DONE\n")) {
      const match=state.output.match(/^DONE\n(\d+)\n?([\s\S]*)$/);
      if(!match) throw new Error(`Invalid completion status for background job ${id}`);
      o.log?.(`Background job ${id} finished (exit ${match[1]}, ${Math.round((now()-start)/1000)}s); ${match[2] ?? ""}`);
      return {exitCode:Number(match[1]),output:match[2] ?? "",jobId:id};
    }
    if (/^(LOST|INVALID_PID)/.test(state.output)) throw new Error(`Background job ${id} exited without a completion record: ${state.output}`);
    if(state.output.trim()==="PENDING") {
      pendingSince ??= now();
      if(now()-pendingSince>60_000) throw new Error(`Background job ${id} did not record startup; inspect ${base} before retrying`);
    } else pendingSince=undefined;
    if(now()-heartbeat>=15_000) {heartbeat=now();o.log?.(`Background job ${id} is still running (${Math.round((now()-start)/1000)}s); ${state.output.replace(/^RUNNING\n?/, "").trim() || "No new output; waiting for exit status…"}`);}
    await wait();
  }
  await stop();
  throw new Error(`Background job ${id} exceeded its maximum runtime; logs are retained at ${base}/output.log`);
}
