"""Private recovery archive: Git history/index and tracked + non-ignored files.
Ignored dependencies/configuration come from the prepared environment, not this archive.
"""
import os, sys, json, pathlib, subprocess, tempfile, tarfile, hashlib, io, shutil
LIMIT = 64 * 1024 * 1024

def git(root, *args, input=None):
    r = subprocess.run(['git', '-C', str(root), *args], input=input, capture_output=True)
    if r.returncode: raise ValueError('Checkpoint Git operation failed: ' + args[0])
    return r.stdout

def pack(root, archive):
    root = pathlib.Path(root).resolve(strict=True)
    branch = git(root, 'symbolic-ref', '--short', 'HEAD').decode().strip()
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    index = pathlib.Path(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index').decode().strip())
    names = sorted(set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''})
    def fingerprint():
        digest = hashlib.sha256(index.read_bytes())
        digest.update(git(root, 'rev-parse', 'HEAD'))
        current = sorted(set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''})
        for name in current:
            digest.update(name.encode()); p = root / name
            if any(x.is_symlink() for x in p.parents if x != root): raise ValueError('Checkpoint path crosses a symlink')
            if p.is_symlink(): digest.update(os.readlink(p).encode())
            elif p.is_file():
                if p.stat().st_size > LIMIT: raise ValueError('Workspace checkpoint exceeds 64 MB; sandbox remains awake')
                digest.update(p.read_bytes()); digest.update(str(p.stat().st_mode).encode())
            elif p.exists(): raise ValueError('Submodules require a separate checkpoint; sandbox remains awake')
            else: digest.update(b'deleted')
        return digest.digest()
    tree = git(root, 'write-tree').decode().strip()
    before = fingerprint()
    ref = 'refs/lfg-checkpoints/' + os.path.basename(archive)
    with tempfile.TemporaryDirectory() as tmp:
        bundle = pathlib.Path(tmp) / 'repo.bundle'
        # Include staged blobs, including ones that have never been committed.
        staged = git(root, '-c', 'user.name=LFG', '-c', 'user.email=checkpoint@lfg.dev', 'commit-tree', tree, '-p', head, input=b'Private workspace checkpoint\n').decode().strip()
        git(root, 'update-ref', ref, staged)
        try: git(root, 'bundle', 'create', str(bundle), '--all', 'HEAD')
        finally: git(root, 'update-ref', '-d', ref)
        total = bundle.stat().st_size
        if total > LIMIT: raise ValueError('Workspace checkpoint exceeds 64 MB; sandbox remains awake')
        with tarfile.open(archive, 'w:gz', dereference=False) as tar:
            tar.add(bundle, arcname='repo.bundle')
            tar.add(index, arcname='index')
            meta = json.dumps(dict(branch=branch, head=head, names=names)).encode()
            info = tarfile.TarInfo('meta.json'); info.size = len(meta); tar.addfile(info, io.BytesIO(meta))
            for name in names:
                p = root / name
                if not p.exists() and not p.is_symlink(): continue
                if any(x.is_symlink() for x in p.parents if x != root): raise ValueError('Checkpoint path crosses a symlink')
                if p.is_dir(): raise ValueError('Submodules require a separate checkpoint; sandbox remains awake')
                total += p.lstat().st_size
                if total > LIMIT: raise ValueError('Workspace checkpoint exceeds 64 MB; sandbox remains awake')
                tar.add(p, arcname='files/' + name, recursive=False)
    if before != fingerprint(): raise ValueError('Workspace changed during checkpointing; retry before allowing it to sleep')
    size = os.path.getsize(archive)
    if size > LIMIT: raise ValueError('Workspace checkpoint exceeds 64 MB; sandbox remains awake')
    return dict(branch=branch, head=head, size=size, sha256=hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest())

def unpack(archive, root, branch):
    # Restore only into a NEW directory. The caller swaps this into a new sandbox.
    root = pathlib.Path(root).resolve()
    if root.exists(): raise ValueError('Refusing to overwrite an existing checkout')
    with tempfile.TemporaryDirectory() as tmp, tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        if sum(m.size for m in members) > LIMIT: raise ValueError('Checkpoint exceeds size limit')
        for m in members:
            p = pathlib.PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or '.git' in p.parts or m.islnk() or not (m.isfile() or m.issym()):
                raise ValueError('Invalid checkpoint path')
        meta = json.load(tar.extractfile('meta.json'))
        if meta['branch'] != branch: raise ValueError('Checkpoint belongs to a different ticket branch')
        bundle = pathlib.Path(tmp) / 'repo.bundle'
        bundle.write_bytes(tar.extractfile('repo.bundle').read())
        subprocess.run(['git', 'clone', '--no-checkout', str(bundle), str(root)], check=True, capture_output=True)
        git(root, 'check-ref-format', '--branch', branch)
        git(root, 'checkout', '-B', branch, meta['head'])
        git(root, 'remote', 'remove', 'origin')
        # Restore comparison refs from the bundle, including remote-only bases.
        git(root, 'fetch', str(bundle), '+refs/remotes/origin/*:refs/remotes/origin/*')
        for name in git(root, 'ls-files', '-z').decode().split('\0'):
            if name:
                p = root / name
                if p.is_file() or p.is_symlink(): p.unlink()
        for m in members:
            if not m.name.startswith('files/'): continue
            p = root / m.name[6:]
            if any(x.is_symlink() for x in p.parents): raise ValueError('Checkpoint path crosses a symlink')
            p.parent.mkdir(parents=True, exist_ok=True)
            if m.issym():
                target = (p.parent / m.linkname).resolve()
                if not target.is_relative_to(root.resolve()): raise ValueError('Checkpoint symlink escapes checkout')
                p.symlink_to(m.linkname)
            else:
                p.write_bytes(tar.extractfile(m).read()); p.chmod(m.mode & 0o777)
        (root / '.git/index').write_bytes(tar.extractfile('index').read())
        return meta

if __name__ == '__main__':
    try:
        req = json.loads(sys.argv[1])
        print(json.dumps(pack(req['root'], req['archive']) if req['action'] == 'pack' else unpack(req['archive'], req['root'], req['branch'])))
    except Exception as e:
        print(json.dumps({'error': str(e)})); sys.exit(1)
