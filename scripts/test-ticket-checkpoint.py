import importlib.util, pathlib, tempfile, subprocess, unittest, os
spec=importlib.util.spec_from_file_location('checkpoint',pathlib.Path(__file__).resolve().parents[1]/'src/services/ticket-workspace-checkpoint.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
class CheckpointTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.base=pathlib.Path(self.tmp.name).resolve();self.root=self.base/'source';self.root.mkdir()
  self.git('init','-b','main');self.git('config','user.name','Test');self.git('config','user.email','test@lfg.dev')
  (self.root/'file').write_text('base');(self.root/'deleted').write_text('base');(self.root/'.gitignore').write_text('ignored\n')
  self.git('add','.');self.git('commit','-m','base');self.git('update-ref','refs/remotes/origin/main','HEAD');self.git('checkout','-b','feature/ticket')
 def tearDown(self):self.tmp.cleanup()
 def git(self,*args,root=None):return subprocess.check_output(['git','-C',str(root or self.root),*args],stderr=subprocess.DEVNULL)
 def test_complete_roundtrip_without_touching_source(self):
  (self.root/'file').write_text('local commit');self.git('commit','-am','local only')
  (self.root/'file').write_text('staged');self.git('add','file');(self.root/'file').write_text('unstaged')
  (self.root/'deleted').unlink();(self.root/'new').write_bytes(b'untracked\x00binary');(self.root/'ignored').write_text('secret')
  before=self.git('status','--porcelain=v1');head=self.git('rev-parse','HEAD')
  archive=self.base/'checkpoint';worker.pack(self.root,str(archive));target=self.base/'restored';worker.unpack(str(archive),str(target),'feature/ticket')
  self.assertEqual(self.git('status','--porcelain=v1'),before);self.assertEqual(self.git('status','--porcelain=v1',root=target),before)
  self.assertEqual(self.git('rev-parse','HEAD',root=target),head);self.assertEqual(self.git('show',':file',root=target),b'staged')
  self.assertEqual((target/'file').read_text(),'unstaged');self.assertFalse((target/'deleted').exists());self.assertFalse((target/'ignored').exists())
  self.assertEqual((target/'new').read_bytes(),b'untracked\x00binary');self.git('merge-base','origin/main','HEAD',root=target)
 def test_wrong_branch_and_existing_directory_rejected(self):
  archive=self.base/'checkpoint';worker.pack(self.root,str(archive))
  with self.assertRaisesRegex(ValueError,'different ticket'):worker.unpack(str(archive),str(self.base/'new'),'other')
  with self.assertRaisesRegex(ValueError,'overwrite'):worker.unpack(str(archive),str(self.root),'feature/ticket')
 def test_size_failure(self):
  archive=self.base/'checkpoint';old=worker.LIMIT;worker.LIMIT=1
  try:
   with self.assertRaisesRegex(ValueError,'64 MB'):worker.pack(self.root,str(archive))
  finally:worker.LIMIT=old
  self.assertEqual(self.git('for-each-ref','refs/lfg-checkpoints'),b'')
if __name__=='__main__':unittest.main()
