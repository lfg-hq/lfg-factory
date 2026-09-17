import {test,expect} from 'bun:test';
import {missingPiExitReason,piTerminationScript} from '../src/services/pi-termination.ts';
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
