(() => {
  let pending = null;
  const el = (tag, text, cls) => { const node=document.createElement(tag); if(text) node.textContent=text; if(cls) node.className=cls; return node; };
  window.loadChatEpics = function(projectId) {
    if (pending) return pending;
    const host=document.getElementById('checklist');
    if(!host || document.body.dataset.epicBuilds !== 'true') return;
    pending=fetch('/api/projects/'+encodeURIComponent(projectId)+'/epics').then(r=>{if(!r.ok) throw Error('Could not load features');return r.json();}).then(data=>{
      const content=el('div',null,'chat-epics');
      const header=el('div',null,'chat-epics-header');header.append(el('h3','Epics'));
      const refresh=el('button','Refresh','btn btn-secondary');refresh.onclick=()=>window.loadChatEpics(projectId);header.append(refresh);content.append(header);
      if(!data.epics?.length) content.append(el('p','Describe a feature in chat to start its requirements and plan.'));
      for(const epic of data.epics || []) {
        const card=el('article',null,'chat-epic');card.append(el('h4',epic.name));
        if(epic.goal) card.append(el('p',epic.goal));
        const percent=epic.ticketCount ? Math.round(100*epic.ticketsBuilt/epic.ticketCount) : 0;
        const status=epic.buildStatus || (epic.status==='draft' ? 'Planning' : epic.status.replaceAll('_',' '));
        card.append(el('span',status,'chat-epic-status'));
        if(epic.currentActivity) card.append(el('p','Now: '+epic.currentActivity));
        if(epic.ticketCount) { const progress=el('progress');progress.max=100;progress.value=percent;progress.setAttribute('aria-label',percent+'% ready for review');card.append(progress,el('small',percent+'% ready for review')); }
        const actions=el('div',null,'chat-epic-actions');
        const open=el('a','View feature');open.href='/projects/'+encodeURIComponent(projectId)+'/epics?epic='+encodeURIComponent(epic.id);actions.append(open);
        if(epic.previewUrl) {try {const url=new URL(epic.previewUrl);if(['http:','https:'].includes(url.protocol)){const preview=el('a','Test preview ↗');preview.href=url.href;preview.target='_blank';preview.rel='noopener';actions.append(preview);}}catch{}}
        if(data.epicBuildsEnabled && data.canBuildEpics && !['merged','rejected','approved'].includes(epic.status) && epic.buildStatus !== 'Building') {
          const build=el('button',epic.buildStatus==='Needs attention'?'Resume build':'Build feature','btn btn-primary');
          build.onclick=()=>window.__sendChatMessage__?.('I approve building the documented requirements for epic '+epic.epicKey+' ('+epic.id+'). Please '+(epic.buildStatus==='Needs attention'?'resume':'build')+' this feature and provide its preview.');
          actions.append(build);
        }
        card.append(actions);content.append(card);
      }
      host.replaceChildren(content);
    }).catch(e=>{host.replaceChildren(el('p',e.message));const retry=el('button','Retry','btn btn-secondary');retry.onclick=()=>window.loadChatEpics(projectId);host.append(retry);}).finally(()=>pending=null);
    return pending;
  };
  document.addEventListener('DOMContentLoaded',()=>{
    if(document.body.dataset.epicBuilds!=='true')return;
    const project=document.body.dataset.projectId;
    window.loadChatEpics(project);
    document.querySelector('[data-tab="checklist"]')?.addEventListener('click',()=>window.loadChatEpics(project));
    // Reuse app updates and focus, rather than a second polling loop.
    window.addEventListener('focus',()=>window.loadChatEpics(project));
    window.addEventListener('epic-build-update',()=>window.loadChatEpics(project));
  });
})();
