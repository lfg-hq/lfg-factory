(() => {
  let pending = null;
  let refreshAgain = false;
  let cached = null;
  let scope = 'chat';
  let context = null;
  const conversation = () => window.currentConversationId || null;
  const el = (tag, text, cls) => { const node=document.createElement(tag); if(text) node.textContent=text; if(cls) node.className=cls; return node; };
  function checklist(epic) {
    const list=el('div',null,'epic-ticket-list');
    list.setAttribute('aria-label', 'Build tickets for '+epic.name);
    for(const ticket of epic.tickets || []) {
      const active=['executing','stopping'].includes(ticket.queueStatus) || ticket.status==='in_progress';
      const failed=['failed','blocked','stopped'].includes(ticket.status);
      const done=['done','review','archived'].includes(ticket.status);
      const state=active?'active':failed?'failed':done?'done':'pending';
      const label=active?'In progress':failed?'Needs attention':ticket.status==='review'?'Ready for review':done?'Completed':'Pending';
      const row=el('button',null,'epic-ticket-row');row.type='button';row.dataset.state=state;
      const icon=el('span',active?'•••':failed?'!':'✓','epic-ticket-icon');icon.setAttribute('aria-hidden','true');
      const title=el('span',null,'epic-ticket-title');title.append(el('small',ticket.ticketKey || ''),el('span',ticket.name));
      row.append(icon,title,el('small',label,'epic-ticket-state'));
      row.onclick=()=>window.TicketAgentChat?.open(String(ticket.id),ticket.ticketKey || '',ticket.name || '',{
        description:ticket.description || '',status:ticket.status || 'open',priority:ticket.priority || 'Medium',
        createdAt:ticket.createdAt,updatedAt:ticket.updatedAt,attachments:ticket.attachments || []
      });
      list.append(row);
    }
    if(epic.buildMode==='single-ticket'){
      const tasks=el('ol',null,'epic-implementation-tasks');tasks.setAttribute('aria-label','Implementation checklist');
      for(const task of epic.implementationTasks || []){
        const done=['success','completed','done'].includes(task.status);
        const paused=epic.buildStatus==='Needs attention';
        const active=task.status==='in_progress' && !paused;
        const row=el('li');row.dataset.state=done?'done':active?'active':'pending';
        row.append(el('span',done?'✓':active?'•••':'○','epic-ticket-icon'),el('span',task.description),el('small',done?'Done':active?'In progress':paused && task.status==='in_progress'?'Paused':'Pending'));
        tasks.append(row);
      }
      list.append(tasks);
    }
    return list;
  }
  function renderChatProgress() {
    const host=document.querySelector('#chat-messages .message-container') || document.querySelector('.message-container');
    if(!host || !cached)return;
    const mine=(cached.epics || []).filter(e=>conversation() && e.conversationId===conversation() && e.tickets?.length);
    const existing=[...host.querySelectorAll('.epic-chat-progress')];
    for(const old of existing) if(!mine.some(e=>e.id===old.dataset.epicId))old.remove();
    for(const epic of mine) {
      let card=existing.find(e=>e.dataset.epicId===epic.id);
      const signature=JSON.stringify([epic.tickets,epic.implementationTasks,epic.buildStatus]);
      if(card?.dataset.signature===signature)continue;
      if(!card){card=el('article',null,'epic-chat-progress');card.dataset.epicId=epic.id;host.append(card);}
      card.dataset.signature=signature;
      card.replaceChildren(el('h4',epic.name),el('p',(epic.buildStatus || 'Build progress')+' · '+(epic.epicKey || ''),'chat-epics-intro'),checklist(epic));
    }
  }
  window.loadChatEpics = function(projectId) {
    const current = conversation();
    if (context !== current) { context = current; scope = 'chat'; }
    if (pending) { refreshAgain=true; return pending; }
    const host=document.getElementById('checklist');
    if(!host || document.body.dataset.epicBuilds !== 'true') return;
    pending=fetch('/api/projects/'+encodeURIComponent(projectId)+'/epics').then(r=>{if(!r.ok) throw Error('Could not load features');return r.json();}).then(data=>{ cached=data; render(projectId); }).catch(e=>{host.replaceChildren(el('p',e.message));const retry=el('button','Retry','btn btn-secondary');retry.onclick=()=>window.loadChatEpics(projectId);host.append(retry);}).finally(()=>{pending=null;if(refreshAgain){refreshAgain=false;window.loadChatEpics(projectId);}});
    return pending;
  };
  function render(projectId) {
      const host=document.getElementById('checklist');
      if(!host || !cached)return;
      const data=cached;
      const content=el('div',null,'chat-epics');
      const header=el('div',null,'chat-epics-header');header.append(el('h3','Epics'));
      const refresh=el('button','Refresh','btn btn-secondary');refresh.onclick=()=>window.loadChatEpics(projectId);header.append(refresh);content.append(header,el('p','Plan the scope in chat, approve it, then follow the build here.','chat-epics-intro'));
      const filter=el('select');filter.setAttribute('aria-label','Filter epics');
      for(const [value,label] of [['chat','This chat'],['all','All project epics']]) { const option=el('option',label);option.value=value;filter.append(option); }
      filter.value=scope;
      filter.onchange=()=>{scope=filter.value;render(projectId);};
      header.insertBefore(filter,refresh);
      const epics=(data.epics || []).filter(epic=>scope==='all' || (conversation() && epic.conversationId===conversation()));
      if(!epics.length) content.append(el('p',scope==='chat'?'No epics created in this chat yet. Describe a feature here, or select All project epics.':'No epics in this project yet. Describe a feature in chat to start.','chat-epics-empty'));
      for(const epic of epics) {
        const card=el('article',null,'chat-epic');card.append(el('h4',epic.name));
        if(epic.goal) card.append(el('p',epic.goal));
        const percent=epic.ticketCount ? Math.round(100*epic.ticketsBuilt/epic.ticketCount) : 0;
        const status=epic.buildStatus || (epic.status==='draft' ? 'Planning' : epic.status.replaceAll('_',' '));
        card.dataset.status=status;
        card.append(el('span',status,'chat-epic-status'));
        if(epic.currentActivity) card.append(el('p','Now: '+epic.currentActivity));
        if(epic.ticketCount && epic.buildMode!=='single-ticket') { const progress=el('progress');progress.max=100;progress.value=percent;progress.setAttribute('aria-label',percent+'% ready for review');card.append(progress,el('small',percent+'% ready for review')); }
        if(epic.tickets?.length) card.append(checklist(epic));
        if(epic.docs?.length) {
          const docs=el('div',null,'chat-epic-docs');docs.append(el('h5','Documents'));
          for(const doc of epic.docs) {
            const open=el('button',doc.name,'chat-epic-document');open.type='button';
            open.onclick=()=>{if(window.viewFileContent)window.viewFileContent(doc.id,doc.name);else window.ArtifactsLoader?.loadFileBrowser(projectId,{openFileId:doc.id,openFileName:doc.name});};
            docs.append(open);
          }
          card.append(docs);
        }
        if(epic.activity?.length) {
          const activity=el('div',null,'chat-epic-activity');
          activity.append(el('h5',status==='Building'?'Live build activity':'Recent build activity'));
          for(const item of epic.activity.slice(-5)) {
            const row=el('div',null,'chat-epic-event');
            row.dataset.failed=String(item.type==='cli_error' || (item.exitCode!=null && item.exitCode!==0));
            row.append(el('span',item.message));
            const time=el('time',new Date(item.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));row.append(time);
            if(item.output) {const details=el('details');details.append(el('summary','Details'),el('pre',item.output));row.append(details);}
            activity.append(row);
          }
          card.append(activity);
        }
        const actions=el('div',null,'chat-epic-actions');

        if(epic.previewUrl) {try {const url=new URL(epic.previewUrl);if(['http:','https:'].includes(url.protocol)){const preview=el('button','Open preview','chat-epic-review');preview.onclick=()=>{document.querySelector('[data-tab="preview"]')?.click();window.PreviewTab?.open();};actions.append(preview);}}catch{}}
        if(data.epicBuildsEnabled && data.canBuildEpics && !['merged','rejected','approved'].includes(epic.status) && !['Building','Validating'].includes(epic.buildStatus)) {
          const needsAttention=epic.buildStatus==='Needs attention';
          const ready=epic.buildStatus==='Ready for review';
          const build=el('button',needsAttention?'Review build issue':ready?'Review results':'Discuss requirements','chat-epic-review');
          card.append(el('p',needsAttention?'Review what stopped the build and decide what to do next.':ready?'Review the result in chat or test the preview.':'Ask the agent to summarize the scope here in this chat. No build starts until you approve.','chat-epic-hint'));
          build.onclick=()=>window.__sendChatMessage__?.(
            'For epic '+epic.epicKey+' ('+epic.id+'), '+
            (needsAttention?'explain what stopped the build and propose the next step':ready?'summarize the results and how I can test the feature':'review its saved requirements and documents, summarize the scope and acceptance criteria, and identify anything missing')+
            '. Ask for my approval before starting or resuming any build.');
          actions.append(build);
        }
        card.append(actions);content.append(card);
      }
      host.replaceChildren(content);
      renderChatProgress();
  }
  document.addEventListener('DOMContentLoaded',()=>{
    if(document.body.dataset.epicBuilds!=='true')return;
    const project=document.body.dataset.projectId;
    window.loadChatEpics(project);
    // History loading replaces message nodes; restore the persisted build checklist afterwards.
    const messages=document.getElementById('chat-messages');
    if(messages) new MutationObserver(()=>renderChatProgress()).observe(messages,{childList:true,subtree:true});
    document.querySelector('[data-tab="checklist"]')?.addEventListener('click',()=>window.loadChatEpics(project));
    // Reuse app updates and focus, rather than a second polling loop.
    window.addEventListener('chat-conversation-changed',()=>{if(context===conversation())return;context=conversation();scope='chat';if(cached)render(project);window.loadChatEpics(project);});
    window.addEventListener('focus',()=>window.loadChatEpics(project));
    let refreshTimer;
    window.addEventListener('epic-build-update',()=>{if(refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=null;window.loadChatEpics(project);},1000);});
  });
})();
