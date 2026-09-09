import { shellQuote as q } from "./preview-plan.ts";

export function redactSetupOutput(value: string, secrets: string[] = []): string {
  for (const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length)) value = value.split(secret).join("[redacted]");
  return value.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@");
}

/** Fail closed on stderr-only failures and on a checkout of the wrong branch. */
export async function runGitSetup(workspaceId: string, script: string, dir: string, branch: string, secrets: string[] = []) {
  const { execOnWorkspace } = await import("./mags.ts");
  const checked = `set -e\nexport GIT_TERMINAL_PROMPT=0\necho GIT_SETUP_STARTED\n${script}\ncd ${q(dir)}\ngit rev-parse --verify HEAD\ntest "$(git branch --show-current)" = ${q(branch)}\necho GIT_CHECKOUT_VERIFIED`;
  const encoded = Buffer.from(checked).toString("base64");
  let result;
  try {
    result = await execOnWorkspace(workspaceId, `echo ${encoded} | base64 -d | sh`, { timeout: 300_000 });
  } catch (e) {
    throw new Error(redactSetupOutput(`Git setup execution failed: ${(e as Error).message}`, secrets));
  }
  const output = redactSetupOutput([result.output, result.stderr].filter(Boolean).join("\n"), secrets);
  if (result.exitCode !== 0 || !/^GIT_CHECKOUT_VERIFIED$/m.test(output)) {
    throw new Error(`Git setup failed (exit ${result.exitCode ?? "unknown"}): ${output.trim().slice(-3000) || "No stdout or stderr returned by the sandbox; checkout could not be verified"}`);
  }
  return { ...result, output };
}

export function runtimeCheck(runtime: string, version = ""): string {
  const checks: Record<string,string> = { dotnet: "dotnet --list-sdks | grep -q .; dotnet --version", node: "node --version", python: "python3 --version", ruby: "ruby --version", php: "php --version", go: "go version", rust: "cargo --version" };
  const check = checks[runtime.toLowerCase()];
  if (!check) throw new Error(`No build runtime verification configured for ${runtime}`);
  const major = runtime.toLowerCase()==="dotnet" ? version.match(/(?:net|\b)(\d+)\./)?.[1] : undefined;
  return major ? `dotnet --list-sdks | grep -q '^${major}\\.'; dotnet --version` : check;
}

/** Re-probe the actual checkout with preview knowledge; never copy preview secrets or patches. */
export async function prepareBuildRuntime(opts: {workspaceId:string; projectId:string; branch:string; anchorBranch?:string; dir:string; userId:string; onLog:(s:string)=>void}) {
  const { loadAppProfile, probeAppProfile } = await import("./app-profile.ts");
  const { validationShell } = await import("./validation-sandbox.ts");
  const profiles = await Promise.all([...new Set([opts.branch,opts.anchorBranch,"default"].filter((b):b is string=>!!b))].map(branch=>loadAppProfile(opts.projectId,branch)));
  const knowledge = profiles.filter(p=>p!==null).map(p=>JSON.stringify({stack:p.profile.stack,runtimeVersion:p.profile.runtimeVersion,toolchain:p.profile.toolchain,directives:p.profile.directives}));
  opts.onLog("Preparing build SDK from the ticket checkout and saved preview discoveries…");
  const profile = await probeAppProfile({workspaceId:opts.workspaceId,workDir:opts.dir,userId:opts.userId,onLog:opts.onLog,
    knowledge:[...knowledge,"This is the BUILD sandbox. Verify the required SDK against repository manifests/global.json and this VM's OS. Record complete idempotent installation commands, even if another preview VM already has the SDK. Install executables on the standard PATH (symlink dotnet into /usr/local/bin if using /data/.dotnet). Never copy preview credentials, connection strings or source patches. Do not build or change application source during this probe."]});
  if (!profile) throw new Error("Build setup blocked: runtime probe produced no recipe");
  const commands = [...profile.toolchain, runtimeCheck(profile.runtime,profile.runtimeVersion)];
  for (const [i, command] of commands.entries()) {
    opts.onLog(i===commands.length-1 ? `Verifying ${profile.runtime} SDK (${profile.runtimeVersion})…` : `Installing build toolchain: step ${i+1}/${profile.toolchain.length}…`);
    const result = await validationShell(opts.workspaceId,`set -e\ncd ${q(opts.dir)}\n${command}`,300_000);
    if(result.exitCode!==0) throw new Error(`Build SDK setup failed at step ${i+1} (exit ${result.exitCode}): ${redactSetupOutput(result.output).slice(-2000)}`);
  }
  opts.onLog(`Build runtime ready: ${profile.stack}`);
}
