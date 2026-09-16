import {test, expect} from 'bun:test';
import {upgradeServiceConflicts} from '../src/services/upgrade-service-compatibility.ts';
const main = {engine:'mssql' as const, connectionEnvVar:'MAIN', connectionFormat:'dotnet-sqlserver' as const};
const workforce = {...main, connectionEnvVar:'WORKFORCE', databaseName:'workforce'};
test('upgrade accepts reordering, explicit default names and additive databases', () => {
 expect(upgradeServiceConflicts([main, workforce], [workforce, {...main,databaseName:'app'}])).toEqual([]);
 expect(upgradeServiceConflicts([main], [main, workforce])).toEqual([]);
});
test('upgrade blocks deleted or retargeted connections with actionable differences', () => {
 expect(upgradeServiceConflicts([main, workforce], [main])[0]).toContain('WORKFORCE: baseline requires mssql/workforce');
 expect(upgradeServiceConflicts([main], [{...main,databaseName:'other'}])[0]).toContain('candidate provides mssql/other');
 expect(upgradeServiceConflicts([main], [{...main,engine:'postgres',connectionFormat:'url'}])).toHaveLength(1);
 expect(upgradeServiceConflicts([main], [{...main,connectionFormat:'url'}])).toHaveLength(1);
});
test('duplicate connection keys cannot silently select a target', () => {
 expect(upgradeServiceConflicts([main], [main,main])[0]).toContain('candidate has duplicate');
});
