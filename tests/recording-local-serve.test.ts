import {test,expect} from 'bun:test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {serveLocalRecording} from '../src/services/recording-local-serve.ts';
test('serves local recordings with byte ranges so video can seek without S3',async()=>{
 const dir=await mkdtemp(tmpdir()+'/rec-');await writeFile(dir+'/recording.mp4','0123456789');
 const full=await serveLocalRecording(dir+'/recording.mp4',new Request('http://x/'));
 expect(full.status).toBe(200);expect(full.headers.get('Content-Type')).toBe('video/mp4');expect(await full.text()).toBe('0123456789');
 const part=await serveLocalRecording(dir+'/recording.mp4',new Request('http://x/',{headers:{Range:'bytes=2-5'}}));
 expect(part.status).toBe(206);expect(part.headers.get('Content-Range')).toBe('bytes 2-5/10');expect(await part.text()).toBe('2345');
 const tail=await serveLocalRecording(dir+'/recording.mp4',new Request('http://x/',{headers:{Range:'bytes=-3'}}));
 expect(await tail.text()).toBe('789');
 expect((await serveLocalRecording(dir+'/recording.mp4',new Request('http://x/',{headers:{Range:'bytes=50-'}}))).status).toBe(416);
 expect((await serveLocalRecording(dir+'/missing.mp4',new Request('http://x/'))).status).toBe(404);
 const head=await serveLocalRecording(dir+'/recording.mp4',new Request('http://x/',{method:'HEAD'}));
 expect(head.status).toBe(200);expect(head.headers.get('Content-Length')).toBe('10');
});
