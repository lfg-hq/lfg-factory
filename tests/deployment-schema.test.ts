import {test,expect} from 'bun:test';
import {safeSchemaPush} from '../scripts/safe-schema-push.ts';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {tokenUsage,tokenUsageRuns,tokenUsageDocuments,tokenUsageTickets} from '../src/db/schema/pg/tokens.ts';
test('deployed usage schema retains populated production tables and columns',()=>{
 expect([tokenUsageRuns,tokenUsageDocuments,tokenUsageTickets].map(t=>getTableConfig(t).name)).toEqual(['token_usage_run','token_usage_document','token_usage_ticket']);
 const columns=getTableConfig(tokenUsage).columns.map(c=>c.name);
 for(const name of ['run_id','ticket_id','operation','model_tier','billing_mode','cache_read_tokens','cache_write_tokens','reasoning_tokens'])expect(columns).toContain(name);
});
test('data-loss prompt blocks startup even when schema tool exits zero',async()=>{
 expect(await safeSchemaPush([process.execPath,'-e',"console.log('Warning Found data-loss statements:');process.exit(0)"])).toBe(1);
});
test('successful additive sync allows startup',async()=>{
 expect(await safeSchemaPush([process.execPath,'-e',"console.log('Changes applied')"])).toBe(0);
});
test('schema process failure blocks startup',async()=>{
 expect(await safeSchemaPush([process.execPath,'-e','process.exit(2)'])).toBe(2);
});
