import {test,expect} from 'bun:test';
import {PreviewRecoveryBudget} from '../src/services/preview-recovery-budget.ts';
import {failureKey} from '../src/services/preview-plan.ts';
import {readFileSync} from 'node:fs';
const failed={id:'schema-0',phase:'schema' as const,label:'migration',command:'migrate',status:'failed' as const};
test('unchanged replay failure stops, corrected recipe permits recovery',()=>{
 const budget=new PreviewRecoveryBudget();
 expect(budget.next(failureKey('recipe1',failed,'missing table'))).toBeNull();
 expect(budget.next(failureKey('recipe2',failed,'missing table'))).toBeNull();
 expect(budget.next(failureKey('recipe2',failed,'missing table'))).toContain('no persistent progress');
});
test('distinct failures share one finite budget across setup and qualification',()=>{
 const budget=new PreviewRecoveryBudget(3);
 for(const stage of ['initial','normalization','clean-migration']) expect(budget.next(stage)).toBeNull();
 expect(budget.next('final-start')).toContain('3 repair attempts');
});
test('production loop feeds qualification failure back before running warm steps',()=>{
 const source=readFileSync(new URL('../src/services/dev-preview.ts',import.meta.url),'utf8');
 const loop=source.slice(source.indexOf('const budget = new PreviewRecoveryBudget'),source.indexOf('const driverFailures'));
 expect(loop).toContain('pendingFailure ?? await executeSteps');
 expect(loop).toContain('pendingFailure = replayFailure ??');
 expect(loop).toContain('pendingFailure = {id:"repair-normalization"');
 expect(loop).toContain('const stopReason = budget.next(key)');
 expect(loop).toContain('throwIfCancelled(projectId)');
 expect(loop).toContain('finally {\n      executionDir = dir;');
 expect(loop).not.toContain('throw new Error(`Saved repair did not replay: ${invalid.label}');
});
