import {previewCheckoutDir} from './preview-checkout.ts';
import { shellQuote } from "./preview-plan.ts";

/** Resolve the already prepared checkout, never substitute another branch. */
export function restartWorktree(porcelain: string, branch: string | null, mainDir = "/data/project"): string {
  const entries = porcelain.trim().split(/\n\s*\n/).map(record => ({
    dir: record.match(/^worktree (.+)$/m)?.[1],
    branch: record.match(/^branch refs\/heads\/(.+)$/m)?.[1],
    prunable: /^prunable(?: |$)/m.test(record),
  }));
  const dedicated = branch && branch !== "(default)" ? entries.find(e => !e.prunable && e.dir === previewCheckoutDir(branch)) : undefined;
  const match = dedicated || entries.find(e => !e.prunable && (branch && branch !== "(default)" ? e.branch === branch : e.dir === mainDir));
  if (!match?.dir) throw new Error("The prepared checkout is missing. Use Update & rebuild to prepare the selected branch again.");
  return match.dir;
}

/** Launch only the saved server command. No dependency, build or database steps. */
export function restartServerCommand(dir: string, port: number, command: string, environment: string, logName = "preview.log", exitFile = `${dir}/${logName}.exit`): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port");
  if (!command.trim()) throw new Error("No saved start command. Use Update & rebuild first.");
  const log = `${dir}/${logName}`;
  const child = `${environment} cd ${shellQuote(dir)} || exit 1; ${command}`;
  const wrapper = `sh -c ${shellQuote(child)}; code=$?; echo "$code" > ${shellQuote(exitFile)}; exit "$code"`;
  return `test -e ${shellQuote(dir + "/.git")} || { echo 'Prepared checkout is missing'; exit 1; }
command -v setsid >/dev/null && command -v fuser >/dev/null && command -v curl >/dev/null || { echo 'Runtime tools are missing; use Update & rebuild'; exit 1; }
fuser -k ${port}/tcp 2>/dev/null || true
for attempt in 1 2 3; do
  fuser ${port}/tcp >/dev/null 2>&1 || break
  sleep 1
done
if fuser ${port}/tcp >/dev/null 2>&1; then echo 'Previous server still owns port ${port}'; exit 1; fi
rm -f ${shellQuote(exitFile)}
setsid sh -c ${shellQuote(wrapper)} </dev/null > ${shellQuote(log)} 2>&1 &
echo STARTED`;
}

/** A short readiness check with explicit exit/error/timeout; never starts AI repair. */
export async function waitForRestart(deps: {
  probe: () => Promise<{ code: number; exited: boolean }>;
  cancelled: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  progress: (seconds: number) => void;
}, timeoutMs = 60_000): Promise<void> {
  const start = deps.now();
  while (deps.now() - start < timeoutMs) {
    if (deps.cancelled()) throw new Error("__CANCELLED__");
    const state = await deps.probe();
    if (deps.cancelled()) throw new Error("__CANCELLED__");
    if (state.exited) throw new Error("The saved start command exited. Check App logs; use Update & rebuild if dependencies or build files are missing.");
    if (state.code >= 200 && state.code < 500) return;
    if (state.code >= 500) throw new Error(`The app started but returned HTTP ${state.code}. Check App logs for the application error.`);
    deps.progress(Math.round((deps.now() - start) / 1000));
    await deps.sleep(1500);
  }
  throw new Error("The app did not respond within 60 seconds. Check App logs; no automatic rebuild or repair was started.");
}
