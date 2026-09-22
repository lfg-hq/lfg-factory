/** Byte ranges let the browser seek without downloading the entire recording. */
export function recordingResponse(file:Pick<import("bun").BunFile,"size"|"slice">,range?:string,head=false):Response {
 const headers:Record<string,string>={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, no-store'};
 let start=0,end=file.size-1;
 if(range){
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${file.size}`}});
  if(!match[1])start=Math.max(0,file.size-Number(match[2]));
  else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
  if(start>end||start>=file.size)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${file.size}`}});
  headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;
 }
 headers['Content-Length']=String(Math.max(0,end-start+1));
 return new Response(head?null:file.slice(start,end+1),{status:range?206:200,headers});
}
