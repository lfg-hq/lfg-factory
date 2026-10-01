import {test,expect} from 'bun:test';
import {parseEpicTaskProgress} from '../src/services/epic-task-progress.ts';
test('only valid state updates for this ticket are accepted',()=>{
 expect(parseEpicTaskProgress(JSON.stringify([{id:'a',status:'in_progress'},{id:'other',status:'success'},{id:'b',status:'invented'}]),new Set(['a','b']))).toEqual([{id:'a',status:'in_progress'}]);
});
test('partial progress files do not erase saved task state',()=>{
 expect(parseEpicTaskProgress('[{"id":',new Set(['a']))).toEqual([]);
});
