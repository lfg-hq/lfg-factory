(function(){
 let panel, request;
 async function check(form){
  if(!form || request)return;
  if(!panel?.isConnected){
   panel=document.createElement('div');panel.className='chatgpt-connection';
   const text=document.createElement('span');text.setAttribute('role','status');text.setAttribute('aria-live','polite');
   const retry=document.createElement('button');retry.type='button';retry.textContent='Check again';retry.onclick=()=>check(form);
   const settings=document.createElement('a');settings.href='/settings';settings.textContent='Settings';settings.hidden=true;
   const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='×';dismiss.setAttribute('aria-label','Dismiss connection status');dismiss.onclick=()=>{request?.abort();panel.remove();};
   panel.append(text,retry,settings,dismiss);form.before(panel);
  }
  const target=panel,[text,retry,settings]=target.children;
  text.textContent='Checking ChatGPT access…';retry.disabled=true;settings.hidden=true;target.dataset.status='checking';
  request=new AbortController();
  try{
   const response=await fetch('/api/v1/openai-codex-auth/check',{method:'POST',signal:AbortSignal.any([request.signal,AbortSignal.timeout(10000)])});
   const result=await response.json();
   if(!target.isConnected)return;
   target.dataset.status=result.status || 'unavailable';
   text.textContent=result.message || 'Could not check ChatGPT access. Please try again.';
   settings.hidden=result.status!=='reconnect';
  }catch(error){if(target.isConnected){text.textContent=error.name==='TimeoutError'?'The connection check timed out. Try again shortly.':'Could not check ChatGPT access. Please try again.';target.dataset.status='unavailable';}}
  finally{retry.disabled=false;request=null;}
 }
 window.addEventListener('chat-conversation-changed',()=>{request?.abort();panel?.remove();});
 window.ChatGPTConnection={check};
})();
