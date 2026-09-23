/* Shared by the ticket drawer and the chat ticket panel. No log content is discarded. */
(function (root) {
  function group(rows, ticket) {
    const phases = [{ id: 'build', label: 'Build', status: 'pending', rows: [] }, { id: 'validation', label: 'Validation', status: 'pending', rows: [] }, { id: 'feature-testing', label: 'Feature testing', status: 'pending', rows: [] }];
    let active = 0;
    let buildStarted = false;
    for (const row of rows) {
      const text = String(row.message || '').replace(/\*\*/g, '').trim();
      if (/^(Running a sandbox command|The same repair session is still active\.)$/.test(text)) continue;
      const retry = /^Retrying validation of saved commit/i.test(text);
      const validation = retry || /^(Running the saved ticket:|Repairing runtime checks:|Checking:|Preparing validation:|Now verifying this commit|Fresh \/ candidate:|Runtime checks passed|✅\s*Validation passed)/i.test(text);
      const build = /^(Starting Pi build|Isolated build:|Starting (?:ticket )?build|Building ticket)/i.test(text);
      if (build) { buildStarted = true; active = 0; phases[0].status = 'working'; phases[1].status = 'pending'; phases[2].status = 'pending'; }
      if (validation) {
        active = 1;
        if (phases[0].status === 'working') phases[0].status = buildStarted ? 'done' : 'unknown';
        if (retry && !phases[0].rows.length) phases[0].status = 'skipped';
        phases[1].status = 'working';
      }
      // A new feature run replaces the visible history, including old browser cards.
      // The original rows remain in stored history; only this phase's view resets.
      if (/^Feature testing:\s*(starting an independent run on saved code|Preparing tests for the existing app)/i.test(text)) {
        const previous=phases[2].rows;
        // The initial preparation message follows the independent-run marker.
        if (!(/^Feature testing:\s*Preparing tests/i.test(text) && previous.length===1 && /starting an independent run/i.test(previous[0].message||''))) phases[2].rows=[];
        phases[2].status='working';
        if(phases[0].status==='working')phases[0].status='unknown';
      }
      if (/^(Feature testing|API test result)/i.test(text)) { active = 2; if(phases[1].status === 'working') phases[1].status = 'done'; phases[2].status = /^Feature testing passed/i.test(text) ? 'done' : /^Feature testing failed/i.test(text) ? 'error' : /^Feature testing not applicable/i.test(text) ? 'not-applicable' : 'working'; }
      phases[active].rows.push(row);
      if (phases[active].status === 'pending') phases[active].status = 'working';
      if (/^(Execution failed:|❌|Pi build failed:|Pi build error:)/.test(text)) phases[active].status = 'error';
      if (/^(Runtime checks passed|✅\s*Validation passed|Validation and publication passed)/i.test(text)) phases[1].status = 'done';
      if (/^(Feature testing completed on the saved app\.|Independent feature run completed\.)/.test(text)) phases[2].status = 'done';
      if (/^(Ticket complete|✅\s*(?:Build complete|Implementation complete))/.test(text)) phases[active].status = 'done';
      if (/cancelled|stopped by user/i.test(text) && /^(Execution|Build|Validation|❌)/.test(text)) phases[active].status = 'stopped';
    }
    const running = ticket && /^(executing|queued|stopping)$/.test(ticket.queueStatus || '');
    if (ticket && !running && phases[active].status === 'working') {
      phases[active].status = ticket.status === 'failed' ? 'error' : ticket.status === 'stopped' ? 'stopped' : 'unknown';
    }
    if (!buildStarted && (ticket?.githubCommitSha || ticket?.github_commit_sha || rows.some(r => /Retrying validation of saved commit|Validation passed.*saved commit/.test(String(r.message || '').replace(/\*\*/g, ''))))) phases[0].status = 'saved';
    return phases;
  }
  function latestFeatureRunCompleted(rows) {
    for(const row of rows.slice().reverse()) {
      const text=String(row.message||'').replace(/\*\*/g,'').trim();
      if(/^(Feature testing completed on the saved app\.|Independent feature run completed\.)/.test(text))return true;
      if(/^(Execution failed:|❌|Starting Pi build|Starting (?:ticket )?build|Building ticket|Retrying validation|Running the saved ticket:|Feature testing:|Feature testing failed)/i.test(text))return false;
    }
    return false;
  }
  const histories = new Map();
  async function load(url, older = false) {
    const history = histories.get(url) || { rows: [], more: false };
    const cursor = older && history.rows[0]?.id;
    const response = await fetch(url + (cursor ? '?before=' + encodeURIComponent(cursor) : ''), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not load action history');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid action history');
    if (older || !histories.has(url)) history.more = rows.length === 20;
    const merged = new Map(history.rows.map(row => [row.id, row]));
    for (const row of rows) merged.set(row.id, row);
    history.rows = Array.from(merged.values()).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    histories.set(url, history);
    return history.rows;
  }
  const choices = new Map();
  function render(area, rows, ticket, key, renderRow, historyUrl, refresh) {
    const liveCards=new Map(Array.from(area.querySelectorAll('.feature-live[data-live-url]'),card=>[card.dataset.liveUrl,card]));
    const previous = area.querySelector('.ticket-phase-body:not([hidden])');
    const scroll = previous ? { top:previous.scrollTop, left:previous.scrollLeft, bottom:previous.scrollHeight-previous.scrollTop-previous.clientHeight<40 } : null;
    const phases = group(rows, ticket);
    area.dataset.phaseView = key;
    const history = histories.get(historyUrl);
    let selected = choices.get(key) || (phases[2].rows.length ? 'feature-testing' : phases[1].rows.length ? 'validation' : 'build');
    const fragment = document.createDocumentFragment();
    const headers = document.createElement('div'); headers.className = 'phase-headers'; headers.setAttribute('role', 'tablist'); headers.setAttribute('aria-label', 'Ticket actions');
    const dock = document.createElement('div'); dock.className = 'feature-browser-dock'; dock.setAttribute('aria-label', 'Feature test browser');
    const bodies = [];
    const buttons = [];
    function select(id) {
      area.classList.remove('feature-logs-open');
      selected = id;
      choices.set(key, selected);
      buttons.forEach((button, i) => { button.setAttribute('aria-selected', String(phases[i].id === selected)); button.tabIndex = phases[i].id === selected ? 0 : -1; });
      bodies.forEach((body, i) => { body.hidden = phases[i].id !== selected; });
      dock.hidden = selected !== 'feature-testing' || !dock.childElementCount;
      area.scrollTop = 0;
    }
    let index = 0;
    for (const phase of phases) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'phase-header';
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(selected === phase.id)); button.tabIndex = selected === phase.id ? 0 : -1;
      const body = document.createElement('div'); body.className = 'ticket-phase-body';
      body.id = 'phase-body-' + key.replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + phase.id;
      button.id = body.id + '-tab'; button.setAttribute('aria-controls', body.id); body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', button.id); body.tabIndex = 0;
      const label = document.createElement('strong'); label.textContent = phase.label;
      const badge = document.createElement('span'); badge.className = 'phase-status phase-' + phase.status;
      const statusLabel = phase.status === 'not-applicable' ? 'Not applicable' : phase.status === 'saved' ? 'Saved code' : phase.status[0].toUpperCase() + phase.status.slice(1);
      badge.title = statusLabel; badge.setAttribute('aria-label', statusLabel); badge.setAttribute('role', 'img');
      const paths = {
        done: '<path d="m5 12 4 4L19 6"/>', saved: '<path d="m5 12 4 4L19 6"/>',
        pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
        error: '<path d="m6 6 12 12M18 6 6 18"/>',
        working: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        unknown: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 4h.01"/>',
        'not-applicable': '<path d="M5 12h14"/>'
      };
      badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[phase.status] || paths.unknown) + '</svg>';
      button.append(label, badge); button.onclick = () => select(phase.id);
      button.onkeydown = event => {
        const current = buttons.indexOf(button);
        const target = event.key === 'ArrowRight' ? (current + 1) % phases.length : event.key === 'ArrowLeft' ? (current + phases.length - 1) % phases.length : event.key === 'Home' ? 0 : event.key === 'End' ? phases.length - 1 : -1;
        if (target >= 0) { event.preventDefault(); select(phases[target].id); buttons[target].focus(); }
      };
      headers.append(button); buttons.push(button);
      if (phase.id === 'feature-testing' && phase.rows.length && !phase.rows.some(r=>/\[(?:Live browser|Watch recording)\]\(/.test(String(r.message||'')))) {
        const summary=document.createElement('p');summary.className='feature-stage-summary';summary.setAttribute('role','status');
        const last=phase.rows.slice().reverse().find(r=>/Feature testing|Execution failed:|❌/.test(String(r.message||'')));
        summary.textContent=(phase.status==='error'?'Testing stopped. ':'')+(last?String(last.message).replace(/\*\*/g,'').slice(0,1000):'Preparing feature tests.')+'\nThe browser has not started recording. Use Show logs for setup and API diagnostics.';
        body.append(summary);
      }
      const latestLive=phase.rows.slice().reverse().find(r=>/\[(?:Live browser|Watch recording)\]\(/.test(String(r.message||'')));
      const displayRows=phase.rows;
      let logHost=body;
      let showLogs=null;
      if(phase.id==='feature-testing' && displayRows.length){
        body.classList.add('feature-log-toolbar');
        const show=document.createElement('button');show.type='button';show.className='feature-show-logs';show.textContent='Show logs';showLogs=show;
        const dialog=document.createElement('section');dialog.className='feature-log-dialog';dialog.hidden=true;dialog.setAttribute('role','region');dialog.setAttribute('aria-label','Feature test logs');
        const heading=document.createElement('header');const title=document.createElement('strong');title.textContent='Feature test logs';
        const close=document.createElement('button');close.type='button';close.textContent='Back to browser';close.onclick=()=>{dialog.hidden=true;area.classList.remove('feature-logs-open');show.hidden=false;};heading.append(title,close);
        const logs=document.createElement('div');logs.className='feature-run-log';dialog.append(heading,logs);show.onclick=()=>{dialog.hidden=false;area.classList.add('feature-logs-open');show.hidden=true;};
        body.append(show,dialog);logHost=logs;
      }
      for (const row of displayRows) {
        logHost.append(renderRow(row, index++));
        const live = String(row.message || '').match(/\[(?:Live browser|Watch recording)\]\((\/uploads\/ticket-tests\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+)\/(?:status\.json|recording\.mp4)\)/);
        if (live && phase.id==='feature-testing' && row===latestLive) {
          const owner=dock;
          const existing=liveCards.get(live[1]);
          if(existing){owner.append(existing);continue;}
          const card=document.createElement('section');card.className='feature-live';card.dataset.liveUrl=live[1];
          const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Connecting live browser…';
          const frame=document.createElement('img');frame.alt='Live view of the feature test browser';frame.hidden=true;
          const replay=document.createElement('video');replay.controls=true;replay.preload='metadata';replay.hidden=true;replay.className='feature-test-video';
          const viewport=document.createElement('div');viewport.className='feature-browser-viewport';const placeholder=document.createElement('p');placeholder.textContent='Waiting for the first browser frame…';viewport.append(placeholder,frame,replay);
          const checklist=document.createElement('ol');checklist.className='feature-browser-checks';checklist.setAttribute('aria-label','Feature test checks');
          const content=document.createElement('div');content.className='feature-browser-content';
          const details=document.createElement('div');details.className='feature-browser-details';details.append(checklist);
          const stage=document.createElement('div');stage.className='feature-review-stage';
          stage.append(status,viewport);content.append(details,stage);
          const enlarge=document.createElement('button');enlarge.type='button';enlarge.className='feature-enlarge';enlarge.textContent='Focus browser';enlarge.onclick=()=>{const expanded=card.classList.toggle('browser-expanded');enlarge.textContent=expanded?'Show assertions':'Focus browser';enlarge.setAttribute('aria-expanded',String(expanded));};card.append(enlarge,content);
          const expandedChecks=new Set();

          owner.append(card);
          let misses=0;
          const poll=async()=>{
            if(!card.isConnected)return;
            if((card.closest('.feature-browser-dock')||card.closest('.ticket-phase-body'))?.hidden){setTimeout(poll,1500);return;}
            try {
              const response=await fetch(live[1]+'/status.json?t='+Date.now(),{credentials:'same-origin',cache:'no-store'});
              if(!response.ok)throw Error('HTTP '+response.status);
              const state=await response.json();misses=0;
              const scrollTop=checklist.scrollTop;
              const focusedCheck=checklist.contains(document.activeElement)?document.activeElement.dataset.check:null;
              checklist.replaceChildren();
              const checks=state.checks||[];
              const counts=document.createElement('li');counts.className='feature-checklist-note';counts.textContent=checks.filter(c=>c.status==='passed').length+' of '+checks.length+' assertions confirmed';checklist.append(counts);
              for(const [index,check] of checks.entries()){
                const outcome=state.status!=='working' && ['pending','working'].includes(check.status)?'not run':check.status;
                const item=document.createElement('li');item.dataset.status=outcome;
                const assertion=document.createElement('button');assertion.type='button';assertion.className='feature-assertion-select';assertion.dataset.check=String(index)+':'+check.label;
                assertion.setAttribute('aria-expanded',String(expandedChecks.has(assertion.dataset.check)));
                const badge=document.createElement('span');badge.className='assertion-outcome';badge.textContent=({passed:'Passed',failed:'Failed',working:'Running',pending:'Not started','not run':'Not run'})[outcome]||outcome;
                const label=document.createElement('span');label.textContent=check.label;assertion.append(badge,label);
                const evidence=document.createElement('div');evidence.className='assertion-evidence';
                for(const [label,value] of [['Expected',check.expected],['Observed',check.actual],['Failure',check.error]])if(value){const p=document.createElement('p');const strong=document.createElement('strong');strong.textContent=label+': ';p.append(strong,document.createTextNode(value));evidence.append(p);}
                if(check.steps?.length){const steps=document.createElement('ol');steps.className='assertion-steps';for(const step of check.steps){const li=document.createElement('li');li.textContent=({passed:'✓',failed:'✕',working:'…'})[step.status]+' '+step.label;if(step.target){const target=document.createElement('small');target.textContent=step.target;li.append(target);}if(step.error){const failure=document.createElement('p');failure.textContent=step.error;li.append(failure);}steps.append(li);}evidence.append(steps);}
                else {const p=document.createElement('p');p.textContent=outcome==='pending'?'Steps will appear when this assertion starts.':outcome==='not run'?'This assertion was not completed before the run ended.':'Step details were not saved for this assertion.';evidence.append(p);}
                evidence.hidden=!expandedChecks.has(assertion.dataset.check);
                evidence.id='check-evidence-'+live[1].split('/').pop()+'-'+index;assertion.setAttribute('aria-controls',evidence.id);
                assertion.onclick=()=>{const key=assertion.dataset.check;if(expandedChecks.has(key))expandedChecks.delete(key);else expandedChecks.add(key);evidence.hidden=!expandedChecks.has(key);assertion.setAttribute('aria-expanded',String(!evidence.hidden));};
                item.append(assertion,evidence);checklist.append(item);
              }
              checklist.scrollTop=scrollTop;
              if(focusedCheck)Array.from(checklist.querySelectorAll('button')).find(b=>b.dataset.check===focusedCheck)?.focus({preventScroll:true});
              if(!checks.length)counts.textContent=state.status==='working'?'Waiting for defined assertions.':'No assertion details were saved for this recording.';

              status.hidden=false;
              const stale=Date.now()-state.updatedAt>45000;
              status.textContent=(state.status==='working'?(stale?'Waiting for browser update — ':'Live — '):state.status==='passed'?'Passed — ':'Attempt '+(state.attempt||'')+' failed — ')+state.step;
              frame.onload=()=>{frame.hidden=false;placeholder.hidden=true;};frame.onerror=()=>{if(frame.hidden)placeholder.textContent='Waiting for browser frames; reconnecting…';};frame.src=live[1]+'/live.jpg?t='+Date.now();
              if(state.status!=='working'){
                frame.hidden=true;frame.onload=null;
                const available=await fetch(live[1]+'/recording.mp4',{method:'HEAD',credentials:'same-origin'});
                if(available.ok){replay.src=live[1]+'/recording.mp4';replay.hidden=false;placeholder.hidden=true;}
                else status.textContent+=' No video was captured for this attempt.';
                return;
              }
            }catch(error){status.hidden=false;misses++;status.textContent='Live view reconnecting — '+error.message+'. Last captured screen retained.';}
            setTimeout(poll,Math.min(10000,1000*Math.max(1,misses)));
          };
          setTimeout(poll,0);
        }

      }
      if(phase.id==='feature-testing' && showLogs && dock.firstElementChild){
        const card=dock.firstElementChild;
        let actions=card.querySelector('.feature-browser-actions');
        if(!actions){
          actions=document.createElement('div');actions.className='feature-browser-actions';
          actions.append(card.querySelector('.feature-enlarge'));card.prepend(actions);
        }
        // Cards survive log refreshes; bind the button to this render's log panel.
        actions.querySelector('.feature-show-logs')?.remove();
        actions.append(showLogs);
        body.classList.add('feature-logs-in-header');
      }
      if (!phase.rows.length) {
        const empty = document.createElement('p'); empty.className = 'phase-empty';
        empty.textContent = phase.status === 'saved' ? 'This ticket already has saved code. This retry reused it.' : 'No logs available for this phase.';
        body.append(empty);
      }
      body.hidden = selected !== phase.id; bodies.push(body);
    }
    dock.hidden = selected !== 'feature-testing' || !dock.childElementCount;
    fragment.append(headers, dock);
    if (history?.more) {
      const note = document.createElement('div'); note.className = 'phase-history-note'; note.setAttribute('role', 'status');
      const more = document.createElement('button'); more.type = 'button';
      more.textContent = history.loading ? 'Loading…' : history.error ? 'Retry loading earlier logs' : 'Load 20 earlier logs';
      more.disabled = !!history.loading;
      more.onclick = async () => {
        if (history.loading) return;
        history.loading = true; history.error = false; more.disabled = true; more.textContent = 'Loading…';
        try { await load(historyUrl, true); }
        catch (_) { history.error = true; }
        finally {
          history.loading = false;
          if (area.isConnected && area.dataset.phaseView === key) render(area, history.rows, ticket, key, renderRow, historyUrl, refresh);
        }
      };
      note.append(more);
      headers.append(note);
    }
    for (const body of bodies) fragment.append(body);
    const restoreLogs=area.classList.contains('feature-logs-open');
    area.classList.remove('feature-logs-open');
    area.replaceChildren(fragment);
    if(restoreLogs&&selected==='feature-testing')area.querySelector('.feature-show-logs')?.click();
    const visible = bodies.find(body => !body.hidden);
    if (visible && scroll) { visible.scrollTop = scroll.bottom ? visible.scrollHeight : scroll.top; visible.scrollLeft = scroll.left; }

  }
  root.TicketActionPhases = { group, render, load, latestFeatureRunCompleted };
})(typeof window === 'undefined' ? globalThis : window);
