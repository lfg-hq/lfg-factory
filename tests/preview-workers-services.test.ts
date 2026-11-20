import { describe, test, expect } from 'bun:test';
import { workersNotRunAsServices } from '../src/services/preview-workers.ts';

const worker = { name: 'worker', runCmd: 'npm run worker', environmentFiles: [] };
describe('workersNotRunAsServices', () => {
  test('drops a worker an enabled companion app already runs', () => {
    expect(workersNotRunAsServices([worker], [{ runCmd: 'npm run dev', primary: true }, { runCmd: 'npm  run worker', enabled: true }])).toEqual([]);
  });
  test('keeps it when that companion is turned off', () => {
    expect(workersNotRunAsServices([worker], [{ runCmd: 'npm run worker', enabled: false }])).toEqual([worker]);
  });
  test('keeps workers with no matching app', () => {
    expect(workersNotRunAsServices([worker], undefined)).toEqual([worker]);
  });
});
