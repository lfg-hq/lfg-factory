import {test,expect} from 'bun:test';
import {requiredRuntimeChecks,verifyRuntimeCoverage} from '../src/services/ticket-runtime-checks.ts';
test('CoHire workforce requires real runtime categories',()=>{
 const required=requiredRuntimeChecks('','feature/coh-25-workforce-organisation');expect(required).toHaveLength(6);
 expect(()=>verifyRuntimeCoverage(required,{kind:'library',checks:[]})).toThrow('running application');
 expect(()=>verifyRuntimeCoverage(required,{kind:'application',checks:required.map(category=>({category,execution:'static'}))})).toThrow('Missing mandatory');
 expect(()=>verifyRuntimeCoverage(required,{kind:'application',checks:required.map(category=>({category,execution:'runtime'}))})).not.toThrow();
});
