"""Owned worker process groups; shared selected-checkout env; no application mutations."""
import os, sys, json, base64, subprocess, time, signal, pathlib, hashlib, fcntl, re
cfg=json.loads(base64.b64decode(sys.argv[1])); action=cfg['action']; root=os.path.realpath(cfg['dir'])
state_path=pathlib.Path(cfg.get('stateFile','/data/.lfg-preview-workers.json'))
state_path.parent.mkdir(parents=True,exist_ok=True)
lock=open(str(state_path)+'.lock','a');fcntl.flock(lock,fcntl.LOCK_EX)
def info(pid):
 try:
  p=pathlib.Path('/proc')/str(pid); fields=(p/'stat').read_text().rsplit(')',1)[1].split()
  return {'pid':int(pid),'birth':fields[19],'state':fields[0],'group':int(fields[2]),'cwd':os.path.realpath(p/'cwd'),'args':(p/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')}
 except (OSError,ValueError):return None
def alive(row):
 p=info(row['pid']);return p and p['birth']==row['birth'] and p['state']!='Z'
def read_state():
 try:return json.loads(state_path.read_text())
 except FileNotFoundError:return {'workers':[]}
def save(state):
 tmp=state_path.with_suffix('.tmp');tmp.write_text(json.dumps(state));os.chmod(tmp,0o600);os.replace(tmp,state_path)
def terminate(rows):
 owned=[r for r in rows if alive(r)]
 if not owned:return 0
 groups={r['pid'] for r in owned if r['group']==r['pid']}
 for p in pathlib.Path('/proc').iterdir():
  if p.name.isdigit():
   child=info(int(p.name))
   if child and child['group'] in groups and not any(r['pid']==child['pid'] for r in owned):owned.append(child)
 for r in owned:
  try:
   current=info(r['pid'])
   if not current or current['birth']!=r['birth']:continue
   if current['group']==r['pid']:os.killpg(r['pid'],signal.SIGTERM)
   else:os.kill(r['pid'],signal.SIGTERM)
  except ProcessLookupError:pass
 deadline=time.monotonic()+8
 while any(alive(r) for r in owned) and time.monotonic()<deadline:time.sleep(.1)
 for r in owned:
  if alive(r):
   try:
    current=info(r['pid'])
    if not current or current['birth']!=r['birth']:continue
    if current['group']==r['pid']:os.killpg(r['pid'],signal.SIGKILL)
    else:os.kill(r['pid'],signal.SIGKILL)
   except ProcessLookupError:pass
 return len(owned)
def env_for_root():
 r=subprocess.run(['sh','-c','set -a; if [ -f ./.env ]; then . ./.env || exit 1; fi; set +a; env -0'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if r.returncode:raise RuntimeError('Could not load the selected checkout environment')
 return dict(x.decode().split('=',1) for x in r.stdout.split(b'\0') if b'=' in x)
def signature(env):
 return hashlib.sha256(json.dumps({k:env.get(k) for k in cfg.get('databaseKeys',[])},sort_keys=True).encode()).hexdigest()
def process_env(pid):
 return dict(x.decode().split('=',1) for x in pathlib.Path('/proc',str(pid),'environ').read_bytes().split(b'\0') if b'=' in x)
def environment_matches(row,expected):
 if row.get('environment')!=expected or row.get('root')!=root:return False
 if not alive(row):return False
 for p in pathlib.Path('/proc').iterdir():
  if p.name.isdigit():
   child=info(int(p.name))
   if child and child['state']!='Z' and child['group']==row['pid']:
    try:
     if signature(process_env(child['pid']))!=expected:return False
    except FileNotFoundError:pass
 return True
def legacy():
 # Exact declared executable in the selected checkout or platform-created scratch
 # checkout only. Never kill by generic 'node', 'npm', or worker keyword.
 entries=[w.get('entrypoint') for w in cfg['workers'] if w.get('entrypoint')]
 rows=[]
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit():continue
  r=info(int(p.name))
  if not r or r['pid']==os.getpid():continue
  location=r['cwd']==root or r['cwd'].startswith(root+'/') or r['cwd'].startswith('/data/preview-check-')
  if location and r['args'].split(' ',1)[0].split('/')[-1] in ['node','bun','python','python3','tsx'] and any(e in r['args'].split() for e in entries):rows.append(r)
 return rows
try:
 state=read_state()
 if action=='cleanup':
  # Scratch trees are platform-created; clean every detached process still using
  # that exact tree before git removes it. A listener-only kill misses workers.
  if not pathlib.Path(root).name.startswith('preview-check-'):raise RuntimeError('Cleanup requires a preview-check directory')
  rows=[]
  ancestors=set();pid=os.getpid()
  while pid>1:
   ancestors.add(pid)
   try:pid=int(pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[1])
   except OSError:break
  for p in pathlib.Path('/proc').iterdir():
   if p.name.isdigit():
    r=info(int(p.name))
    if r and r['pid'] not in ancestors and (r['cwd']==root or r['cwd'].startswith(root+'/')):rows.append(r)
  terminate(rows);state['workers']=[w for w in state['workers'] if w.get('root')!=root];save(state)
  print(json.dumps({'cleaned':len(rows)}));sys.exit(0)
 if action=='stop':
  count=terminate(state['workers']+legacy());save({'workers':[]});print(json.dumps({'stopped':count}));sys.exit(0)
 env=env_for_root();expected=signature(env)
 if action=='start':
  for spec in cfg['workers']:
   if any(name!='.env' for name in spec.get('environmentFiles',[])):
    raise RuntimeError('Worker '+spec['name']+' requires a noncanonical environment file. Update its repository command through a ticket to use .env; alternate environment files are never seeded.')
  terminate(state['workers']+legacy());state={'root':root,'workers':[]};save(state)
  # Refuse green startup when the web listener has a different DB environment.
  if cfg['workers'] and cfg.get('webPort') and cfg.get('databaseKeys'):
   inodes=set()
   for table in ['/proc/net/tcp','/proc/net/tcp6']:
    try:
     for line in pathlib.Path(table).read_text().splitlines()[1:]:
      columns=line.split()
      if columns[3]=='0A' and int(columns[1].rsplit(':',1)[1],16)==cfg['webPort']:inodes.add('socket:['+columns[9]+']')
    except FileNotFoundError:pass
   pids=[]
   for process in pathlib.Path('/proc').iterdir():
    if not process.name.isdigit():continue
    try:
     if any(os.readlink(fd) in inodes for fd in (process/'fd').iterdir()):pids.append(int(process.name))
    except (FileNotFoundError,PermissionError):pass
   if not pids or any(signature(process_env(pid))!=expected for pid in pids):raise RuntimeError('Web process database settings differ from selected checkout; restart the web app and workers together')
  for spec in cfg['workers']:
   cwd=os.path.realpath(os.path.join(root,spec.get('dir','')))
   if cwd!=root and not cwd.startswith(root+'/'):raise RuntimeError('Worker directory is outside selected checkout')
   # Nested workers may reference the same canonical .env. Never create
   # alternate environment filenames or compatibility aliases.
   for name in spec.get('environmentFiles',[]):
    if name!='.env':raise RuntimeError('Worker environment file must be .env')
    target=os.path.join(cwd,name)
    if not os.path.lexists(target):
     canonical=os.path.join(root,'.env')
     if not os.path.isfile(canonical):raise RuntimeError('Selected checkout environment is missing')
     os.symlink(os.path.relpath(canonical,cwd),target)
   log=os.path.join(root,'preview-worker-'+spec['name']+'.log')
   with open(log,'ab',buffering=0) as out:
    out.write(('\n[preview] Starting '+spec['name']+' with selected checkout settings\n').encode());offset=out.tell()
    child=subprocess.Popen(['sh','-c','exec '+spec['runCmd']] if not any(x in spec['runCmd'] for x in ['=','&&',';']) else ['sh','-c',spec['runCmd']],cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=out,start_new_session=True)
   row=info(child.pid)
   if not row:raise RuntimeError('Worker exited while starting: '+spec['name'])
   row.update(name=spec['name'],root=root,log=log,offset=offset,environment=expected,readyLog=spec.get('readyLog'));state['workers'].append(row);save(state)
  deadline=time.monotonic()+cfg.get('timeout',30);since=time.monotonic()
  while True:
   pending=[]
   for row in state['workers']:
    if not alive(row):raise RuntimeError('Worker exited: '+row['name']+'; see its worker log')
    if row.get('readyLog'):
     with open(row['log'],'rb') as f:f.seek(row['offset']);text=f.read().decode(errors='replace')
     if row['readyLog'] not in text:pending.append(row['name'])
   if not pending and (not state['workers'] or time.monotonic()-since>=2):break
   if time.monotonic()>deadline:raise RuntimeError('Worker readiness timed out: '+', '.join(pending))
   time.sleep(.2)
  for row in state['workers']:
   if not environment_matches(row,expected):raise RuntimeError('Worker database settings differ from web/selected checkout: '+row['name'])
  print(json.dumps({'status':'running','workers':[{'name':r['name'],'pid':r['pid']} for r in state['workers']]}))
 elif action=='status':
  rows=[{'name':w['name'],'running':bool(alive(w)),'environmentMatches':environment_matches(w,expected)} for w in state['workers']]
  for spec in cfg['workers']:
   if not any(r['name']==spec['name'] for r in rows):rows.append({'name':spec['name'],'running':False,'environmentMatches':False})
  print(json.dumps({'healthy':all(r['running'] and r['environmentMatches'] for r in rows),'workers':rows}))
except Exception as e:
 if action=='start':terminate(read_state()['workers']);save({'workers':[]})
 print(json.dumps({'error':str(e)}));sys.exit(1)
