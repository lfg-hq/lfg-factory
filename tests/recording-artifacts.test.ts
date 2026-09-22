import {test,expect} from 'bun:test';
import {writeFile,stat,rm} from 'node:fs/promises';
import {RecordingArtifacts} from '../src/services/recording-artifacts.ts';
test('uploads failure evidence before terminal status and removes only temporary files',async()=>{
 const objects=new Map<string,Buffer>();const order:string[]=[];
 const a=await RecordingArtifacts.create('test',{put:async(k,b)=>{objects.set(k,b);order.push(k)}});
 await writeFile(a.dir+'/recording.mp4','video');await writeFile(a.dir+'/failure.jpg','image');
 await a.finish('failed','Expected value missing');
 expect(order.at(-1)).toEndWith('/status.json');
 expect(objects.size).toBe(3);
 expect(JSON.parse(objects.get(order.at(-1)!)!.toString()).status).toBe('failed');
 expect(await stat(a.dir).then(()=>true).catch(()=>false)).toBe(false);
});
test('failed upload never deletes the only copy or claims success',async()=>{
 let fail=false;const objects=new Map<string,Buffer>();
 const a=await RecordingArtifacts.create('test',{put:async(k,b)=>{if(fail && k.endsWith('.mp4'))throw Error('offline');objects.set(k,b)}});
 await writeFile(a.dir+'/recording.mp4','video');fail=true;
 await expect(a.finish('passed','done')).rejects.toThrow('Recording upload failed');
 expect((await stat(a.dir+'/recording.mp4')).size).toBe(5);
 expect(JSON.parse([...objects.values()][0]!.toString()).status).toBe('failed');
 fail=false;await a.finish('failed','upload retried');
});
