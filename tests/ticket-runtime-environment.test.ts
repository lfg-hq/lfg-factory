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

test('preserves addresses, ports, counters and identifiers while masking credentials',()=>{
 const redact=runtimeRedactor({PORT:'5080',HOST:'127.0.0.1',FEATURE_ENABLED:'1',DB_PASSWORD:'1',API_KEY:'super-secret-value'});
 const message='Running app at http://127.0.0.1:5080; 490338 free inodes; code=1006; DB_PASSWORD=1; API_KEY=super-secret-value';
 expect(redact(message)).toBe('Running app at http://127.0.0.1:5080; 490338 free inodes; code=1006; DB_PASSWORD=[redacted]; API_KEY=[redacted]');
});
