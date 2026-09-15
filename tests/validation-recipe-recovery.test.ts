import {test,expect,mock} from 'bun:test';
import * as profileModule from '../src/services/app-profile.ts';
import * as sandboxModule from '../src/services/validation-sandbox.ts';
const profileOriginal={...profileModule}, sandboxOriginal={...sandboxModule};
let raw='', replacement:any, probes=0, knowledge:string[]=[], writes:string[]=[], writeExit=0;
mock.module('../src/services/app-profile.ts',()=>({...profileOriginal,probeAppProfile:async(o:any)=>{probes++;knowledge=o.knowledge;return replacement;}}));
mock.module('../src/services/validation-sandbox.ts',()=>({...sandboxOriginal,validationShell:async(_:string,command:string)=>{
 if(command.includes('MISSING_CONTRACT'))return {exitCode:0,output:raw};
 writes.push(command);return {exitCode:writeExit,output:''};
}}));
const {ensureValidationRecipe}=await import('../src/services/runtime-validation.ts');
const valid=()=>({stack:'.NET 8',runtime:'dotnet',framework:'aspnet-core',runtimeVersion:'net8.0',toolchain:[],installCmd:'dotnet restore',buildCmd:'dotnet build',startupProject:'Web',runCmd:'dotnet run',port:5000,buildQuirks:[],databases:[{engine:'mssql',connectionEnvVar:'ConnectionStrings__App',connectionFormat:'dotnet-sqlserver'}],schemaSteps:[],autoEnvVars:[],secretsRequired:[],configQuirks:[],validation:{kind:'application',tests:['dotnet test'],upgradeSetup:'dotnet run --project SeedBaseline'}});
function setup(value:any,next:any=valid()){raw=typeof value==='string'?value:JSON.stringify(value);replacement=next;probes=0;knowledge=[];writes=[];writeExit=0;}
const run=()=>ensureValidationRecipe('vm','/data/project',{projectId:'p',userId:'u'});
test('invalid engine is repaired through structured probe before saving',async()=>{
 const old=valid();old.databases[0].engine='SQL Server';setup(old);
 const result=await run();expect(result.databases[0].engine).toBe('mssql');expect(probes).toBe(1);expect(writes.length).toBe(1);
 expect(knowledge.join('\n')).toContain('databases');expect(knowledge.join('\n')).toContain('Preserve existing real tests');
});
test('invalid replacement does not overwrite original recipe',async()=>{
 setup('{}',{...valid(),databases:[{engine:'sqlite'}]});
 await expect(run()).rejects.toThrow();expect(writes).toEqual([]);
});
test('malformed JSON is repaired rather than handed back to general coding agent',async()=>{
 setup('{broken');await run();expect(probes).toBe(1);expect(writes.length).toBe(1);
});
test('valid recipe is reused without probing or writing',async()=>{
 setup(valid());await run();expect(probes).toBe(0);expect(writes).toEqual([]);
});
test('probe output with placeholder tests still fails validation',async()=>{
 setup('{}',{...valid(),validation:{kind:'application',tests:['true'],upgradeSetup:'dotnet run --project SeedBaseline'}});
 await expect(run()).rejects.toThrow('Placeholder');expect(writes).toEqual([]);
});
test('failed probe leaves existing recipe untouched',async()=>{
 setup('{}',null);await expect(run()).rejects.toThrow('Probe did not produce');expect(writes).toEqual([]);
});

test('existing bad download is corrected and persisted without reprobe or loss of schema/tests',async()=>{
 const old={...valid(),toolchain:['curl -fL "https://aka.ms/sqlcmd-linux-${sqlcmd_arch}" -o tool.tar.bz2 && tar -xjf tool.tar.bz2']};setup(old);
 const result=await run();expect(probes).toBe(0);expect(writes.length).toBe(1);
 expect(result.toolchain[0]).toContain('/v1.10.0/sqlcmd-linux-${sqlcmd_arch}.tar.bz2');
 const payload=writes[0].match(/echo ([A-Za-z0-9+/=]+) \| base64/)!;
 const saved=JSON.parse(Buffer.from(payload[1],'base64').toString());
 expect(saved.toolchain).toEqual(result.toolchain);expect(saved.databases[0].engine).toBe('mssql');
 expect(saved.validation).toMatchObject(old.validation);
 setup(saved);await run();expect(writes.length).toBe(0);expect(probes).toBe(0);
});
test('new probe recipe also corrects the known alias before first save',async()=>{
 setup('MISSING_CONTRACT',{...valid(),toolchain:['curl https://aka.ms/sqlcmd-linux-amd64']});
 const result=await run();expect(result.toolchain[0]).toContain('/v1.10.0/');expect(writes.length).toBe(1);
 expect(knowledge.join('\n')).toContain('archive integrity');
});
test('baseline recipe receives the same download correction without changing its tests',async()=>{
 setup({...valid(),installCmd:'curl https://aka.ms/sqlcmd-linux-arm64.tar.bz2'});
 const result=await ensureValidationRecipe('vm','/data/baseline',{projectId:'p',userId:'u'},true);
 expect(result.installCmd).toContain('/v1.10.0/sqlcmd-linux-arm64.tar.bz2');expect(writes.length).toBe(1);
});

test('failure to persist a download correction stops validation instead of reprobe or false success',async()=>{
 setup({...valid(),toolchain:['curl https://aka.ms/sqlcmd-linux-amd64']});writeExit=1;
 await expect(run()).rejects.toThrow('Could not save runtime recipe');expect(probes).toBe(0);
});
