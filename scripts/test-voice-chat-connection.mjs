import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await fs.readFile('public/js/chat.js','utf8');
const helper=source.slice(source.indexOf('    function ensureVoiceChatConnected('),source.indexOf('    window.chatVoice ='));
const guard=source.slice(source.indexOf('        // Check if already connected',source.indexOf('function connectWebSocket()')),source.indexOf("        // Determine if we're on HTTPS",source.indexOf('function connectWebSocket()')));
const context=vm.createContext({setTimeout,clearTimeout,AbortController,EventTarget,Event,console});
vm.runInContext(`
const WebSocket={OPEN:1,CONNECTING:0};
let attempts=0;
let socket;
function connectWebSocket(){${guard} attempts++;socket=new EventTarget();socket.readyState=0;}
${helper}
globalThis.run=async()=>{
 const first=ensureVoiceChatConnected();
 const pending=socket;
 const second=ensureVoiceChatConnected();
 if(attempts!==1 || pending!==socket)throw new Error('Replaced connecting socket');
 socket.readyState=1;socket.dispatchEvent(new Event('open'));
 if(!await first || !await second)throw new Error('Open connection rejected');
 if(!await ensureVoiceChatConnected())throw new Error('Existing connection rejected');
 socket.readyState=3;
 const failed=ensureVoiceChatConnected();socket.dispatchEvent(new Event('error'));
 if(await failed)throw new Error('Failed connection accepted');
 socket.readyState=3;
 if(await ensureVoiceChatConnected({timeoutMs:5}))throw new Error('Timeout accepted');
 const controller=new AbortController();
 const cancelled=ensureVoiceChatConnected({signal:controller.signal});controller.abort();
 if(await cancelled)throw new Error('Cancelled connection accepted');
 controller.abort();
 if(await ensureVoiceChatConnected({signal:controller.signal}))throw new Error('Pre-aborted connection accepted');
 return true;
};`,context);
assert.equal(await context.run(),true);
console.log('PASS: existing/pending chat socket reused, reconnect, failure, timeout, cancellation.');
