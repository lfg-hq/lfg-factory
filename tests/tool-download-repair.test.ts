import { test, expect } from 'bun:test';
import { repairToolDownloadUrls, SQLCMD_RELEASE } from '../src/services/tool-download-repair.ts';
import { validationStepFailure } from '../src/services/validation-step-failure.ts';
import { ValidationEnvironmentFailure } from '../src/services/validation-contract.ts';
import { executeSteps, failureSummary, type PlanStep } from '../src/services/preview-plan.ts';

test('repairs literal and shell-expanded sqlcmd aliases without changing surrounding commands', () => {
  for (const arch of ['amd64', 'arm64', '$sqlcmd_arch', '${sqlcmd_arch}']) {
    for (const suffix of ['', '.tar.bz2']) {
      const command=`if ! command -v sqlcmd; then curl -fL "https://aka.ms/sqlcmd-linux-${arch}${suffix}" -o /tmp/tool.tar.bz2 && tar -xjf /tmp/tool.tar.bz2 && sqlcmd -?; fi`;
      const fixed=repairToolDownloadUrls(command);
      expect(fixed).toBe(command.replace(`https://aka.ms/sqlcmd-linux-${arch}${suffix}`, `${SQLCMD_RELEASE}/sqlcmd-linux-${arch}.tar.bz2`));
      expect(repairToolDownloadUrls(fixed)).toBe(fixed);
    }
  }
});
test('leaves explicit versions, other tools, unknown aliases and query URLs untouched', () => {
  for (const command of ['curl https://aka.ms/dotnet-install.sh', 'curl https://aka.ms/sqlcmd-linux-amd64-extra', 'curl https://aka.ms/sqlcmd-linux-amd64?version=old', 'curl https://aka.ms/sqlcmd-linux-riscv64', 'curl https://github.com/microsoft/go-sqlcmd/releases/download/v1.7.0/sqlcmd-linux-amd64.tar.bz2']) {
    expect(repairToolDownloadUrls(command)).toBe(command);
  }
});
test('archive failure remains visible after long progress output and routes to environment repair', async () => {
  const command='if ! command -v sqlcmd; then '+ 'download-options '.repeat(100) + '; fi';
  const steps: PlanStep[]=[{id:'toolchain-0',phase:'toolchain',command,label:command,status:'pending'}, {id:'build',phase:'build',command:'build',label:'Build',status:'pending'}];
  const failed=await executeSteps(steps, {cancelled:()=>false,persist:async()=>{},run:async()=>({exitCode:1,output:' 0 0 0 download progress\n'.repeat(200)+'tar: invalid magic\ntar: short read'})});
  expect(steps[1].status).toBe('pending');
  const error=validationStepFailure(failed!,false,'candidate','evidence-id');
  expect(error).toBeInstanceOf(ValidationEnvironmentFailure);
  expect(error.message.slice(0,400)).toContain('tar: invalid magic');
  expect(error.message).toContain(command);
  expect(failureSummary(error.message)).toContain('tar: short read');
  expect((error as ValidationEnvironmentFailure).stage).toBe('candidate');
  expect(error.evidenceId).toBe('evidence-id');
});
test('schema errors stay application validation failures', () => {
  const error=validationStepFailure({id:'schema',phase:'schema',command:'migrate',label:'Migrate database',error:'Missing table',status:'failed'},true,'baseline');
  expect(error).not.toBeInstanceOf(ValidationEnvironmentFailure);
  expect(error.message).toContain('Upgrade baseline validation failed');
});

test('failure card summary retains recovery stopping reason and redacts URL credentials', () => {
 const summary=failureSummary('Environment recovery stopped: the same failure repeated without a new committed repair.\nFresh candidate environment failed: tar: invalid magic\nFailed command: curl https://user:secret@example.com/tool').split('\nFailed command:')[0];
 expect(summary).toContain('same failure repeated');expect(summary).toContain('tar: invalid magic');
 expect(summary).not.toContain('curl');
 expect(failureSummary('error: download https://user:secret@example.com/tool')).not.toContain('user:secret');
});

test('SQL Server diagnostic excludes successful row counts and preserves object and line', async () => {
 const output="Applying SQL to connection ConnectionStrings__App\n\n(2 rows affected)\n\n(9 rows affected)\n\n(7 rows affected)\nMsg 208, Level 16, State 6, Server abc, Procedure GetBenchSalesPosts, Line 2\nInvalid object name 'dbo.GetBenchSalesPosts'.";
 const summary=failureSummary(output);
 expect(summary).toStartWith('Msg 208');expect(summary).toContain("Invalid object name 'dbo.GetBenchSalesPosts'");expect(summary).not.toContain('rows affected');
 const {ValidationSchemaFailure}=await import('../src/services/validation-contract.ts');
 const error=validationStepFailure({id:'schema',phase:'schema',command:'apply scripts.sql',label:'Apply schema',error:summary,status:'failed'},false,'candidate');
 expect(error).toBeInstanceOf(ValidationSchemaFailure);expect((error as InstanceType<typeof ValidationSchemaFailure>).stage).toBe('candidate');
});
