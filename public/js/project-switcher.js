(() => {
  function init() {
    const trigger = document.querySelector('#sidebar .project-dropdown-trigger');
    if (!trigger || document.getElementById('project-switcher')) return;
    const current = document.getElementById('sidebar')?.dataset.currentProjectId || document.body.dataset.projectId;
    trigger.setAttribute('aria-label','Switch project'); trigger.setAttribute('aria-haspopup','dialog'); trigger.setAttribute('aria-expanded','false');
    trigger.title = 'Switch project';
    const label = trigger.querySelector('.project-name-text'); if (label) label.textContent = 'Switch project';
    const panel = document.createElement('section'); panel.id='project-switcher'; panel.hidden=true;
    panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','Switch project'); trigger.setAttribute('aria-controls',panel.id);
    const heading=document.createElement('strong'); heading.textContent='Switch project';
    const search=document.createElement('input'); search.type='search'; search.placeholder='Search projects…'; search.setAttribute('aria-label','Search projects');
    const list=document.createElement('div'); list.className='project-switcher-list'; list.setAttribute('aria-live','polite');
    const all=document.createElement('a'); all.href='/projects'; all.className='project-switcher-all'; all.textContent='View all projects';
    panel.append(heading,search,list,all); document.body.append(panel);
    let projects=[], loaded=false, loading=false;
    function position() {const r=trigger.getBoundingClientRect(); panel.style.left=Math.max(8,Math.min(r.right+10,innerWidth-Math.min(300,innerWidth-16)-8))+'px'; panel.style.top=Math.max(8,Math.min(r.top,innerHeight-420))+'px';}
    function close(restore=false){panel.hidden=true;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus();}
    function render(){
      list.replaceChildren();
      const found=projects.filter(p=>p.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      for(const p of found){
        const row=document.createElement('a');row.href='/chat/project/'+encodeURIComponent(p.id);row.className='project-switcher-row';
        if(p.id===current){row.classList.add('is-current');row.setAttribute('aria-current','page');}
        const name=document.createElement('span');name.className='project-switcher-name';name.textContent=p.name;name.title=p.name;
        row.append(name);
        if(p.id===current){const check=document.createElement('span');check.textContent='✓';check.setAttribute('aria-label','Current project');row.append(check);}
        if(p.unread>0){const badge=document.createElement('span');badge.className='project-switcher-badge';badge.textContent=p.unread>99?'99+':String(p.unread);badge.setAttribute('aria-label',p.unread+' unread notifications');row.append(badge);}
        list.append(row);
      }
      if(!found.length){const empty=document.createElement('p');empty.textContent=projects.length?'No matching projects.':'No projects yet.';list.append(empty);}
    }
    async function refresh(){
      if(loading)return;loading=true;
      if(!loaded)list.textContent='Loading projects…';
      try{const response=await fetch('/api/project-switcher',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('load');const data=await response.json();projects=data.projects;loaded=true;render();}
      catch{list.replaceChildren();const error=document.createElement('p');error.textContent='Could not load projects.';const retry=document.createElement('button');retry.type='button';retry.textContent='Try again';retry.onclick=refresh;list.append(error,retry);}
      finally{loading=false;}
    }
    trigger.addEventListener('click',e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();e.stopPropagation();if(!panel.hidden){close();return;}panel.hidden=false;trigger.setAttribute('aria-expanded','true');search.value='';position();search.focus();if(loaded)render();refresh();});
    search.addEventListener('input',render);
    panel.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();close(true);}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        const items=[search,...list.querySelectorAll('a,button'),all];let index=items.indexOf(document.activeElement);index=(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;e.preventDefault();items[index].focus();
      }
    });
    document.addEventListener('click',e=>{if(!panel.contains(e.target)&&!trigger.contains(e.target))close();});
    document.addEventListener('focusin',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!trigger.contains(e.target))close();});
    window.addEventListener('resize',()=>{if(!panel.hidden)position();});
    window.addEventListener('focus',()=>{if(!panel.hidden)refresh();});
    window.addEventListener('project-notifications-changed',()=>{if(!panel.hidden)refresh();});
    setInterval(()=>{if(!panel.hidden&&!document.hidden)refresh();},15000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
