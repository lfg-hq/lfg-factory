(() => {
  'use strict';
  const el = (tag, text, cls) => { const n=document.createElement(tag); if(text)n.textContent=text; if(cls)n.className=cls; return n; };
  const svg = (tag, attrs) => { const n=document.createElementNS('http://www.w3.org/2000/svg',tag); for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v)); return n; };
  let sequence=0;
  window.TicketMap = {
    mount(projectId, root) {
      const header=root.querySelector('.checklist-header'); if(!header)return;
      const button=el('button','Ticket map'); button.id='ticket-map-open';button.type='button';
      const titlebar=el('div',null,'ticket-map-heading');titlebar.append(el('h3','Tickets'),button);header.before(titlebar);
      button.onclick=()=>open(projectId,root.querySelector('#epic-filter')?.value,button);
    }
  };
  function open(projectId,initialEpic,trigger) {
    const dialog=el('dialog',null,'document-graph-dialog ticket-map-dialog');dialog.setAttribute('aria-label','Ticket dependency map');
    const header=el('header'), heading=el('div'), close=el('button','Close');
    heading.append(el('h2','Ticket map'),el('p','Follow dependencies within an epic and across its boundaries.'));
    close.onclick=()=>dialog.close();header.append(heading,close);
    const toolbar=el('div',null,'dg-toolbar'),epic=el('select'),search=el('input'),refresh=el('button','Refresh');
    epic.setAttribute('aria-label','Filter ticket map by epic');epic.append(new Option('All epics','all'),new Option('No epic','__none__'));
    search.type='search';search.placeholder='Find a ticket…';search.setAttribute('aria-label','Search ticket map');toolbar.append(epic,search,refresh);
    const status=el('p','Loading tickets…','dg-status');status.setAttribute('role','status');
    const legend=el('div',null,'dg-legend');legend.append(el('span','Prerequisite → dependent ticket'),el('span','Dashed border: outside this epic'));
    const body=el('div',null,'dg-body'),canvas=el('div',null,'dg-canvas'),details=el('aside',null,'dg-details');details.setAttribute('aria-label','Ticket dependencies');
    body.append(canvas,details);dialog.append(header,toolbar,status,legend,body);document.body.append(dialog);dialog.showModal();
    let tickets=[],edges=[],unresolved=[],selected=null,controller=null,version=0,first=true;
    const name=t=>`${t.ticketKey || 'Ticket'} · ${t.name}`;
    async function load() {
      const current=++version;controller?.abort();controller=new AbortController();refresh.disabled=true;status.textContent='Loading tickets…';
      try {
        const get=async path=>{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+path,{signal:controller.signal,credentials:'same-origin'});if(!r.ok)throw Error('Could not load the ticket map. Please try Refresh.');return r.json();};
        const [a,b]=await Promise.all([get('/tickets'),get('/epics')]);if(current!==version||!dialog.open)return;
        tickets=a.tickets || []; const previous=first?initialEpic:epic.value;first=false;
        epic.replaceChildren(new Option('All epics','all'),new Option('No epic','__none__'));
        for(const e of b.epics || [])epic.append(new Option(e.name || e.title || e.id,e.id));
        epic.value=[...epic.options].some(o=>o.value===previous)?previous:'all';
        edges=[];unresolved=[];
        const lookup=new Map();for(const t of tickets){lookup.set(t.id,t);if(t.ticketKey)lookup.set(t.ticketKey,t);}
        for(const t of tickets) {
          let deps=t.dependencies; if(typeof deps==='string'){try{deps=JSON.parse(deps);}catch{deps=[deps];}}
          for(const dep of Array.isArray(deps)?deps:[]) {
            const ref=typeof dep==='string'?dep:dep?.ticketId || dep?.id || dep?.ticketKey;
            const target=lookup.get(ref);
            if(target){if(!edges.some(e=>e.from===target.id&&e.to===t.id))edges.push({from:target.id,to:t.id});}
            else unresolved.push({id:t.id,label:ref || (typeof dep==='object'?JSON.stringify(dep):String(dep))});
          }
        }
        render();
      } catch(e){if(e.name!=='AbortError'&&dialog.open)status.textContent=e.message;}
      finally{if(current===version)refresh.disabled=false;}
    }
    function render() {
      const query=search.value.trim().toLowerCase();
      const base=tickets.filter(t=>(epic.value==='all'||(epic.value==='__none__'?!t.epicId:t.epicId===epic.value))&&(!query||name(t).toLowerCase().includes(query)));
      const core=new Set(base.map(t=>t.id)),included=new Set(core);
      // Include every prerequisite, including chains outside the chosen epic.
      let changed=true;while(changed){changed=false;for(const e of edges)if(included.has(e.to)&&!included.has(e.from)){included.add(e.from);changed=true;}}
      const nodes=tickets.filter(t=>included.has(t.id)), links=edges.filter(e=>included.has(e.from)&&included.has(e.to));
      const missing=unresolved.filter(u=>included.has(u.id));
      // Kahn layering keeps prerequisites on the left. Cycles remain visible in a separate column.
      const levels=new Map(),pending=new Set(nodes.map(t=>t.id));let level=0;
      while(pending.size){const ready=[...pending].filter(id=>!links.some(e=>e.to===id&&pending.has(e.from)));if(!ready.length)break;for(const id of ready){levels.set(id,level);pending.delete(id);}level++;}
      for(const id of pending)levels.set(id,level);
      const positions=new Map(),rows=new Map();for(const t of nodes){const col=levels.get(t.id);const row=rows.get(col)||0;rows.set(col,row+1);positions.set(t.id,{x:30+col*290,y:55+row*100});}
      status.textContent=`${base.length} tickets${nodes.length>base.length?` · ${nodes.length-base.length} linked prerequisites`:''} · ${links.length} dependencies.`+(links.length?'':' No saved dependencies for these tickets.')+(missing.length?` ${missing.length} unresolved references — select a ticket to inspect.`:'')+(pending.size?' A dependency cycle prevents ordering some tickets.':'');
      canvas.replaceChildren();
      if(!nodes.length)canvas.append(el('p','No tickets match this view.','dg-empty'));
      else {
        const width=Math.max(320,(Math.max(...levels.values())+1)*290+30),height=Math.max(220,Math.max(...rows.values())*100+70);
        const drawing=svg('svg',{width,height,viewBox:`0 0 ${width} ${height}`,role:'group','aria-label':'Ticket dependency map'});
        const markerId='ticket-arrow-'+(++sequence),defs=svg('defs',{}),marker=svg('marker',{id:markerId,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M 0 0 L 10 5 L 0 10 z',class:'dg-arrow'}));defs.append(marker);drawing.append(defs);
        for(const e of links){const a=positions.get(e.from),b=positions.get(e.to);const path=svg('path',{d:a.x===b.x?`M ${a.x+240} ${a.y+34} C ${a.x+280} ${a.y+34}, ${b.x+280} ${b.y+34}, ${b.x+240} ${b.y+34}`:`M ${a.x+240} ${a.y+34} C ${a.x+265} ${a.y+34}, ${b.x-25} ${b.y+34}, ${b.x} ${b.y+34}`,class:'dg-edge','marker-end':`url(#${markerId})`});drawing.append(path);}
        for(const t of nodes){const p=positions.get(t.id),g=svg('g',{transform:`translate(${p.x},${p.y})`,tabindex:0,role:'button','aria-label':name(t),class:'dg-node'+(!core.has(t.id)?' dg-outside':'')+(pending.has(t.id)?' dg-cycle':'')+(selected===t.id?' dg-selected':'')});g.append(svg('rect',{width:240,height:70,rx:10}));const title=svg('title',{});title.textContent=name(t);g.append(title);const key=svg('text',{x:12,y:20});key.textContent=`${t.ticketKey || 'Ticket'} · ${String(t.status).replaceAll('_',' ')}`;const text=svg('text',{x:12,y:43});text.textContent=t.name.length>32?t.name.slice(0,31)+'…':t.name;g.append(key,text);const select=()=>{selected=t.id;render();};g.onclick=select;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}};drawing.append(g);}
        canvas.append(drawing);
      }
      details.replaceChildren();const ticket=nodes.find(t=>t.id===selected);
      if(!ticket){details.append(el('h3','What depends on what?'),el('p','Select a ticket to see its prerequisites and the tickets that depend on it.'),el('p','Only saved ticket dependencies are shown. Ticket order and shared epic membership do not imply a dependency.'));return;}
      details.append(el('h3',name(ticket)),el('p','Status: '+String(ticket.status).replaceAll('_',' ')));
      for(const [title,predicate,id] of [['Depends on',e=>e.to===ticket.id,'from'],['Required by',e=>e.from===ticket.id,'to']]){
        details.append(el('h4',title));const related=edges.filter(predicate);if(!related.length)details.append(el('p','None recorded.'));
        for(const e of related){const t=tickets.find(t=>t.id===e[id]);const button=el('button',name(t),'dg-link');button.onclick=()=>{selected=t.id;epic.value='all';search.value='';render();};details.append(button);}
      }
      for(const u of unresolved.filter(u=>u.id===ticket.id))details.append(el('p','Unresolved dependency: '+u.label));
    }
    epic.onchange=render;search.oninput=render;refresh.onclick=load;
    dialog.addEventListener('close',()=>{version++;controller?.abort();dialog.remove();if(trigger.isConnected)trigger.focus();},{once:true});void load();
  }
})();
