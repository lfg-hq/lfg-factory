import {test,expect} from 'bun:test';
import {shouldContinuePromise,continuationMessages,emptyTurnContent} from '../src/ai/turn-completion.ts';
const active={aborted:false,waitingForUser:false,closedByCard:false};
test('a promised next action continues even after inspection or an earlier write',()=>{
 expect(shouldContinuePromise('I checked the settings. I will register the missing key now.',active)).toBe(true);
 expect(shouldContinuePromise('The provider is configured. I will check the running preview.',active)).toBe(true);
});
test('answers, missing input, approval cards and cancellation never trigger a continuation',()=>{
 for(const text of ['No model has been configured.','The key is missing. Please add it in Env.','Would you like me to update the preview?']) expect(shouldContinuePromise(text,active)).toBe(false);
 for(const state of [{...active,aborted:true},{...active,waitingForUser:true},{...active,closedByCard:true}]) expect(shouldContinuePromise('I will configure the preview.',state)).toBe(false);
});
test('continuation preserves tool results instead of replaying only the promise',()=>{
 const history=[{role:'user',content:'Configure this preview'}];
 const response=[{role:'assistant',content:[{type:'tool-call',toolCallId:'one',toolName:'setEnvVar',input:{key:'PROVIDER',value:'example'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'one',toolName:'setEnvVar',output:{type:'json',value:{success:true}}}]},{role:'assistant',content:'I will verify the preview.'}];
 const result=continuationMessages(history,response,'Continue authorized work');
 expect(result).toEqual([...history,...response,{role:'user',content:'Continue authorized work'}]);
 expect(history).toHaveLength(1);
});

test('curly apostrophes in unfinished actions are recognized',()=>{
 expect(shouldContinuePromise('I’ll finish the technical analysis.',active)).toBe(true);
 expect(shouldContinuePromise('I’ll need your account ID.',active)).toBe(false);
});

test('question-only turns do not claim generation stopped',()=>{
 expect(emptyTurnContent(true,false)).toBe('');
 expect(emptyTurnContent(true,true)).toBe('*Generation stopped*');
 expect(emptyTurnContent(false,true)).toBe('*Generation stopped*');
 expect(emptyTurnContent(false,false)).toContain('No response');
});
