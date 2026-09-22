/** Uses configured S3/R2, uploads generated test media, checks range playback, then deletes only its own objects. */
import {RecordingArtifacts} from '../src/services/recording-artifacts.ts';
import {getPresignedGetUrl,deleteFile} from '../src/services/s3.ts';
import {stat,rm,writeFile} from 'node:fs/promises';
const artifacts=await RecordingArtifacts.create('storage-smoke-'+crypto.randomUUID());
const prefix=artifacts.url.slice('/uploads/'.length);
try{
 const generated=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=purple:s=320x180:d=1','-c:v','libx264','-pix_fmt','yuv420p',artifacts.dir+'/recording.mp4'],{stderr:'pipe'});
 if(await generated.exited!==0)throw Error(await new Response(generated.stderr).text());
 await artifacts.finish('passed','Generated recording storage smoke test');
 if(await stat(artifacts.dir).then(()=>true).catch(()=>false))throw Error('Temporary files not cleaned');
 const status=await fetch(await getPresignedGetUrl(prefix+'/status.json',60));
 if(!status.ok || (await status.json() as any).status!=='passed')throw Error('Persisted result missing');
 const media=await fetch(await getPresignedGetUrl(prefix+'/recording.mp4',60),{headers:{Range:'bytes=0-1023'}});
 if(media.status!==206 || (await media.arrayBuffer()).byteLength!==1024)throw Error('Object video range playback failed');
 console.log('Configured object storage passed: generated MP4 upload, persisted status, signed read, HTTP 206 byte range, temporary cleanup.');
}finally{
 await artifacts.abort('Smoke test complete').catch(()=>{});
 for(const name of ['status.json','recording.mp4','live.jpg'])await deleteFile(prefix+'/'+name);
 await rm(artifacts.dir,{recursive:true,force:true});console.log('Smoke-test objects deleted.');
}
