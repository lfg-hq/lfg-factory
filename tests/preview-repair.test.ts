import {test,expect} from 'bun:test';
import {repairDecision} from '../src/services/preview-repair.ts';
const now=Date.parse('2026-10-29T12:00:00Z');
const ago=(h:number)=>new Date(now-h*3600_000);
test('an open repair ticket suppresses another',()=>{
 expect(repairDecision([{status:'in_progress',createdAt:ago(1)}],now).kind).toBe('open');
 expect(repairDecision([{status:'open',createdAt:ago(30)}],now).kind).toBe('open');
});
test('first and second repairs start; a third within a day stops for the user',()=>{
 expect(repairDecision([],now).kind).toBe('start');
 expect(repairDecision([{status:'review',createdAt:ago(2)}],now).kind).toBe('start');
 const limited=repairDecision([{status:'review',createdAt:ago(2)},{status:'failed',createdAt:ago(1)}],now);
 expect(limited.kind).toBe('limit');
});
test('repairs older than a day no longer count',()=>{
 expect(repairDecision([{status:'review',createdAt:ago(30)},{status:'done',createdAt:ago(26)}],now).kind).toBe('start');
});
