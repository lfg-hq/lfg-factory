import {test,expect} from 'bun:test';
import {missingPiExitReason,piTerminationScript} from '../src/services/pi-termination.ts';
import {spawnSync} from 'node:child_process';
test('old dotnet OOM history does not identify Pi as OOM killed',()=>{
 const reason=missingPiExitReason(false,'Out of memory: Killed process 123 (dotnet)');
 expect(reason).toContain('cause is unconfirmed');expect(reason).not.toContain('Pi process was OOM-killed');
});
test('deadline takes precedence over historical OOM entries',()=>{
 expect(missingPiExitReason(true,'Killed process 123 (dotnet)')).toContain('exceeded its time limit');
});
test('termination rejects unsafe launcher identities',()=>{
 for(const pid of ['0','1','-1','1; kill -1',''])expect(()=>piTerminationScript(pid)).toThrow();
});
test('cleanup includes orphaned tools from the launcher group and excludes unrelated workers',()=>{
 const script=piTerminationScript('100').split("<<'PY'\n")[1]!.replace(/\nPY$/,'');
 const fixture=`import builtins,io,json
records_fixture={201:(1,100),202:(201,202),301:(1,301)}
states={pid:'S' for pid in records_fixture}; killed=[]
def fake_open(path,*args,**kwargs):
 pid=int(path.split('/')[2]); parent,group=records_fixture[pid]
 fields=['0']*20; fields[0]=states[pid];fields[1]=str(parent);fields[2]=str(group);fields[19]=str(pid+1000)
 return io.StringIO(str(pid)+' (tool) '+' '.join(fields))
builtins.open=fake_open
os.listdir=lambda path:[str(pid) for pid in records_fixture]
def fake_kill(pid,sig):
 killed.append(pid);states[pid]='Z'
os.kill=fake_kill;time.sleep=lambda _:None
`;
 const source=script.replace('root=int(sys.argv[1]); records={}',fixture+'\nroot=100; records={}')+'\nassert set(killed)=={201,202},killed\n';
 const result=spawnSync('python3',['-c',source],{encoding:'utf8'});
 expect(result.status).toBe(0);
});
