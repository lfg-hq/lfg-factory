import importlib.util, pathlib, tempfile, subprocess, unittest, os
spec=importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).resolve().parents[1]/'src/services/ticket-code-worker.py')
worker=importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
class TicketCodeTests(unittest.TestCase):
    def setUp(self):
        self.cwd=os.getcwd(); self.tmp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.tmp.name)
        self.git('init','-b','main'); self.git('config','user.name','Test');self.git('config','user.email','test@example.com')
        (self.root/'app.ts').write_text('export const count = 1;\n'); (self.root/'other.ts').write_text('original\n');self.git('add','.');self.git('commit','-m','base');self.git('checkout','-b','feature/ticket')
        (self.root/'app.ts').write_text('export const count = 2;\n');self.git('commit','-am','ticket')
    def tearDown(self): os.chdir(self.cwd);self.tmp.cleanup()
    def git(self,*args): return subprocess.check_output(['git','-C',str(self.root),*args],stderr=subprocess.DEVNULL).decode()
    def call(self,action,**args): return worker.run(dict(root=str(self.root),branch='feature/ticket',action=action,base='main',**args))
    def test_diff_includes_commits_and_untracked(self):
        (self.root/'new.ts').write_text('new\n')
        tree=self.call('tree');self.assertEqual({x['path'] for x in tree['files'] if x['changed']},{'app.ts','new.ts'})
        data=self.call('file',path='app.ts');self.assertIn('= 1',data['original']);self.assertIn('= 2',data['content'])
    def test_save_and_file_only_commit(self):
        data=self.call('file',path='app.ts');saved=self.call('save',path='app.ts',version=data['version'],content='updated\n')
        (self.root/'other.ts').write_text('unrelated\n');self.git('add','other.ts')
        committed=self.call('commit',path='app.ts',version=saved['version'],message='Reviewed edit',author='Editor',email='edit@example.com')
        self.assertEqual(len(committed['sha']),40);self.assertEqual(self.git('diff-tree','--no-commit-id','--name-only','-r','HEAD').strip(),'app.ts');self.assertIn('other.ts',self.git('diff','--cached','--name-only'))
    def test_stale_save_does_not_overwrite(self):
        data=self.call('file',path='app.ts');(self.root/'app.ts').write_text('agent edit\n')
        with self.assertRaisesRegex(ValueError,'changed'): self.call('save',path='app.ts',version=data['version'],content='overwrite')
        self.assertEqual((self.root/'app.ts').read_text(),'agent edit\n')
    def test_paths_binary_and_wrong_branch(self):
        (self.root/'link').symlink_to(self.root/'app.ts');(self.root/'image').write_bytes(b'a\0b')
        for name in ['../outside','/etc/passwd','.git/config','link','image']:
            with self.assertRaises(ValueError):self.call('file',path=name)
        with self.assertRaisesRegex(ValueError,'different branch'):worker.run(dict(root=str(self.root),branch='wrong',action='tree'))
    def test_deleted_file_and_unavailable_base(self):
        (self.root/'app.ts').unlink();self.assertFalse(self.call('file',path='app.ts')['exists'])
        with self.assertRaisesRegex(ValueError,'unavailable'):worker.run(dict(root=str(self.root),branch='feature/ticket',base='missing',action='tree'))
if __name__=='__main__': unittest.main()
