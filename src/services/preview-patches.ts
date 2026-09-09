import { shellQuote } from "./preview-plan.ts";
import type { ConfigPatch } from "./app-profile.ts";
export function buildConfigPatchScript(patches: ConfigPatch[] | undefined, dir: string): string {
  if (!patches || !patches.length) return "";
  const blob = Buffer.from(JSON.stringify(patches.map((p) => ({ file: p.file, find: p.find, replace: p.replace, create: p.create })))).toString("base64");
  return `python3 - ${shellQuote(dir)} ${shellQuote(blob)} <<'PYEOF'
import base64, json, os, sys
base = os.path.realpath(sys.argv[1])
patches = json.loads(base64.b64decode(sys.argv[2]))
contents = {}
for p in patches:
    fp = os.path.realpath(os.path.join(base, p["file"]))
    if not fp.startswith(base + os.sep):
        raise SystemExit("Config patch path escapes checkout: " + p["file"])
    if not os.path.isfile(fp):
        if p.get("create") and not p["find"]:
            contents[fp] = p["replace"]
            print("Created patch file:", p["file"])
            continue
        raise SystemExit("Config patch file missing: " + p["file"])
    s = contents.get(fp)
    if s is None:
        s = open(fp, encoding="utf-8-sig").read()
    if p["find"] and p["find"] in s:
        s = s.replace(p["find"], p["replace"])
        print("Applied patch:", p["file"])
    elif p["replace"] and p["replace"] in s:
        print("Verified patch:", p["file"])
    else:
        raise SystemExit("Config patch no longer matches: " + p["file"])
    contents[fp] = s
for fp, s in contents.items():
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w", encoding="utf-8") as f:
        f.write(s)
PYEOF`;

}
