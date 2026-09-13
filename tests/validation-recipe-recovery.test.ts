import {test,expect,mock} from 'bun:test';
import * as profileModule from '../src/services/app-profile.ts';
import * as sandboxModule from '../src/services/validation-sandbox.ts';
const profileOriginal={...profileModule}, sandboxOriginal={...sandboxModule};
let raw='', replacement:any, probes=0, knowledge:string[]=[], writes:string[]=[];
mock.module('../src/services/app-profile.ts',()=>({...profileOriginal,probeAppProfile:async(o:any)=>{probes++;knowledge=o.knowledge;return replacement;}}));
mock.module('../src/services/validation-sandbox.ts',()=>({...sandboxOriginal,validationShell:async(_:string,command:string)=>{
 if(command.includes('MISSING_CONTRACT'))return {exitCode:0,output:raw};
 writes.push(command);return {exitCode:0,output:''};
}}));
const {ensureValidationRecipe}=await import('../src/services/runtime-validation.ts');
const valid=()=>({stack:'.NET 8',runtime:'dotnet',framework:'aspnet-core',runtimeVersion:'net8.0',toolchain:[],installCmd:'dotnet restore',buildCmd:'dotnet build',startupProject:'Web',runCmd:'dotnet run',port:5000,buildQuirks:[],databases:[{engine:'mssql',connectionEnvVar:'ConnectionStrings__App',connectionFormat:'dotnet-sqlserver'}],schemaSteps:[],autoEnvVars:[],secretsRequired:[],configQuirks:[],validation:{kind:'application',tests:['dotnet test'],upgradeSetup:'dotnet run --project SeedBaseline'}});
function setup(value:any,next:any=valid()){raw=typeof value==='string'?value:JSON.stringify(value);replacement=next;probes=0;knowledge=[];writes=[];}
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
