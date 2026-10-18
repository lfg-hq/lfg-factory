// Exercises the runner against a local fake chat; no model or project writes.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const temp=await mkdtemp(join(tmpdir(),'planning-runner-'));
let sends=0;
const server=Bun.serve({port:0,hostname:'127.0.0.1',
 fetch(req,server){
  const path=new URL(req.url).pathname;
  if(path==='/ws'){if(server.upgrade(req))return;return new Response('Upgrade failed',{status:400});}
  if(path.endsWith('/api/files/browser'))return Response.json({files:sends>=3?[{id:'doc',name:'Test requirements',type:'prd',updated_at:'today'}]:[]});
  if(path.endsWith('/content'))return Response.json({content:'Fixture requirements document'});
  if(path.endsWith('/tickets'))return Response.json({tickets:[]});
  if(path.endsWith('/epics'))return Response.json({epics:[]});
  return new Response(`<form id="chat-form"><textarea id="chat-input"></textarea><button id="send-btn" disabled>Send</button></form><main></main><script>
   const ws=new WebSocket('ws://'+location.host+'/ws');ws.onopen=()=>document.querySelector('#send-btn').disabled=false;
   document.querySelector('form').onsubmit=e=>{e.preventDefault();window.__isAgentStreaming__=true;ws.send(document.querySelector('textarea').value);};
   ws.onmessage=e=>{const data=JSON.parse(e.data);if(data.chunk)document.querySelector('main').textContent+=data.chunk;if(data.is_final)window.__isAgentStreaming__=false;};
  </script>`,{headers:{'Content-Type':'text/html'}});
 },
 websocket:{message(ws,message){sends++;ws.send(JSON.stringify({type:'ai_chunk',chunk:'Fixture reply '+sends}));ws.send(JSON.stringify({type:'ai_chunk',notification_type:'tool_detail',detail:'Loaded skill: product-planning'}));ws.send(JSON.stringify({type:'ai_chunk',is_final:true,end_reason:'complete',conversation_id:'fixture-chat'}));}}
});
try {
 const child=spawn('node',['scripts/chat-planning-test.mjs','--base-url',`http://127.0.0.1:${server.port}`,'--profile',join(temp,'profile'),'--output',join(temp,'report'),'--timeout-seconds','10'],{stdio:['pipe','pipe','pipe']});
 let output='',started=false;
 child.stdout.on('data',data=>{output+=data;if(!started&&output.includes('This creates real planning artifacts.')){started=true;child.stdin.write('\n');}});
 child.stderr.on('data',data=>{output+=data;});
 const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
 assert.equal(code,0,output);
 const report=JSON.parse(await readFile(join(temp,'report/report.json'),'utf8'));
 assert.equal(report.status,'completed-for-review');assert.equal(sends,6);
 assert.equal(report.turns.length,6);assert.equal(report.conversationId,'fixture-chat');
 assert.equal(report.snapshots[0].files.files.length,0);
 assert.equal(report.snapshots.at(-1).documents[0].content.content,'Fixture requirements document');
 assert.ok(report.events.some((e:any)=>e.detail==='Loaded skill: product-planning'));
 console.log('PASS: Chrome runner opens fresh chat, completes six turns, captures activity and artifact contents, and exports report.');
}finally{server.stop(true);await rm(temp,{recursive:true,force:true});}
