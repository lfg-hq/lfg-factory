import { newWorkspace, execOnWorkspace, stopWorkspace, deleteWorkspace } from "./src/services/mags.ts";

const name = `pidiag-${Date.now().toString(36)}`;
try {
  const { workspaceId } = await newWorkspace(name, { rootfsType: "pi", diskGb: 8 });
  console.log("VM:", workspaceId);
  // DEFAULT environment — do NOT override PATH/prefix. See what the rootfs actually ships.
  const diag = [
    'echo "=== default PATH ==="; echo "$PATH"',
    'echo "=== all node binaries ==="; which -a node 2>&1; ls -la /usr/local/bin/node /root/node/current/bin/node 2>&1',
    'echo "=== node versions ==="; for n in $(which -a node 2>/dev/null); do echo "$n -> $($n --version 2>&1)"; done',
    'echo "=== is pi pre-installed? ==="; which -a pi 2>&1; ls -la /usr/local/bin/pi 2>&1',
    'echo "=== pi --version (default env) ==="; pi --version 2>&1 | head -5',
    'echo "=== pi resolved target ==="; readlink -f "$(command -v pi 2>/dev/null)" 2>&1',
  ].join("\n");
  const b64 = Buffer.from(diag).toString("base64");
  const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash -l`, { timeout: 40000 });
  console.log(r.output);
  await stopWorkspace(workspaceId).catch(() => {});
  await deleteWorkspace(name).catch(() => {});
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
process.exit(0);
