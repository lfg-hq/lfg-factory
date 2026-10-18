import { createHash } from "node:crypto";
import { shellQuote } from "./preview-plan.ts";

export const UNSAFE_ENV_KEYS = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TERM", "HOSTNAME", "SHLVL", "_", "LD_LIBRARY_PATH", "LD_PRELOAD"]);
export type EnvironmentSnapshot = { values: Record<string, string>; appliedAt: string };
export function environmentFingerprint(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, createHash("sha256").update(value).digest("hex")]));
}
export function environmentChanges(current: Record<string, string>, previous?: EnvironmentSnapshot) {
  return [...new Set([...Object.keys(current), ...Object.keys(previous?.values || {})])]
    .filter(key => current[key] !== previous?.values[key]).sort();
}
// These prefixes are compiled into browser bundles. Other build-time keys can
// be recorded in the runtime profile when the app's build recipe requires them.
export function requiresEnvironmentBuild(keys: string[], extra: string[] = []) {
  return keys.some(key => /^(NEXT_PUBLIC_|VITE_|REACT_APP_|GATSBY_|PUBLIC_)/.test(key) || extra.includes(key));
}

/** Replace complete shell assignments (including multiline secrets), preserving
 * all untouched runtime repairs and branch-specific database connections. */
export function environmentPatchCommand(dir: string, changes: Record<string, string | null>): string {
  for (const key of Object.keys(changes)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || UNSAFE_ENV_KEYS.has(key)) throw new Error("Invalid environment variable name");
  }
  const payload = Buffer.from(JSON.stringify(changes)).toString("base64");
  return `python3 - ${shellQuote(dir + "/.env")} ${shellQuote(payload)} <<'LFG_ENV_PY'
import base64, json, os, re, shlex, sys, tempfile
path = sys.argv[1]
changes = json.loads(base64.b64decode(sys.argv[2]))
try:
    text = open(path).read()
    blocks, pending = [], ''
    for line in text.splitlines(keepends=True):
        pending += line
        try: shlex.split(pending, comments=True)
        except ValueError: continue
        blocks.append(pending)
        pending = ''
    if pending: raise ValueError('Incomplete environment assignment')
    kept = []
    for block in blocks:
        match = re.match(r'^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=', block)
        unset = re.match(r'^\\s*unset\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*$', block)
        key = (match or unset).group(1) if (match or unset) else None
        if key not in changes: kept.append(block)
    body = ''.join(kept).rstrip('\\n') + '\\n'
    for key, value in changes.items():
        body += ('unset ' + key if value is None else key + '=' + shlex.quote(value)) + '\\n'
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.env-')
    try:
        with os.fdopen(fd, 'w') as out: out.write(body)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)
except Exception:
    print('Could not apply saved environment settings; existing file retained.', file=sys.stderr)
    sys.exit(1)
LFG_ENV_PY`;
}
