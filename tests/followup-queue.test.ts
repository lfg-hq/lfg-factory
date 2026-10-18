import {test,expect} from 'bun:test';
import {FollowupQueue} from '../src/ws/followup-queue.ts';
const request=(id:string)=>({type:'message' as const,client_message_id:id,message:id,files:[{id:'file-'+id,name:'spec.docx'}]});
test('follow-ups retain order and attachments; duplicate submissions are not repeated',()=>{
 const queue=new FollowupQueue();queue.add(request('a'));queue.add(request('b'));queue.add(request('a'));
 expect(queue.snapshot().map(x=>x.id)).toEqual(['a','b']);
 expect(queue.next()?.request.files?.[0]?.id).toBe('file-a');expect(queue.next()?.id).toBe('b');expect(queue.next()).toBeUndefined();
});
test('steering prioritizes the chosen message without losing other follow-ups; removal cancels queued work',()=>{
 const queue=new FollowupQueue();for(const id of ['a','b','c'])queue.add(request(id));
 expect(queue.steer('missing')).toBe(false);expect(queue.steer('c')).toBe(true);
 queue.remove('b');expect(queue.next()?.id).toBe('c');expect(queue.next()?.id).toBe('a');expect(queue.next()).toBeUndefined();
});
test('bounded queue rejects overflow without losing existing messages',()=>{
 const queue=new FollowupQueue();for(let i=0;i<10;i++)queue.add(request(String(i)));
 expect(()=>queue.add(request('overflow'))).toThrow('queue is full');expect(queue.snapshot()).toHaveLength(10);
});
