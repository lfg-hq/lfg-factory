"""Runs inside the ticket sandbox. JSON in/out; never evaluates file paths as shell."""
import os, sys, json, subprocess, hashlib, pathlib, tempfile, fcntl

LIMIT = 1024 * 1024

def run(req):
    root = pathlib.Path(req['root']).resolve(strict=True)
    os.chdir(root)
    def git(*args, ok=False):
        r = subprocess.run(['git', *args], capture_output=True, timeout=20)
        if r.returncode and not ok:
            raise ValueError('Git operation failed. Check the checkout and comparison branch.')
        return r.stdout
    branch = git('symbolic-ref', '--short', 'HEAD', ok=True).decode().strip()
    if req.get('branch') and branch != req['branch']:
        raise ValueError('The sandbox checkout is on a different branch. Rebuild or restore this ticket before editing.')
    def path(name):
        p = pathlib.PurePosixPath(name)
        if not name or p.is_absolute() or any(x in ('..', '.git') for x in p.parts):
            raise ValueError('Invalid repository path')
        target = root / p
        # Reject symlinks even when their destination is inside the repository.
        if any(x.is_symlink() for x in [target, *target.parents] if x != root):
            raise ValueError('Symlink files cannot be opened or edited')
        if not target.resolve().is_relative_to(root):
            raise ValueError('Path is outside the repository')
        return target
    def content(p):
        if not p.exists(): return b''
        if not p.is_file() or p.stat().st_size > LIMIT:
            raise ValueError('Only text files up to 1 MB can be opened')
        b = p.read_bytes()
        if b'\0' in b: raise ValueError('Binary files cannot be edited')
        b.decode('utf-8')
        return b
    def version(b): return hashlib.sha256(b).hexdigest()
    def baseline():
        base = req.get('base') or 'main'
        if base.startswith('-') or not all(c.isalnum() or c in '/._-' for c in base):
            raise ValueError('Invalid comparison branch')
        for ref in ('refs/remotes/origin/' + base, 'refs/heads/' + base):
            sha = git('merge-base', ref, 'HEAD', ok=True).decode().strip()
            if sha: return sha
        raise ValueError('Comparison branch is unavailable in this checkout. Fetch it using the terminal or choose another base.')
    action = req['action']
    if action == 'tree':
        base = baseline()
        files = set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''}
        changed = set(git('diff', '--name-only', '-z', base, '--').decode().split('\0')) - {''}
        changed |= set(git('ls-files', '-z', '--others', '--exclude-standard').decode().split('\0')) - {''}
        paths = sorted(files | changed)
        return dict(branch=branch, base=req.get('base') or 'main', files=[dict(path=p, changed=p in changed) for p in paths[:10000]], truncated=len(paths)>10000)
    if action == 'file':
        p = path(req['path'])
        data = content(p)
        original = git('show', baseline() + ':' + req['path'], ok=True)
        if len(original)>LIMIT or b'\0' in original: raise ValueError('Base file is binary or too large')
        return dict(content=data.decode(), original=original.decode(), version=version(data), exists=p.exists())
    if action == 'save':
        p = path(req['path'])
        data = content(p)
        if version(data) != req.get('version'): raise ValueError('File changed in the sandbox. Reopen it and reconcile your edits before saving.')
        new = req['content'].encode('utf-8')
        if len(new)>LIMIT or b'\0' in new: raise ValueError('File exceeds the text editor limit')
        if not p.exists(): raise ValueError('Deleted files are read-only. Restore them from the terminal first.')
        fd, temp = tempfile.mkstemp(dir=p.parent)
        try:
            with os.fdopen(fd, 'wb') as f: f.write(new)
            os.chmod(temp, p.stat().st_mode)
            os.replace(temp, p)
        finally:
            if os.path.exists(temp): os.unlink(temp)
        return dict(version=version(new))
    if action == 'commit':
        p = path(req['path'])
        if version(content(p)) != req.get('version'): raise ValueError('File changed since saving. Review it before committing.')
        if not req.get('message', '').strip(): raise ValueError('A commit message is required')
        # Do not scoop up other staged files or push/merge implicitly.
        git('add', '--', req['path'])
        git('-c', 'user.name=' + req['author'], '-c', 'user.email=' + req['email'], 'commit', '--only', '-m', req['message'], '--', req['path'])
        return dict(sha=git('rev-parse', 'HEAD').decode().strip())
    raise ValueError('Unknown action')

if __name__ == '__main__':
    try:
        req=json.loads(sys.argv[1])
        # Serialize browser edits/commits across tabs and application processes.
        with open('/tmp/lfg-code-' + hashlib.sha256(req['root'].encode()).hexdigest() + '.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result=run(req)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
