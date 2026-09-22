import {test,expect} from 'bun:test';
process.env.BETTER_AUTH_SECRET ??= 'runtime-test-secret';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
const {env}=await import('../src/config/env.ts');
const {encryptSecret,decryptSecret}=await import('../src/utils/crypto.ts');
import {decodeRuntimeValue} from '../src/services/ticket-runtime-environment.ts';

test('runtime decodes a real AES-GCM connection value with the preview decoder',()=>{
 const original=env.ENCRYPTION_KEY;
 try {
  env.ENCRYPTION_KEY='runtime-test-key-not-a-production-key';
  const value='Server=127.0.0.1;Database=Preview;Password=test-only;';
  const stored=encryptSecret(value);
  expect(stored.startsWith('gcm:')).toBe(true);
  expect(decodeRuntimeValue('ConnectionStrings__DefaultConnection',stored,decryptSecret)).toBe(value);
  env.ENCRYPTION_KEY='different-test-key';
  expect(()=>decodeRuntimeValue('ConnectionStrings__DefaultConnection',stored,decryptSecret)).toThrow('Cannot decrypt project variable ConnectionStrings__DefaultConnection');
 } finally {env.ENCRYPTION_KEY=original;}
});
test('runtime errors expose the key name without leaking the stored value',()=>{
 const stored='gcm:private-value';
 try {decodeRuntimeValue('DB',stored,decryptSecret);throw new Error('unexpected success');}
 catch(error) {expect((error as Error).message).toContain('Cannot decrypt project variable DB');expect((error as Error).message).not.toContain(stored);}
});
