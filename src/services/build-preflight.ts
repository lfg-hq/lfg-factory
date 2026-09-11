import { shellQuote as q } from "./preview-plan.ts";

/** Replace any token saved by an earlier clone before contacting origin. */
export function refreshOriginCommand(authUrl: string): string {
  return `git config --local --replace-all remote.origin.url ${q(authUrl)}`;
}

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
    if (/Authentication failed|HTTP Basic: Access denied/i.test(output)) {
      const provider = /gitlab/i.test(output) ? "GitLab" : /github/i.test(output) ? "GitHub" : "your Git provider";
      throw new Error(`Repository authentication failed. Reconnect ${provider} in Settings → Integrations and verify repository access, then retry. ${output.trim().slice(-2000)}`);
    }
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

/** Read-only fast path. Unknown manifests or SDK selection fall back to the normal probe. */
export function savedDotnetCheck(version: string): string | null {
  const major = version.match(/^(?:net)?(\d+)\.\d+(?:\.\d+)?$/)?.[1];
  if (!major) return null;
  return `python3 - <<'LFG_SDK_CHECK'
import pathlib, re, subprocess, sys, xml.etree.ElementTree as ET
expected = ${Number(major)}
try:
    root = pathlib.Path.cwd()
    files = subprocess.check_output(['git', 'ls-files', '-z'], text=True).split('\\0')
    projects = [root / f for f in files if f.endswith('.csproj')]
    # A mixed runtime repo needs the full toolchain probe, not just a dotnet check.
    other = {'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'Gemfile', 'composer.json'}
    assert projects and not any(pathlib.Path(f).name in other for f in files)
    # Imported framework overrides require MSBuild evaluation by the normal probe.
    for file in files:
        if file.endswith(('.props', '.targets')):
            tree = ET.parse(root / file)
            assert not any(e.tag.split('}')[-1] in ('TargetFramework', 'TargetFrameworks') for e in tree.iter())
    for project in projects:
        tree = ET.parse(project)
        frameworks = [e.text or '' for e in tree.iter() if e.tag.split('}')[-1] in ('TargetFramework', 'TargetFrameworks')]
        assert frameworks
        for framework in frameworks:
            for target in framework.split(';'):
                match = re.fullmatch(r'net(\\d+)\\.\\d+(?:-[a-zA-Z0-9.]+)?', target.strip())
                assert match and int(match.group(1)) == expected
        selected = subprocess.check_output(['dotnet', '--version'], cwd=project.parent, text=True).strip()
        assert re.fullmatch(r'\\d+\\.\\d+\\.\\d+', selected) and int(selected.split('.')[0]) == expected
    # Confirm it is an installed SDK, rather than only an installed runtime.
    sdks = subprocess.check_output(['dotnet', '--list-sdks'], text=True)
    assert any(line.startswith(str(expected) + '.') for line in sdks.splitlines())
    print('LFG_SAVED_SDK_VERIFIED')
except Exception:
    sys.exit(1)
LFG_SDK_CHECK`;
}

/** Reuse a verified installed SDK, otherwise probe the actual checkout with preview knowledge. */
export async function prepareBuildRuntime(opts: {workspaceId:string; projectId:string; branch:string; anchorBranch?:string; dir:string; userId:string; onLog:(s:string)=>void}) {
  const { loadAppProfile, probeAppProfile } = await import("./app-profile.ts");
  const { runBackgroundCommand } = await import("./background-command.ts");
  const profiles = await Promise.all([...new Set([opts.branch,opts.anchorBranch,"default"].filter((b):b is string=>!!b))].map(branch=>loadAppProfile(opts.projectId,branch)));
  const knowledge = profiles.filter(p=>p!==null).map(p=>JSON.stringify({stack:p.profile.stack,runtimeVersion:p.profile.runtimeVersion,toolchain:p.profile.toolchain,directives:p.profile.directives}));
  opts.onLog("Preparing build SDK from the ticket checkout and saved preview discoveries…");
  const saved = profiles.find(p=>p?.profile.runtime?.toLowerCase()==="dotnet");
  const quickCheck = saved && savedDotnetCheck(saved.profile.runtimeVersion);
  if (quickCheck) {
    opts.onLog("Checking the inherited SDK against repository manifests and global.json…");
    const { execOnWorkspace } = await import("./mags.ts");
    try {
      const checked = await execOnWorkspace(opts.workspaceId, `cd ${q(opts.dir)} && ${quickCheck}`, {timeout:30_000});
      if (checked.exitCode===0 && /^LFG_SAVED_SDK_VERIFIED$/m.test(checked.output || "")) {
        opts.onLog(`Build runtime ready: ${saved.profile.stack} (verified installed SDK; skipped probe and installation)`);
        return;
      }
    } catch { /* A missing check tool or unknown VM state requires the full probe. */ }
    opts.onLog("Inherited SDK could not be verified for this checkout; probing build requirements…");
  }

  const profile = await probeAppProfile({workspaceId:opts.workspaceId,workDir:opts.dir,userId:opts.userId,onLog:opts.onLog,
    knowledge:[...knowledge,"This is the BUILD sandbox. Verify the required SDK against repository manifests/global.json and this VM's OS. Record complete idempotent installation commands, even if another preview VM already has the SDK. Install executables on the standard PATH (symlink dotnet into /usr/local/bin if using /data/.dotnet). Never copy preview credentials, connection strings or source patches. Do not build or change application source during this probe."]});
  if (!profile) throw new Error("Build setup blocked: runtime probe produced no recipe");
  const commands = [...profile.toolchain, runtimeCheck(profile.runtime,profile.runtimeVersion)];
  for (const [i, command] of commands.entries()) {
    opts.onLog(i===commands.length-1 ? `Verifying ${profile.runtime} SDK (${profile.runtimeVersion})…` : `Installing build toolchain: step ${i+1}/${profile.toolchain.length}…`);
    const result = await runBackgroundCommand({workspaceId:opts.workspaceId,cwd:opts.dir,command:`set -e\n${command}`,timeoutMs:Number(process.env.BUILD_SETUP_TIMEOUT_MS || 1_800_000),log:opts.onLog});
    if(result.exitCode!==0) throw new Error(`Build SDK setup failed at step ${i+1} (exit ${result.exitCode}): ${redactSetupOutput(result.output).slice(-2000)}`);
  }
  opts.onLog(`Build runtime ready: ${profile.stack}`);
}
