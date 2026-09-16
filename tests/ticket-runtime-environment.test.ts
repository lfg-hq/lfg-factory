import {test,expect} from 'bun:test';
import {runtimeRedactor} from '../src/services/ticket-runtime-environment.ts';
import {shellQuote} from '../src/services/preview-plan.ts';
test('redacts raw, shell escaped and JSON escaped configuration from progress',()=>{
 const secret="Server=localhost;Password=it's\\private";
 const redact=runtimeRedactor({ConnectionStrings__DefaultConnection:secret});
 for(const rendered of [secret,shellQuote(secret),JSON.stringify(secret).slice(1,-1)]) {
  expect(redact('command: '+rendered)).toBe('command: [redacted]');
 }
 expect(redact('SQL Client rejected ConnectionStrings__DefaultConnection')).toContain('SQL Client rejected');
});
