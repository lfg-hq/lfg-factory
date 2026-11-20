import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
const TYPES:Record<string,string>={mp4:'video/mp4',jpg:'image/jpeg',json:'application/json'};
/** Serves a recording saved in local storage (no S3), with byte ranges so the video can seek. */
export async function serveLocalRecording(path:string,request:Request):Promise<Response>{
 const info=await stat(path).catch(()=>null);
 if(!info?.isFile())return new Response('Recording artifact unavailable',{status:404});
 const headers=new Headers({'Cache-Control':'private, no-store','Accept-Ranges':'bytes','Content-Type':TYPES[path.split('.').pop()!]||'application/octet-stream'});
 let start=0,end=info.size-1,status=200;
 const range=request.headers.get('Range')?.match(/^bytes=(\d*)-(\d*)$/);
 if(range&&(range[1]||range[2])){
  start=range[1]?Number(range[1]):Math.max(0,info.size-Number(range[2]));
  end=range[1]&&range[2]?Math.min(Number(range[2]),info.size-1):info.size-1;
  if(start>end||start>=info.size){headers.set('Content-Range',`bytes */${info.size}`);return new Response(null,{status:416,headers});}
  status=206;headers.set('Content-Range',`bytes ${start}-${end}/${info.size}`);
 }
 headers.set('Content-Length',String(end-start+1));
 if(request.method==='HEAD'||info.size===0)return new Response(null,{status,headers});
 return new Response(Readable.toWeb(createReadStream(path,{start,end})) as ReadableStream,{status,headers});
}
