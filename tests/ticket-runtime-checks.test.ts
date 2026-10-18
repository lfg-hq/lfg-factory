import {test,expect} from 'bun:test';
import {requiredRuntimeChecks,verifyRuntimeCoverage} from '../src/services/ticket-runtime-checks.ts';
test('explicit project policy requires real runtime categories',()=>{
 const required=requiredRuntimeChecks('','feature/example',['database','authentication','crud','persistence','tenant-isolation','hierarchy']);expect(required).toHaveLength(6);
 expect(()=>verifyRuntimeCoverage(required,{kind:'library',checks:[]})).toThrow('running application');
 expect(()=>verifyRuntimeCoverage(required,{kind:'application',checks:required.map(category=>({category,execution:'static'}))})).toThrow('Missing mandatory');
 expect(()=>verifyRuntimeCoverage(required,{kind:'application',checks:required.map(category=>({category,execution:'runtime'}))})).not.toThrow();
});

test('customer names never silently enable or disable validation policy',()=>{
 expect(requiredRuntimeChecks('COH-25 workforce organisation','feature/coh-25')).toEqual([]);
 expect(requiredRuntimeChecks('any project','feature/other',['authentication'])).toEqual(['authentication']);
});
