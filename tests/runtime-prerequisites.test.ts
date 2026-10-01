import {test,expect} from 'bun:test';
import {runtimePrerequisiteSchema} from '../src/services/runtime-prerequisites.ts';
test('prerequisites support arbitrary tools and services without a fixed technology list',()=>{
 for(const name of ['compiler','media library','search service','custom project tool']) {
  expect(runtimePrerequisiteSchema.parse({name,reason:'Required by this feature',verificationCommand:'./scripts/check-capability'}).timeoutSeconds).toBe(30);
 }
});
test('verification commands must be present and bounded',()=>{
 for(const timeoutSeconds of [0,301])expect(runtimePrerequisiteSchema.safeParse({name:'runtime',reason:'build',verificationCommand:'runtime --version',timeoutSeconds}).success).toBe(false);
 expect(runtimePrerequisiteSchema.safeParse({name:'runtime',reason:'build',verificationCommand:''}).success).toBe(false);
});
