import { spawn } from 'node:child_process';
import { startBrowserSession, stopWorkspace } from './mags.ts';
import { designPreviewPath, type DesignBaseline } from './design-baseline.ts';
export async function captureDesignBaseline(input: {projectId:string; previewUrl:string; branch:string|null; path:string; selector:string}): Promise<DesignBaseline> {
 const url=designPreviewPath(input.previewUrl,input.path);
 const session=await startBrowserSession({timeout:90000});
 try {
  const result=await new Promise<any>((resolve,reject)=>{
   const child=spawn('node',[`${process.cwd()}/scripts/design-baseline-worker.mjs`],{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'0'}});
   let output='';
   const timer=setTimeout(()=>{child.kill();reject(new Error('App layout capture timed out.'));},65000);
   child.stdout.on('data',chunk=>{output+=chunk;if(output.length>9_000_000){child.kill();reject(new Error('Captured layout is too large.'));}});
   child.stderr.resume();
   child.on('error',e=>{clearTimeout(timer);reject(e);});
   child.on('close',()=>{clearTimeout(timer);try{const data=JSON.parse(output);if(data.error)reject(new Error(data.error));else resolve(data);}catch{reject(new Error('App layout capture returned no readable result.'));}});
   child.stdin.on('error',()=>{});
   child.stdin.end(JSON.stringify({wsEndpoint:session.wsEndpoint,url,selector:input.selector}));
  });
  return {version:1,projectId:input.projectId,branch:input.branch,path:input.path,capturedAt:new Date().toISOString(),...result};
 } finally {await stopWorkspace(session.requestId).catch(()=>{});}
}
