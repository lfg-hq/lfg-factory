import type { ConfigPatch } from './app-profile.ts';

/** Replace the entire recipe, never append a repair behind an obsolete patch. */
export async function replaceVerifiedPatches(patches: ConfigPatch[], io: {
  verifyClean: (patches:ConfigPatch[])=>Promise<void>;
  verifyCurrent: (patches:ConfigPatch[])=>Promise<void>;
  save: (patches:ConfigPatch[])=>Promise<void>;
}) {
  const files=new Set<string>();
  for (const patch of patches) {
    if (files.has(patch.file)) throw new Error('Consolidate replacements into one patch per file: '+patch.file);
    files.add(patch.file);
    if (!patch.replace) throw new Error('Deletion-only patches need surrounding unchanged text in both find and replace so replay can verify them.');
  }
  await io.verifyClean(patches);
  await io.verifyCurrent(patches);
  await io.save(patches);
}

/** Capture only explicitly recorded files; unrelated dirty files never enter the overlay. */
export function consolidatePatchScript(patches: ConfigPatch[], clean: string, current: string): string {
  const payload=Buffer.from(JSON.stringify({patches,clean,current})).toString('base64');
  return `python3 - '${payload}' <<'PY'
import base64,json,os,sys,hashlib
p=json.loads(base64.b64decode(sys.argv[1])); result=[]
def path(root,file):
    root=os.path.realpath(root); full=os.path.realpath(os.path.join(root,file))
    if not full.startswith(root+os.sep) or file.split('/')[0] in ('.git','.env'):
        raise Exception('Unsafe saved patch path')
    return full
for file in dict.fromkeys(x['file'] for x in p['patches']):
    old=path(p['clean'],file); new=path(p['current'],file)
    if not os.path.isfile(new): raise Exception('Saved repair file missing: '+file)
    after=open(new,encoding='utf-8-sig').read()
    note='; '.join(dict.fromkeys(x.get('note','') for x in p['patches'] if x['file']==file and x.get('note')))
    if not os.path.isfile(old):
        if not any(x.get('create') for x in p['patches'] if x['file']==file): raise Exception('Baseline file missing: '+file)
        if not after: raise Exception('Empty created patch cannot be verified: '+file)
        result.append(dict(file=file,find='',replace=after,create=True,note=note,afterHash=hashlib.sha256(after.encode()).hexdigest())); continue
    before=open(old,encoding='utf-8-sig').read()
    if before==after: continue
    # One contiguous, uniquely identifiable replacement covers all edits in a file.
    start=0
    while start<min(len(before),len(after)) and before[start]==after[start]: start+=1
    end=0
    while end<min(len(before),len(after))-start and before[-1-end]==after[-1-end]: end+=1
    start=before.rfind('\\n',0,start)+1
    while True:
        find=before[start:len(before)-end if end else len(before)]
        replace=after[start:len(after)-end if end else len(after)]
        if find and replace and before.count(find)==1 and after.count(replace)==1: break
        if end: end=0
        elif start: start=0
        else: raise Exception('Cannot construct verifiable patch: '+file)
    result.append(dict(file=file,find=find,replace=replace,note=note,beforeHash=hashlib.sha256(before.encode()).hexdigest(),afterHash=hashlib.sha256(after.encode()).hexdigest()))
print(json.dumps(result))
PY`;
}
