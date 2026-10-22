/* Shared by the ticket drawer and the chat ticket panel. No log content is discarded. */
(function (root) {
  function group(rows, ticket) {
    const phases = [{ id: 'build', label: 'Build', status: 'pending', rows: [] }, { id: 'validation', label: 'Validation', status: 'pending', rows: [] }, { id: 'feature-testing', label: 'Feature testing', status: 'pending', rows: [] }];
    let active = 0;
    let buildStarted = false;
    for (const original of rows) {
      const tag=String(original.message||'').match(/^\[(Validation|Feature testing)\] /);
      const row=tag?{...original,message:original.message.slice(tag[0].length)}:original;
      if(tag)active=tag[1]==='Validation'?1:2;
      const text = String(row.message || '').replace(/\*\*/g, '').trim();
      if (/^(Running a sandbox command|The same repair session is still active\.)$/.test(text)) continue;
      const retry = /^Retrying validation of saved commit/i.test(text);
      const validation = tag?.[1]==='Validation' || /^Validation check:|^Validation connection interrupted:|^Checking prerequisite:|^(App|Preview) readiness|^Preview ready|^Checks skip|^Checks:|^Checks could not run/i.test(text) || retry || /^(Running the saved ticket:|Repairing runtime checks:|Checking:|Preparing validation:|Now verifying this commit|Fresh \/ candidate:|Runtime checks passed|✅\s*Validation passed)/i.test(text);
      // A ticket follow-up (a change or repair sent to a built ticket) is new build work.
      const build = /^(Starting Pi build|Isolated build:|Starting (?:ticket )?build|Building ticket|Chat follow-up$|Refreshing ticket from )/i.test(text);
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
      if(/^Validation connection interrupted:/i.test(text))phases[active].status='error';
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
  const PAGE = 250;
  async function load(url, older = false) {
    const history = histories.get(url) || { rows: [], more: false };
    const cursor = older && history.rows[0]?.id;
    // Large pages keep a whole build and its checks in one window, so phases group correctly.
    const response = await fetch(url + '?limit=' + PAGE + (cursor ? '&before=' + encodeURIComponent(cursor) : ''), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not load action history');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid action history');
    if (older || !histories.has(url)) history.more = rows.length === PAGE;
    const merged = new Map(history.rows.map(row => [row.id, row]));
    for (const row of rows) merged.set(row.id, row);
    history.rows = Array.from(merged.values()).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    histories.set(url, history);
    return history.rows;
  }
  const choices = new Map();
  // The build log shows its latest rows; scrolling up reveals older ones a page at a time.
  const SHOW = 20;
  const shown = new Map();
  const anchors = new Map();
  // Remember whether the reader opened or closed diagnostics; refreshes must not undo it.
  const diagnosticsOpen = new Map();
  function render(area, rows, ticket, key, renderRow, historyUrl, refresh) {
    const liveCards=new Map(Array.from(area.querySelectorAll('.feature-live[data-live-url]'),card=>[card.dataset.liveUrl,card]));
    const previous = area.querySelector('.checks-view:not([hidden])') || area.querySelector('.ticket-phase-body:not([hidden])');
    const scroll = previous ? { top:previous.scrollTop, left:previous.scrollLeft, bottom:previous.scrollHeight-previous.scrollTop-previous.clientHeight<40 } : null;
    const grouped = group(rows, ticket);
    const stageShown = phase => phase.id === 'build' || (phase.id === 'validation' ? ticket?.validationEnabled !== false : ticket?.featureTestingEnabled !== false);
    // A hidden check stage never hides its rows: they read under Build, in order.
    const hiddenRows = grouped.filter(phase => !stageShown(phase)).flatMap(phase => phase.rows);
    if (hiddenRows.length) {
      const order = new Map(rows.map((row, i) => [row.id, i]));
      grouped[0].rows = grouped[0].rows.concat(hiddenRows).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    const phases = grouped.filter(stageShown);
    area.dataset.phaseView = key;
    const history = histories.get(historyUrl);
    // Validation and feature testing read as one Checks stage: app startup, then the
    // browser walkthrough. Their rows stay separate underneath; only the tabs merge.
    const checkIds = ['validation', 'feature-testing'];
    const tabOf = id => checkIds.includes(id) ? 'checks' : id;
    const checkPhases = phases.filter(phase => checkIds.includes(phase.id));
    const running = ticket && /^(executing|queued|stopping)$/.test(ticket.queueStatus || '');
    const combined = list => {
      const statuses = list.map(phase => phase.status);
      if (statuses.includes('error')) return 'error';
      if (statuses.includes('stopped')) return 'stopped';
      if (statuses.includes('working')) return 'working';
      if (statuses.every(status => ['done', 'not-applicable', 'saved'].includes(status))) return 'done';
      if (statuses.some(status => status === 'done')) return running ? 'working' : 'pending';
      return statuses.every(status => status === 'pending') ? 'pending' : 'unknown';
    };
    const tabs = [{ id: 'build', label: 'Build', status: phases[0].status, members: ['build'] }];
    if (checkPhases.length) tabs.push({ id: 'checks', label: 'Checks', status: combined(checkPhases), members: checkPhases.map(phase => phase.id) });
    let selected = tabOf(choices.get(key) || phases.slice().reverse().find(phase => phase.rows.length)?.id || 'build');
    if (!tabs.some(tab => tab.id === selected)) selected = 'build';
    const fragment = document.createDocumentFragment();
    const headers = document.createElement('div'); headers.className = 'phase-headers'; headers.setAttribute('role', 'tablist'); headers.setAttribute('aria-label', 'Ticket actions');
    const dock = document.createElement('div'); dock.className = 'feature-browser-dock'; dock.setAttribute('aria-label', 'Feature test browser');
    const bodies = [];
    const buttons = [];
    function select(id) {
      area.classList.remove('feature-logs-open');
      selected = id;
      choices.set(key, selected);
      buttons.forEach((button, i) => { button.setAttribute('aria-selected', String(tabs[i].id === selected)); button.tabIndex = tabs[i].id === selected ? 0 : -1; });
      bodies.forEach((body, i) => { body.hidden = tabOf(phases[i].id) !== selected; });
      dock.hidden = !dock.childElementCount;
      if (checksView) checksView.hidden = selected !== 'checks';
      // Paging applies to the build log only.
      const note = headers.querySelector('.phase-history-note'); if (note) note.hidden = selected !== 'build';
      area.scrollTop = 0;
      const body = bodies.find(b => !b.hidden); if (body && id === 'build') body.scrollTop = body.scrollHeight;
    }
    for (const tab of tabs) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'phase-header';
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(selected === tab.id)); button.tabIndex = selected === tab.id ? 0 : -1;
      button.id = 'phase-tab-' + key.replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + tab.id;
      const label = document.createElement('strong'); label.textContent = tab.label;
      const badge = document.createElement('span'); badge.className = 'phase-status phase-' + tab.status;
      const statusLabel = tab.status === 'not-applicable' ? 'Not applicable' : tab.status === 'saved' ? 'Saved code' : tab.status[0].toUpperCase() + tab.status.slice(1);
      badge.title = statusLabel; badge.setAttribute('aria-label', statusLabel); badge.setAttribute('role', 'img');
      const paths = {
        done: '<path d="m5 12 4 4L19 6"/>', saved: '<path d="m5 12 4 4L19 6"/>',
        pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
        error: '<path d="m6 6 12 12M18 6 6 18"/>',
        working: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        unknown: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 4h.01"/>',
        'not-applicable': '<path d="M5 12h14"/>'
      };
      badge.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[tab.status] || paths.unknown) + '</svg>';
      button.append(label, badge); button.onclick = () => select(tab.id);
      button.onkeydown = event => {
        const current = buttons.indexOf(button);
        const target = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (target >= 0) { event.preventDefault(); select(tabs[target].id); buttons[target].focus(); }
      };
      headers.append(button); buttons.push(button);
    }
    let index = 0;
    for (const phase of phases) {
      const body = document.createElement('div'); body.className = 'ticket-phase-body';
      body.id = 'phase-body-' + key.replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + phase.id;
      body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', 'phase-tab-' + key.replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + tabOf(phase.id)); body.tabIndex = 0;
      if (phase.id === 'feature-testing' && phase.rows.length && !phase.rows.some(r=>/\[(?:Live browser|Watch recording)\]\(/.test(String(r.message||'')))) {
        const summary=document.createElement('p');summary.className='feature-stage-summary';summary.setAttribute('role','status');
        const last=phase.rows.slice().reverse().find(r=>/Feature testing|Execution failed:|❌/.test(String(r.message||'')));
        summary.textContent=(phase.status==='error'?'Testing stopped. ':'')+(last?String(last.message).replace(/\*\*/g,'').slice(0,1000):'Preparing feature tests.')+'\nThe browser has not started recording. Use Show logs for setup and API diagnostics.';
        body.append(summary);
      }
      const latestLive=phase.rows.slice().reverse().find(r=>/\[(?:Live browser|Watch recording)\]\(/.test(String(r.message||'')));
      const checks=new Map();
      for(const row of phase.rows){
        if(!String(row.message||'').startsWith('Validation check: '))continue;
        try{const c=JSON.parse(row.message.slice(18));if(typeof c.id==='string'&&typeof c.label==='string'&&['pending','running','passed','failed','blocked'].includes(c.status))checks.set(c.id,c);}catch{}
      }
      // Inside Checks, startup sits above the browser walkthrough and takes only its own height.
      if(phase.id==='validation')body.classList.add('checks-startup');
      // Slow or stuck checks can be skipped: the build is already committed.
      if(phase===checkPhases[0] && running && combined(checkPhases)==='working' && historyUrl){
        const bar=document.createElement('div');bar.className='checks-skip-bar';
        const note=document.createElement('span');note.textContent='The build is already committed. Skipping stops the checks and moves on to the next ticket.';
        const skip=document.createElement('button');skip.type='button';skip.className='checks-skip';skip.textContent='Skip checks';
        skip.onclick=async()=>{
          skip.disabled=true;skip.textContent='Skipping…';
          try{const r=await fetch(historyUrl.replace(/\/logs$/,'/skip-checks'),{method:'POST',credentials:'same-origin'});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Could not skip checks');note.textContent='Skipping: the current check stops in a few seconds.';}
          catch(error){skip.disabled=false;skip.textContent='Skip checks';note.textContent=error.message;}
        };
        bar.append(note,skip);body.append(bar);
      }
      if(checks.size){
        const list=document.createElement('ul');list.className='validation-checklist';list.setAttribute('aria-label','Validation checks');
        for(const check of checks.values()){
          const item=document.createElement('li');item.dataset.status=check.status;
          const icon=document.createElement('span');icon.textContent=({pending:'○',running:'…',passed:'✓',failed:'×',blocked:'!'})[check.status];icon.setAttribute('aria-hidden','true');
          const name=document.createElement('span');name.textContent=check.label;
          const state=document.createElement('small');state.textContent=check.status==='blocked'?'Connection problem':check.status;
          item.append(icon,name,state);list.append(item);
        }
        body.append(list);
      }
      const displayRows=phase.rows.filter(row=>!String(row.message||'').startsWith('Validation check: '));
      let logHost=body;
      let showLogs=null;
      if(phase.id==='validation'&&displayRows.length){
        const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Startup logs';details.append(summary);
        // A failed validation opens by default: the reason lives in these rows.
        details.open=diagnosticsOpen.has(key)?diagnosticsOpen.get(key):phase.status==='error';
        details.addEventListener('toggle',()=>diagnosticsOpen.set(key,details.open));const logs=document.createElement('div');details.append(logs);body.append(details);logHost=logs;
      }
      if(phase.id==='feature-testing' && displayRows.length){
        const details=document.createElement('details');details.className='checks-logs';const summary=document.createElement('summary');summary.textContent='Browser test logs';details.append(summary);
        const open=diagnosticsOpen.get(key+':feature');details.open=!!open;details.addEventListener('toggle',()=>diagnosticsOpen.set(key+':feature',details.open));
        const logs=document.createElement('div');logs.className='feature-run-log';details.append(logs);body.append(details);logHost=logs;
      }
      let visibleRows = displayRows;
      if (phase.id === 'build') {
        const limit = shown.get(key) || SHOW;
        visibleRows = displayRows.slice(Math.max(0, displayRows.length - limit));
        if (visibleRows.length < displayRows.length || history?.more) {
          const older = document.createElement('p'); older.className = 'phase-older';
          older.textContent = history?.loading ? 'Loading earlier logs…' : 'Scroll up for earlier logs';
          body.append(older);
          body.addEventListener('scroll', () => {
            if (body.scrollTop > 40 || body.dataset.revealing) return;
            body.dataset.revealing = '1';
            anchors.set(key, body.scrollHeight - body.scrollTop);
            // Rows arrive already shaped by the caller; after fetching older ones, let it reshape them.
            const reveal = (fetched) => { if (!area.isConnected || area.dataset.phaseView !== key) return; if (fetched && refresh) refresh(); else render(area, rows, ticket, key, renderRow, historyUrl, refresh); };
            if (visibleRows.length < displayRows.length) { shown.set(key, limit + SHOW); reveal(); }
            else if (history?.more && !history.loading) {
              history.loading = true; older.textContent = 'Loading earlier logs…';
              shown.set(key, limit + SHOW);
              load(historyUrl, true).catch(() => { history.error = true; }).finally(() => { history.loading = false; reveal(true); });
            }
          }, { passive: true });
        }
      }
      for (const row of visibleRows) {
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
          const enlarge=document.createElement('button');enlarge.type='button';enlarge.className='feature-enlarge';enlarge.textContent='Focus browser';enlarge.onclick=()=>{const expanded=card.classList.toggle('browser-expanded');enlarge.textContent=expanded?'Show assertions':'Focus browser';enlarge.setAttribute('aria-expanded',String(expanded));};card.append(content);
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
              status.textContent=(state.status==='working'?(stale?'Waiting for browser update — ':'Live — '):state.status==='passed'?'Passed — ':(state.attempt>1?'Attempt '+state.attempt+' failed — ':'Failed — '))+state.step;
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
      body.hidden = tabOf(phase.id) !== selected; bodies.push(body);
    }
    // Checks read top to bottom in one scroll: outcome, app startup, the browser walkthrough, then logs.
    let checksView = null;
    if (checkPhases.length) {
      checksView = document.createElement('div'); checksView.className = 'checks-view'; checksView.hidden = selected !== 'checks';
      checksView.setAttribute('role', 'tabpanel');
      const all = checkPhases.flatMap(phase => phase.rows);
      const text = row => String(row.message || '').replace(/^\[(Validation|Feature testing)\]\s*/, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
      const skipped = all.some(row => /^(\*\*)?Checks skip/i.test(String(row.message || '')));
      const overall = combined(checkPhases);
      const failure = all.slice().reverse().find(row => /^(\*\*)?(Feature testing failed|Validation failed|Checks failed|Checks could not run|Runtime checks failed)/i.test(String(row.message || '')));
      const verdict = skipped ? ['skipped', 'Checks were skipped', 'The saved build continued without them.']
        : overall === 'done' ? ['done', 'Checks passed', 'The app started and the feature behaved as its acceptance criteria describe.']
        : overall === 'error' ? ['error', 'Checks failed', failure ? text(failure).replace(/^(Feature testing failed|Validation failed|Checks failed)\.?\s*/i, '').slice(0, 240) : 'See the step that failed below.']
        : overall === 'working' ? ['working', 'Checks are running', 'The app is starting and the feature is being exercised in a browser.']
        : ['pending', 'Checks have not run', 'They run after the build is saved.'];
      const banner = document.createElement('div'); banner.className = 'checks-banner'; banner.dataset.state = verdict[0]; banner.setAttribute('role', 'status');
      const title = document.createElement('strong'); title.textContent = verdict[1];
      const detail = document.createElement('span'); detail.textContent = verdict[2];
      banner.append(title, detail); checksView.append(banner);
      const stepState = phase => skipped && phase.status !== 'done' ? ['skipped', 'Skipped'] : ({ done:['done','Passed'], error:['error','Failed'], working:['working','Running'], 'not-applicable':['done','Not needed'], saved:['skipped','Skipped'] })[phase.status] || ['pending','Not run'];
      let number = 0;
      for (const phase of checkPhases) {
        const step = document.createElement('section'); step.className = 'checks-step';
        const head = document.createElement('header');
        const [state, label] = stepState(phase); step.dataset.state = state;
        const name = document.createElement('strong'); name.textContent = (++number) + '. ' + (phase.id === 'validation' ? 'App starts' : 'Feature walkthrough');
        const pill = document.createElement('span'); pill.className = 'checks-pill'; pill.textContent = label;
        head.append(name, pill); step.append(head);
        if (phase.id === 'feature-testing') step.append(dock);
        step.append(bodies[phases.indexOf(phase)]);
        checksView.append(step);
      }
    }
    dock.hidden = !dock.childElementCount;
    fragment.append(headers);
    if (history?.more) {
      const note = document.createElement('div'); note.className = 'phase-history-note'; note.setAttribute('role', 'status'); note.hidden = selected !== 'build';
      const more = document.createElement('button'); more.type = 'button';
      more.textContent = history.loading ? 'Loading…' : history.error ? 'Retry loading earlier logs' : 'Load earlier logs';
      more.disabled = !!history.loading;
      more.onclick = async () => {
        if (history.loading) return;
        history.loading = true; history.error = false; more.disabled = true; more.textContent = 'Loading…';
        try { await load(historyUrl, true); }
        catch (_) { history.error = true; }
        finally {
          history.loading = false;
          if (area.isConnected && area.dataset.phaseView === key) { if (refresh) refresh(); else render(area, history.rows, ticket, key, renderRow, historyUrl, refresh); }
        }
      };
      note.append(more);
      headers.append(note);
    }
    for (const [i, body] of bodies.entries()) if (!checkIds.includes(phases[i].id)) fragment.append(body);
    if (checksView) fragment.append(checksView);
    const restoreLogs=area.classList.contains('feature-logs-open');
    area.classList.remove('feature-logs-open');
    area.replaceChildren(fragment);
    if(restoreLogs&&selected==='checks')area.querySelector('.feature-show-logs')?.click();
    const visible = checksView && !checksView.hidden ? checksView : bodies.find(body => !body.hidden);
    const anchor = anchors.get(key); anchors.delete(key);
    // Opening a ticket lands on its latest activity; revealing older rows keeps the reader's place.
    if (visible && anchor != null) visible.scrollTop = visible.scrollHeight - anchor;
    else if (visible && scroll) { visible.scrollTop = scroll.bottom ? visible.scrollHeight : scroll.top; visible.scrollLeft = scroll.left; }
    else if (visible && visible !== checksView) visible.scrollTop = visible.scrollHeight;

  }
  root.TicketActionPhases = { group, render, load, latestFeatureRunCompleted };
})(typeof window === 'undefined' ? globalThis : window);
