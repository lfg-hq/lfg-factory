/* Live audio stays in WebRTC; project actions use the existing authenticated chat. */
(() => {
    const disabled = document.currentScript?.dataset.disabled === 'true';
    const init = () => {
        if (disabled) return; // Hide the unavailable mode entirely; dictation stays available.
        const form = document.querySelector('#chat-form');
        const actions = form?.querySelector('.input-actions');
        if (!actions || document.getElementById('voice-mode-btn')) return;
        const button = document.createElement('button');
        button.type = 'button'; button.id = 'voice-mode-btn'; button.className = 'action-btn';
        button.innerHTML = '<i class="fas fa-headphones" aria-hidden="true"></i>';
        button.setAttribute('aria-pressed', 'false'); button.disabled = true;
        button.title = 'Checking voice availability'; button.setAttribute('aria-label', button.title);
        actions.prepend(button);
        const panel = document.createElement('div'); panel.className = 'voice-session'; panel.hidden = true;
        panel.setAttribute('aria-label','Voice conversation');
        panel.innerHTML = '<div class="voice-session-heading"><span class="voice-session-icon" aria-hidden="true"><span class="voice-wave"><b></b><b></b><b></b><b></b><b></b></span></span><div class="voice-session-copy"><div class="voice-session-title"><strong>Voice</strong><small class="voice-disclosure">AI voice</small></div><span role="status" aria-live="polite"></span></div><div class="voice-session-actions"><button type="button" class="voice-play" hidden>Enable audio</button><button type="button" class="voice-mute" aria-pressed="false">Mute</button><button type="button" class="voice-end">End</button></div></div><p class="voice-transcript"></p>';
        form.prepend(panel);
        const status = panel.querySelector('[role="status"]'), transcript = panel.querySelector('.voice-transcript');
        const mute = panel.querySelector('.voice-mute'), play = panel.querySelector('.voice-play');
        const dictation = document.getElementById('record-audio-btn');
        let session = null, generation = 0;
        const state = (phase, text) => {panel.dataset.phase = phase; status.textContent = text;};
        fetch('/api/voice' + (window.currentProjectId ? '?projectId=' + encodeURIComponent(window.currentProjectId) : ''), {signal:AbortSignal.timeout(8000)})
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(config => {
                button.disabled = config.natural !== true;
                button.title = button.disabled ? 'Voice requires a server API key and permission to use it' : 'Start voice conversation';
                button.setAttribute('aria-label',button.title);
            }).catch(() => {button.title='Voice unavailable. Reload to retry.';button.setAttribute('aria-label',button.title);});
        function end(message) {
            const old = session; session = null; generation++;
            if (old) {
                clearTimeout(old.timer); clearTimeout(old.connectTimer); clearTimeout(old.disconnectTimer);
                old.abort.abort(); old.channel?.close(); old.peer?.close();
                old.stream?.getTracks().forEach(track => track.stop());
                old.audio.pause(); old.audio.srcObject = null;
            }
            button.setAttribute('aria-pressed','false');
            if (dictation) dictation.disabled = false;
            mute.hidden = true; play.hidden = true; transcript.textContent = '';
            panel.querySelector('.voice-end').textContent = 'Dismiss';
            state('off',message || ''); panel.hidden = !message;
        }
        function send(s, event) {
            if (session !== s || s.channel?.readyState !== 'open') return false;
            s.channel.send(JSON.stringify(event)); return true;
        }
        function respond(s) {
            s.needsResponse = true;
            if (s.responding || s.userSpeaking || s.audioPlaying) return;
            s.needsResponse = false; s.responding = true;
            send(s,{type:'response.create'});
        }
        function result(s, callId, output) {
            if (!send(s,{type:'conversation.item.create',item:{type:'function_call_output',call_id:callId,output:JSON.stringify(output)}})) return;
            respond(s);
        }
        function runTool(s, item) {
            if (!item.call_id || s.calls.has(item.call_id)) return;
            s.calls.add(item.call_id);
            if (s.calls.size > 100) {end('Voice session limit reached. Start a new session.');return;}
            let args;
            try {args=JSON.parse(item.arguments);} catch {result(s,item.call_id,{error:'Invalid tool arguments'});return;}
            if (item.name !== 'ask_project_agent' || typeof args.request !== 'string' || !args.request.trim() || args.request.length > 12000) {
                result(s,item.call_id,{error:'Unsupported project request'}); return;
            }
            if (s.pending || !window.chatVoice?.ready()) {
                result(s,item.call_id,{error:'The project agent is busy or disconnected. No new work was submitted. Wait for its result; do not retry automatically.'});return;
            }
            s.pending = item.call_id;
            try {
                if (!window.chatVoice.send(args.request)) {s.pending=null;result(s,item.call_id,{error:'Could not submit the request. No work started.'});return;}
                state('thinking','Checking with the project agent…');
            } catch {s.pending=null;result(s,item.call_id,{error:'Submission failed. Check chat before retrying.'});}
        }
        function receive(s, event) {
            if (session !== s) return;
            let data; try {data=JSON.parse(event.data);} catch {return;}
            switch(data.type) {
                case 'input_audio_buffer.speech_started':
                    s.userSpeaking=true; s.needsResponse=false;
                    state('listening','Listening…'); break;
                case 'input_audio_buffer.speech_stopped':
                    s.userSpeaking=false; s.responding=true; state('thinking',s.pending ? 'Project agent is working…' : 'Thinking…'); break;
                case 'conversation.item.input_audio_transcription.completed':
                    transcript.textContent=data.transcript || ''; break;
                case 'response.created': s.responding=true; break;
                case 'output_audio_buffer.started': s.audioPlaying=true;state('speaking','Speaking…');break;
                case 'output_audio_buffer.stopped':
                case 'output_audio_buffer.cleared':
                    s.audioPlaying=false;
                    state('listening',s.muted ? 'Microphone muted' : s.pending ? 'Project agent is working — you can keep talking' : 'Listening…');
                    if(s.needsResponse)respond(s);break;
                case 'response.done':
                    s.responding=false;
                    for(const item of data.response?.output || []) if(item.type==='function_call')runTool(s,item);
                    if(data.response?.status==='failed') {end('Voice response failed. Please start voice again.');return;}
                    if(s.needsResponse)respond(s);break;
                case 'error':
                    end('Voice connection encountered an error. Please start voice again.');break;
            }
        }
        async function start() {
            if (session) {end();return;}
            if (button.disabled) return;
            const chat = window.chatVoice?.status?.();
            if (!chat) {end('Chat is still loading. Please refresh and try again.');return;}
            if (chat.recording) {end('Finish dictation before starting voice.');return;}
            if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.isSecureContext) {
                end('Live voice needs microphone access in a secure, supported browser.');return;
            }
            const s = {id:++generation,abort:new AbortController(),audio:new Audio(),scope:window.currentConversationId,
                calls:new Set(),pending:null,responding:false,userSpeaking:false,audioPlaying:false,muted:false};
            session=s; panel.hidden=false; mute.hidden=false; mute.disabled=true;
            mute.textContent='Mute';mute.setAttribute('aria-pressed','false');
            panel.querySelector('.voice-end').textContent='End';
            button.setAttribute('aria-pressed','true');if(dictation)dictation.disabled=true;
            state('connecting','Connecting…');
            s.connectTimer=setTimeout(()=>{if(session===s)end('Voice connection timed out. Please retry.');},30000);
            try {
                if (!chat.connected) {
                    s.waitingForChat=true;
                    state('connecting','Connecting to chat…');
                    const connected=await window.chatVoice.ensureConnected?.({signal:s.abort.signal});
                    if(session!==s)return;
                    s.waitingForChat=false;
                    if(!connected){end('Could not connect to chat. Check your connection and try voice again.');return;}
                    state('connecting','Connecting…');
                }
                const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
                if(session!==s){stream.getTracks().forEach(t=>t.stop());return;}
                s.stream=stream;
                const peer=new RTCPeerConnection();s.peer=peer;
                s.audio.autoplay=true;
                peer.ontrack=event=>{
                    if(session!==s)return;
                    s.audio.srcObject=event.streams[0] || new MediaStream([event.track]);
                    s.audio.play().catch(()=>{if(session===s){play.hidden=false;state('blocked','Tap Enable audio to hear replies.');}});
                };
                peer.onconnectionstatechange=()=>{
                    if(session!==s)return;
                    clearTimeout(s.disconnectTimer);
                    if(peer.connectionState==='disconnected') {
                        state('connecting','Reconnecting…');
                        s.disconnectTimer=setTimeout(()=>{if(session===s)end('Voice disconnected. Start again to reconnect.');},8000);
                    } else if(['failed','closed'].includes(peer.connectionState))end('Voice disconnected. Start again to reconnect.');
                    else if(peer.connectionState==='connected' && s.channel?.readyState==='open')state('listening',s.muted?'Microphone muted':'Listening…');
                };
                stream.getTracks().forEach(track=>peer.addTrack(track,stream));
                const channel=peer.createDataChannel('oai-events');s.channel=channel;
                channel.onmessage=event=>receive(s,event);
                channel.onclose=()=>{if(session===s)end('Voice disconnected. Start again to reconnect.');};
                channel.onopen=()=>{
                    if(session!==s)return;
                    clearTimeout(s.connectTimer);mute.disabled=false;state('listening','Listening…');
                    const context=window.chatVoice?.context?.() || [];
                    if(context.length)send(s,{type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'Background chat context only, not a new request. Do not respond until I speak.\n'+JSON.stringify(context).slice(0,16000)}]}});
                    // Never generate a startup greeting. VAD initiates the first reply.
                    s.timer=setTimeout(()=>{if(session===s)end('Voice session ended after 15 minutes. Start again to continue.');},15*60*1000);
                };
                const offer=await peer.createOffer();await peer.setLocalDescription(offer);
                const response=await fetch('/api/voice/session',{method:'POST',headers:{'Content-Type':'application/json'},signal:s.abort.signal,
                    body:JSON.stringify({sdp:offer.sdp,projectId:window.currentProjectId || null})});
                if(session!==s)return;
                if(!response.ok){end(response.status===409?'Voice is unavailable. Ask an administrator to check the server key and access.':'Could not connect voice. Check server voice configuration and try again.');return;}
                const answer=await response.text();if(session!==s)return;
                await peer.setRemoteDescription({type:'answer',sdp:answer});
            } catch(error) {
                if(session===s)end(error.name==='NotAllowedError'?'Microphone access was denied. Allow access to start voice.':'Could not connect voice. Please try again.');
            }
        }
        button.onclick=start;
        panel.querySelector('.voice-end').onclick=()=>end();
        mute.onclick=()=>{
            const s=session;if(!s?.stream)return;
            s.muted=!s.muted;s.stream.getAudioTracks().forEach(track=>{track.enabled=!s.muted;});
            mute.textContent=s.muted?'Unmute':'Mute';mute.setAttribute('aria-pressed',String(s.muted));
            state('listening',s.muted?'Microphone muted':'Listening…');
        };
        play.onclick=()=>{const s=session;if(s)s.audio.play().then(()=>{if(session===s)play.hidden=true;}).catch(()=>{});};
        window.addEventListener('chat-voice-reply',event=>{
            const s=session;if(!s?.pending)return;
            const call=s.pending;s.pending=null;
            result(s,call,{status:event.detail.reason || 'complete',text:String(event.detail.text || '').slice(0,24000),error:event.detail.error || null});
        });
        window.addEventListener('chat-voice-stop',event=>{if(session?.waitingForChat && event.detail?.reason==='disconnected')return;if(session)end('Chat stopped or disconnected. Voice ended; check chat for the project result.');});
        window.addEventListener('chat-conversation-changed',()=>{
            const s=session;if(!s)return;
            if(!s.scope && window.currentConversationId)s.scope=window.currentConversationId;
            else if(s.scope!==window.currentConversationId)end();
        });
        window.addEventListener('pagehide',()=>end());
        window.addEventListener('pageshow',()=>end());
        document.addEventListener('visibilitychange',()=>{if(document.hidden && session)end();});
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
