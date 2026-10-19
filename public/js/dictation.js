/* OpenAI dictation: live preview, full-recording final transcript, editable draft. */
window.createDictation = ({button, input, wrapper, getScope, getContext, onSend}) => {
    if (!button || !input || !wrapper) return {active:false};
    let session = null;
    const active = s => session === s && s.scope === getScope();
    function label(s, text) { s.status.textContent = text; s.panel.dataset.phase = s.phase; }
    function stopCapture(s) {
        clearInterval(s.clock); clearTimeout(s.limit);
        s.stream?.getTracks().forEach(t => t.stop());
        if (s.recorder?.state === 'recording') s.recorder.stop();
        s.peer?.close(); s.audioContext?.close().catch(() => {});
        cancelAnimationFrame(s.frame);
    }
    // Live words fill the composer as they arrive; the full-recording transcript replaces them.
    function showLive(s) {
        const text = preview(s);
        if (!text) return;
        const before = s.draft.slice(0, s.start), after = s.draft.slice(s.end);
        input.value = before + (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '') + after;
        s.live = true; input.readOnly = true; input.classList.add('dictation-live');
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.scrollTop = input.scrollHeight;
    }
    function clearLive(s) {
        if (!s.live) return;
        s.live = false; input.readOnly = false; input.classList.remove('dictation-live');
        input.value = s.draft;
        input.dispatchEvent(new Event('input', {bubbles: true}));
    }
    function close(s) {
        if (session !== s) return;
        clearLive(s);
        session = null; s.abort.abort(); stopCapture(s);
        s.panel.remove(); button.classList.remove('recording');
        button.setAttribute('aria-pressed','false'); button.title = 'Dictate a message';
        button.innerHTML = '<i class="fas fa-microphone" aria-hidden="true"></i>';
    }
    function insert(s, text) {
        if (!active(s)) { close(s); return; }
        clearLive(s);
        text = text.trim();
        if (text) {
            // Insert at the original caret if the draft is unchanged; never overwrite concurrent edits.
            const start = input.value === s.draft ? s.start : input.value.length;
            const end = input.value === s.draft ? s.end : start;
            const before = input.value.slice(0,start), after = input.value.slice(end);
            const addition = (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '');
            input.value = before + addition + after;
            close(s);
            input.dispatchEvent(new Event('input',{bubbles:true}));
            input.scrollTop = 0; input.focus(); input.setSelectionRange(start+addition.length,start+addition.length);
            if (s.sendAfter) onSend?.();
        } else { close(s); input.focus(); }
    }
    function preview(s) { return [...s.items.values()].map(x=>x.text).join(' ').trim(); }
    function failed(s, message) {
        if (!active(s)) return;
        s.phase = 'failed'; s.sendAfter = false; stopCapture(s);
        s.send.disabled = true;
        label(s,message);
        s.retry.hidden = !s.blob;
        s.done.innerHTML = '&#10003;';
        s.done.setAttribute('aria-label', preview(s) ? 'Keep draft text' : 'Close');
        s.done.disabled = false;
        s.done.onclick = () => insert(s,preview(s));
    }
    async function finalize(s) {
        if (!active(s)) return;
        s.phase = 'finalizing'; s.send.disabled = true; s.retry.hidden = true; s.done.disabled = true;
        label(s,'Finishing transcription…');
        try {
            const form = new FormData();
            const extension = s.blob.type.includes('mp4') ? 'm4a' : s.blob.type.includes('ogg') ? 'ogg' : 'webm';
            form.set('audio',s.blob,`dictation.${extension}`);
            form.set('context',JSON.stringify(s.context));
            const response = await fetch('/api/voice/dictation/transcribe', {
                method:'POST',body:form,signal:AbortSignal.any([s.abort.signal,AbortSignal.timeout(65000)])
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Transcription failed. Retry your recording.');
            if (!active(s)) return;
            if (typeof data.text !== 'string') throw new Error('No transcript returned. Retry your recording.');
            if (!data.text.trim()) { failed(s,'No speech was recognized. You can retry or close.'); return; }
            insert(s,data.text);
        } catch (error) {
            if (active(s)) failed(s,error.name === 'TimeoutError' ? 'Transcription timed out. Retry your recording.' : error.message);
        }
    }
    async function stop(s) {
        if (!active(s)) return;
        if (s.phase === 'connecting') { close(s); return; }
        if (s.phase !== 'recording') return;
        s.phase = 'stopping'; s.done.disabled = true;
        label(s,'Finishing transcription…');
        // The full recording is authoritative; preview deltas are never sent as a message.
        if (s.channel?.readyState === 'open') s.channel.send(JSON.stringify({type:'input_audio_buffer.commit'}));
        await new Promise(resolve => {
            s.recorder.addEventListener('stop',resolve,{once:true});
            s.recorder.stop();
            stopCapture(s);
        });
        if (!active(s)) return;
        s.blob = new Blob(s.chunks,{type:s.recorder.mimeType || 'audio/webm'});
        if (!s.blob.size) { failed(s,'No audio was recorded. Please try again.'); return; }
        await finalize(s);
    }
    function build(s) {
        const panel = document.createElement('div'); panel.className = 'audio-recording-indicator';
        panel.innerHTML = '<button type="button" class="recording-cancel-btn" aria-label="Cancel dictation" title="Cancel dictation">×</button><canvas class="dictation-waveform" aria-hidden="true"></canvas><span class="dictation-status" role="status" aria-live="polite">Connecting…</span><button type="button" class="dictation-retry" hidden aria-label="Retry transcription" title="Retry transcription">↻</button><button type="button" class="dictation-done" aria-label="Stop dictation and keep text" title="Stop dictation and keep text"><span class="dictation-stop-icon" aria-hidden="true"></span></button><button type="button" class="dictation-send" aria-label="Transcribe and send message" title="Transcribe and send message" disabled><i class="fas fa-paper-plane" aria-hidden="true"></i></button>';
        s.panel=panel; s.status=panel.querySelector('.dictation-status');
        s.done=panel.querySelector('.dictation-done'); s.retry=panel.querySelector('.dictation-retry');
        panel.dataset.phase = s.phase;
        s.send=panel.querySelector('.dictation-send');
        s.send.onclick=()=>{if(s.phase==='recording'){s.sendAfter=true;void stop(s);}};
        s.done.onclick=()=>stop(s);
        panel.querySelector('.recording-cancel-btn').onclick=()=>{close(s);input.focus();};
        s.retry.onclick=()=>finalize(s); wrapper.append(panel);
    }
    function waveform(s) {
        const canvas=s.panel.querySelector('canvas'), ctx=canvas.getContext('2d');
        try {
            const AudioContext=window.AudioContext || window.webkitAudioContext;
            s.audioContext=new AudioContext();
            const analyser=s.audioContext.createAnalyser(); analyser.fftSize=256;
            s.audioContext.createMediaStreamSource(s.stream).connect(analyser);
            s.analyser=analyser;s.samples=new Uint8Array(analyser.fftSize);
            s.audioContext.resume().catch(()=>{});
        } catch { /* Recording still works if visualization is unavailable. */ }
        s.levels=[];
        const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let lastFrame=0, smoothed=0;
        const draw=(now=0)=>{
            if(!active(s) || s.phase!=='recording')return;
            if(now-lastFrame<120){s.frame=requestAnimationFrame(draw);return;}
            lastFrame=now;
            const width=canvas.clientWidth, height=32, ratio=window.devicePixelRatio || 1;
            canvas.width=width*ratio;canvas.height=height*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);
            let level=0;
            if(s.analyser){s.analyser.getByteTimeDomainData(s.samples);for(const sample of s.samples)level+=((sample-128)/128)**2;level=Math.sqrt(level/s.samples.length);}
            smoothed=smoothed*.75+level*.25;
            s.levels.push(reduced ? 3 : Math.max(3,Math.min(22,smoothed*120)));if(s.levels.length>200)s.levels.shift();
            ctx.strokeStyle=getComputedStyle(canvas).color;ctx.lineWidth=3;ctx.lineCap='round';
            const count=Math.floor(width/7);
            for(let i=0;i<count;i++){const h=s.levels[s.levels.length-count+i] || 3;ctx.beginPath();ctx.moveTo(i*7+2,(height-h)/2);ctx.lineTo(i*7+2,(height+h)/2);ctx.stroke();}
            s.frame=requestAnimationFrame(draw);
        };
        draw();
    }
    async function connectPreview(s,stream) {
        if(!window.RTCPeerConnection)return;
        try {
            s.peer=new RTCPeerConnection();stream.getTracks().forEach(t=>s.peer.addTrack(t,stream));
            s.channel=s.peer.createDataChannel('dictation-events');
            s.channel.onmessage=event=>{
                if(!active(s) || s.phase!=='recording')return;
                let data;try{data=JSON.parse(event.data);}catch{return;}
                if(data.type==='error' || data.type==='conversation.item.input_audio_transcription.failed') {
                    s.panel.dataset.live='off';label(s,'Live text unavailable · transcript appears when you stop');return;
                }
                if(!data.item_id)return;
                if(data.type==='conversation.item.input_audio_transcription.delta') {
                    const item=s.items.get(data.item_id) || {text:'',final:false};
                    if(!item.final){item.text+=data.delta || '';s.items.set(data.item_id,item);}
                } else if(data.type==='conversation.item.input_audio_transcription.completed') {
                    s.items.set(data.item_id,{text:data.transcript || '',final:true});
                } else return;
                showLive(s);
            };
            const opened=new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(new Error('Dictation connection timed out. Please retry.')),25000);
                const settle=fn=>{clearTimeout(timer);fn();};
                s.channel.onopen=()=>settle(resolve);
                s.abort.signal.addEventListener('abort',()=>settle(()=>reject(new DOMException('Cancelled','AbortError'))),{once:true});
                s.channel.onclose=()=>settle(()=>reject(new Error('Dictation connection closed.')));
            });
            // Attach a handler immediately while SDP negotiation is in flight.
            opened.catch(()=>{});
            const offer=await s.peer.createOffer();await s.peer.setLocalDescription(offer);
            const response=await fetch('/api/voice/dictation/session',{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({...s.context,sdp:offer.sdp}),signal:AbortSignal.any([s.abort.signal,AbortSignal.timeout(30000)])});
            if(!response.ok){const data=await response.json();throw new Error(data.error || 'Could not start dictation.');}
            const answer=await response.text();if(!active(s) || s.phase!=='recording')return;
            await s.peer.setRemoteDescription({type:'answer',sdp:answer});await opened;if(!active(s) || s.phase!=='recording')return;

        } catch {
            // Full-recording transcription remains available when live setup fails; say so.
            s.peer?.close();
            if (active(s) && s.phase === 'recording') { s.panel.dataset.live = 'off'; label(s, 'Live text unavailable · transcript appears when you stop'); }
        }
    }
    async function start() {
        if (session) { await stop(session); return; }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.isSecureContext) {
            alert('Dictation requires microphone access in a supported, secure browser.'); return;
        }
        const s={scope:getScope(),context:getContext(),abort:new AbortController(),phase:'connecting',items:new Map(),chunks:[],
            draft:input.value,start:input.selectionStart ?? input.value.length,end:input.selectionEnd ?? input.value.length};
        session=s; build(s); button.classList.add('recording'); button.setAttribute('aria-pressed','true');
        button.title='Stop dictation and keep text';button.innerHTML='<i class="fas fa-stop" aria-hidden="true"></i>';
        try {
            const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
            if(!active(s)){stream.getTracks().forEach(t=>t.stop());return;}
            s.stream=stream;
            const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
            s.recorder=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});
            s.recorder.ondataavailable=e=>{if(e.data.size)s.chunks.push(e.data);};
            s.recorder.onstop=()=>{
                if (active(s) && s.phase==='recording') {
                    stopCapture(s);
                    s.blob=new Blob(s.chunks,{type:s.recorder.mimeType || 'audio/webm'});
                    if(s.blob.size)finalize(s);else failed(s,'Recording ended without audio. Please try again.');
                }
            };
            s.recorder.onerror=()=>{if(active(s) && s.recorder.state==='recording')stop(s);};
            s.phase='recording';stream.getAudioTracks().forEach(t=>{t.enabled=true;});s.recorder.start(1000);
            label(s,'Listening…');waveform(s);
            s.limit=setTimeout(()=>stop(s),300000);
            s.send.disabled=false;
            // A remote connection is optional; never delay local recording for it.
            void connectPreview(s,stream);
        } catch(error) { if(active(s)) {s.abort.abort();failed(s,error.name==='NotAllowedError'?'Microphone permission was denied. Allow access and try again.':error.message);} }
    }
    button.title='Dictate a message';button.setAttribute('aria-label','Dictate a message');button.onclick=start;
    let finishingWithEnter = false;
    // Capture before the chat input's Enter-to-send handler and native button clicks.
    wrapper.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        if (!event.repeat) finishingWithEnter = false;
        const finishing = session && ['connecting','recording','stopping','finalizing'].includes(session.phase);
        if (!finishing && !(event.repeat && finishingWithEnter)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finishingWithEnter = true;
        if (session?.phase === 'recording') void stop(session);
    }, true);
    wrapper.addEventListener('keyup', event => {
        if (event.key === 'Enter') finishingWithEnter = false;
    }, true);
    window.addEventListener('pagehide',()=>{if(session)close(session);});
    window.addEventListener('chat-conversation-changed',()=>{if(session && !active(session))close(session);});
    return {get active(){return !!session;},cancel(){if(session)close(session);}};
};
