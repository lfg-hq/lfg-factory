"""Linux process lifecycle integration test; uses only disposable fixture workers."""
import unittest,tempfile,pathlib,subprocess,json,base64,os,time,signal,sys
supervisor=pathlib.Path(sys.argv.pop()).read_text()
class Lifecycle(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='preview-workers-test-');self.base=pathlib.Path(self.temp.name);self.root=self.base/'branch';self.root.mkdir();self.state=self.base/'state.json'
  (self.root/'.env').write_text("DATABASE_URL='postgres://example/branch-a'\n")
  (self.root/'worker.py').write_text("import os,time\nprint('READY',flush=True)\nwhile True:time.sleep(.1)\n")
  self.worker={'name':'queue','runCmd':'python3 worker.py','entrypoint':'worker.py','readyLog':'READY'}
 def run_tool(self,action,root=None,workers=None,check=True,**kw):
  cfg={'action':action,'dir':str(root or self.root),'workers':workers if workers is not None else [self.worker],'databaseKeys':['DATABASE_URL'],'stateFile':str(self.state),'timeout':3,**kw}
  r=subprocess.run(['python3','-c',supervisor,base64.b64encode(json.dumps(cfg).encode()).decode()],capture_output=True,text=True)
  if check:self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  return r,json.loads(r.stdout)
 def tearDown(self):self.run_tool('stop',check=False);self.temp.cleanup()
 def test_restart_switch_stop_and_env_change(self):
  _,first=self.run_tool('start');pid=first['workers'][0]['pid']
  self.assertTrue(self.run_tool('status')[1]['healthy'])
  (self.root/'.env').write_text("DATABASE_URL='postgres://example/branch-b'\n")
  self.assertFalse(self.run_tool('status')[1]['healthy'])
  _,next=self.run_tool('start');self.assertNotEqual(pid,next['workers'][0]['pid']);self.assertTrue(self.run_tool('status')[1]['healthy'])
  env=pathlib.Path('/proc',str(next['workers'][0]['pid']),'environ').read_bytes();self.assertIn(b'postgres://example/branch-b',env)
  other=self.base/'other-branch';other.mkdir();(other/'.env').write_text("DATABASE_URL='postgres://example/other'\n");(other/'worker.py').write_text((self.root/'worker.py').read_text())
  self.run_tool('start',root=other);self.assertEqual(json.loads(self.state.read_text())['root'],str(other))
  self.run_tool('stop',root=other);self.assertEqual(json.loads(self.state.read_text())['workers'],[])
 def test_startup_failure_and_wrong_database_override_fail(self):
  r,_=self.run_tool('start',workers=[{**self.worker,'runCmd':'exit 7'}],check=False);self.assertNotEqual(r.returncode,0);self.assertEqual(json.loads(self.state.read_text())['workers'],[])
  r,out=self.run_tool('start',workers=[{**self.worker,'runCmd':'DATABASE_URL=wrong python3 worker.py'}],check=False);self.assertNotEqual(r.returncode,0);self.assertIn('database settings differ',out['error'])
 def test_only_canonical_environment_file_is_seeded(self):
  spec={**self.worker,'environmentFiles':['.env.local']}
  r,out=self.run_tool('start',workers=[spec],check=False)
  self.assertNotEqual(r.returncode,0);self.assertIn('noncanonical environment file',out['error'])
  local=self.root/'.env.local';self.assertFalse(local.exists());self.assertFalse(local.is_symlink())
  local.write_text('EXISTING_LOCAL_SETTING=preserve\n')
  r,_=self.run_tool('start',workers=[spec],check=False)
  self.assertNotEqual(r.returncode,0);self.assertEqual(local.read_text(),'EXISTING_LOCAL_SETTING=preserve\n')
  canonical={**self.worker,'environmentFiles':['.env']}
  self.run_tool('start',workers=[canonical]);self.assertTrue(self.run_tool('status',workers=[canonical])[1]['healthy'])
 def test_cleanup_scratch_without_touching_unrelated(self):
  scratch=self.base/'preview-check-fixture';scratch.mkdir();(scratch/'worker.py').write_text((self.root/'worker.py').read_text());(scratch/'.env').write_text((self.root/'.env').read_text())
  outsider=subprocess.Popen(['sleep','60'],start_new_session=True)
  try:
   _,result=self.run_tool('start',root=scratch);self.run_tool('cleanup',root=scratch)
   self.assertIsNone(outsider.poll());self.assertEqual(json.loads(self.state.read_text())['workers'],[])
  finally:outsider.terminate();outsider.wait()
 def test_web_database_mismatch_is_rejected(self):
  # A real listener whose process env deliberately differs from the selected DB.
  listener=subprocess.Popen(['python3','-u','-c',"import socket,time; s=socket.socket();s.bind(('127.0.0.1',0));s.listen();print(s.getsockname()[1],flush=True);time.sleep(60)"],stdout=subprocess.PIPE,env={**os.environ,'DATABASE_URL':'postgres://other'},text=True,start_new_session=True)
  try:
   port=int(listener.stdout.readline());r,out=self.run_tool('start',webPort=port,check=False);self.assertNotEqual(r.returncode,0);self.assertIn('Web process database settings differ',out['error'])
  finally:listener.terminate();listener.wait();listener.stdout.close()
if __name__=='__main__':unittest.main()
