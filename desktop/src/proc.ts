/** Running git and other programs for the runner, with their output captured. */

import { spawn } from "node:child_process";

export interface RunOpts { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

export async function mustRun(cmd: string, args: string[], opts: RunOpts, label: string): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${label} failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  return r.stdout;
}

