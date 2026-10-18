import {createHash} from 'node:crypto';
import {shellQuote as q} from './preview-plan.ts';
export function previewCheckoutDir(branch:string) {return '/data/preview-branch-'+createHash('sha256').update(branch).digest('hex').slice(0,20);}
export function assertPreviewBranch(branch:string) {
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)||branch.includes('..')||branch.includes('//')||branch.endsWith('.lock'))throw Error('Invalid preview branch');
}
/** A detached, preview-owned checkout never moves or cleans a ticket's branch/worktree. */
export function refreshPreviewCheckout(root:string,dir:string,branch:string,authUrl:string) {
 assertPreviewBranch(branch);
 return `set -eu
cd ${q(root)}
git check-ref-format --branch ${q(branch)} >/dev/null
git remote set-url origin ${q(authUrl)}
git fetch --no-tags origin ${q('+refs/heads/'+branch+':refs/remotes/origin/'+branch)}
TARGET=$(git rev-parse ${q('refs/remotes/origin/'+branch)})
CLEAN_OUTPUTS=0
if test -e ${q(dir+'/.git')}; then
 CHANGED=$(git -C ${q(dir)} diff --name-only HEAD "$TARGET")
 if printf '%s\n' "$CHANGED" | grep -Eq '\\.(cshtml|razor|csproj|fsproj|props|targets)$|(^|/)(global\\.json|Directory\\.Packages\\.props)$'; then CLEAN_OUTPUTS=1; fi
fi
if test -e ${q(dir+'/.git')}; then
  test -z "$(git -C ${q(dir)} symbolic-ref -q HEAD || true)" || { echo 'Preview checkout is owned by a branch; refusing to reset it'; exit 1; }
  if test -n "$(git -C ${q(dir)} status --porcelain)"; then git -C ${q(dir)} stash push --include-untracked -m 'Preview configuration before refresh'; fi
  git -C ${q(dir)} checkout --detach "$TARGET"
else
  test ! -e ${q(dir)} || { echo 'Unregistered preview directory preserved'; exit 1; }
  git worktree add --detach ${q(dir)} "$TARGET"
fi
test "$(git -C ${q(dir)} rev-parse HEAD)" = "$TARGET"
if test "$CLEAN_OUTPUTS" = 1; then
 ${cleanPreviewBuildCommand(dir)}
fi
echo "WT_OK $TARGET"`;
}
/** UI-only changes cannot affect a runtime recipe. All other tracked inputs remain conservative. */
export function runtimeFingerprintCommand(dir:string) {
 return `python3 - ${q(dir)} <<'PY'
import hashlib,subprocess,sys
rows=subprocess.check_output(['git','-C',sys.argv[1],'ls-tree','-r','HEAD']).splitlines()
def relevant(row):
 path=row.split(b'\\t',1)[1].decode()
 name=path.rsplit('/',1)[-1].lower()
 return not (name.endswith(('.css','.scss','.sass','.less','.png','.jpg','.jpeg','.svg','.gif','.webp','.ico','.woff','.woff2')) or ('/components/' in '/'+path and name.endswith(('.tsx','.jsx'))))
print(hashlib.sha256(b'\\n'.join(row for row in rows if relevant(row))).hexdigest())
PY`;
}
export function cleanPreviewBuildCommand(dir:string) {
 return `python3 - ${q(dir)} <<'PY'
import os,sys,subprocess,shutil
root=os.path.realpath(sys.argv[1])
for base,dirs,files in os.walk(root,topdown=True):
 for name in list(dirs):
  if name in ('.git','node_modules'): dirs.remove(name); continue
  path=os.path.join(base,name)
  if name in ('bin','obj','.next','dist') and not os.path.islink(path):
   relative=os.path.relpath(path,root)+'/'
   if subprocess.run(['git','-C',root,'check-ignore','-q',relative]).returncode==0:
    tracked=subprocess.check_output(['git','-C',root,'ls-files','--',relative])
    if not tracked: shutil.rmtree(path);dirs.remove(name)
PY`;
}

export function cachedInstallCommand(dir:string,command:string) {
 if(!/^\s*(npm (ci|install)|pnpm install|yarn( install)?)(\s|$)/.test(command) || /[;&|`\n]|\$\(/.test(command))return command;
 const fingerprint=`python3 - ${q(command)} <<'PY'
import hashlib,subprocess,sys,pathlib,json
names=('package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','pnpm-workspace.yaml','yarn.lock','.npmrc','.yarnrc.yml')
rows=subprocess.check_output(['git','ls-tree','-r','HEAD']).splitlines()
parts=[r for r in rows if r.split(b'\\t',1)[1].decode().rsplit('/',1)[-1] in names]
# Lifecycle hooks can generate code from arbitrary source files. Include the full
# tree when hooks exist rather than reusing potentially stale generated clients.
for row in rows:
 path=row.split(b'\\t',1)[1].decode()
 if path.endswith('package.json'):
  scripts=json.loads(pathlib.Path(path).read_text()).get('scripts',{})
  if any(key in scripts for key in ('preinstall','install','postinstall','prepare','prepublish')):
   parts += rows
   break
parts += [sys.argv[1].encode(),subprocess.check_output(['node','--version'])]
if pathlib.Path('.env').is_file():parts.append(pathlib.Path('.env').read_bytes())
print(hashlib.sha256(b'\\n'.join(parts)).hexdigest())
PY`;
 return `set -e
cd ${q(dir)}
FINGERPRINT=$(${fingerprint})
if test -d node_modules && test -f node_modules/.lfg-install-receipt && test "$(cat node_modules/.lfg-install-receipt)" = "$FINGERPRINT"; then
 echo 'Reusing installed dependencies: manifests, runtime and environment are unchanged'
else
 ${command}
 if test -d node_modules; then printf '%s' "$FINGERPRINT" > node_modules/.lfg-install-receipt; fi
fi`;
}
