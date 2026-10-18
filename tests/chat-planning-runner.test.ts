import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {parseArgs,answerFor,scrub,captureEvent} from '../scripts/chat-planning-test.mjs';
const scenario=JSON.parse(readFileSync('scripts/scenarios/recruiting-planning.json','utf8'));
test('runner requires explicit, well-formed command options',()=>{
 expect(parseArgs(['--base-url','http://localhost:3000','--project','test'])).toEqual({'base-url':'http://localhost:3000',project:'test'});
 expect(()=>parseArgs(['--base-url'])).toThrow();
 expect(()=>parseArgs(['--yes'])).toThrow();
});
test('known recruiting choices can be answered but unknown decisions require review',()=>{
 expect(answerFor('Which languages?',scenario)).toContain('English');
 expect(answerFor('Which telephony provider?',scenario)).toContain('Exotel');
 expect(answerFor('Which database hosting region?',scenario)).toBeUndefined();
 expect(scenario.turns.at(-2)).toContain('Do not execute or schedule them');
});
test('capture keeps user-visible activity but excludes credentials and hidden provider fields',()=>{
 expect(captureEvent({type:'heartbeat',token:'secret'})).toBeNull();
 expect(captureEvent({type:'ai_chunk',detail:'Loaded skill: product-planning',authorization:'secret',reasoning:'private'})).toEqual({type:'ai_chunk',detail:'Loaded skill: product-planning'});
 expect(scrub('key sk-'+ 'a'.repeat(24))).not.toContain('a'.repeat(24));
 expect(captureEvent({type:'ai_chunk',is_final:true,end_reason:'error',error_message:'Failed'}).error_message).toBe('Failed');
});
