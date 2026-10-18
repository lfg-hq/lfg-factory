(() => {
  'use strict';
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
  const svg = (tag, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,String(v)); return n; };
  const labels = { document:'Document',upload:'Upload',external:'Connected source',epic:'Epic',ticket:'Ticket' };
  const relation = r => r.replaceAll('_',' ');
  window.DocumentGraph = {
    mount(projectId) {
      const refresh = document.getElementById('refresh-filebrowser');
      if (!refresh) return;
      let button = document.getElementById('document-graph-open');
      if (!button) { button = el('button','Document map'); button.id = 'document-graph-open'; button.type='button'; let actions=refresh.closest('.map-header-actions'); if(!actions){actions=el('div',null,'map-header-actions');refresh.before(actions);actions.append(refresh);} actions.prepend(button); }
      button.onclick = () => openGraph(projectId);
    }
  };
  function mergeDuplicates(data) {
    const groups=new Map(),aliases=new Map(),nodes=[];
    for(const node of data.nodes){
      const key=node.duplicateKey && ['document','upload','external'].includes(node.kind)?node.kind+':'+node.duplicateKey:node.id;
      let group=groups.get(key);
      if(!group){group={...node,copies:[]};groups.set(key,group);nodes.push(group);}
      group.copies.push(node);aliases.set(node.id,group.id);
    }
    const links=new Map();
    for(const edge of data.edges){
      const source=aliases.get(edge.source)||edge.source,target=aliases.get(edge.target)||edge.target;if(source===target)continue;
      const key=JSON.stringify([source,target,edge.relation,edge.origin]);
      if(!links.has(key))links.set(key,{...edge,source,target,originals:[]});
      links.get(key).originals.push(edge);
    }
    return {...data,nodes,edges:[...links.values()]};
  }
  function openGraph(projectId) {
    document.getElementById('document-graph-dialog')?.close();
    const dialog = el('dialog',null,'document-graph-dialog'); dialog.id='document-graph-dialog';
    const header=el('header'); const heading=el('div'); heading.append(el('h2','Document map'),el('p','Explore sources, documents, epics, and the tickets they inform.'));
    const close=el('button','Close'); close.type='button'; close.onclick=()=>dialog.close(); header.append(heading,close);
    const toolbar=el('div',null,'dg-toolbar'); const search=el('input'); search.type='search'; search.placeholder='Find a document or epic…'; search.setAttribute('aria-label','Search document map');
    const kind=el('select'); kind.setAttribute('aria-label','Filter by type'); kind.append(new Option('All types','')); for(const [k,v] of Object.entries(labels)) kind.append(new Option(v,k));
    const suggestions=el('label'); const check=el('input'); check.type='checkbox'; check.checked=true; suggestions.append(check,document.createTextNode('Show suggestions'));
    const retry=el('button','Refresh'); retry.type='button'; toolbar.append(search,kind,suggestions,retry);
    const status=el('p','Loading document map…','dg-status'); status.setAttribute('role','status');
    const legend=el('div',null,'dg-legend'); legend.append(el('span','● Confirmed links'),el('span','┄ Suggested links · review before relying on them'));
    const body=el('div',null,'dg-body'), canvas=el('div',null,'dg-canvas'), details=el('aside',null,'dg-details'); details.setAttribute('aria-label','Selected document');
    body.append(canvas,details); dialog.append(header,toolbar,status,legend,body); document.body.append(dialog); dialog.showModal();
    let data=null,selected=null,timer=null,controller=null,revision=0,signature='';
    const endpoint='/api/projects/'+encodeURIComponent(projectId)+'/document-graph';
    const request=async(path='',options={})=>{
      const response=await fetch(endpoint+path,{credentials:'same-origin',...options});
      if(!response.ok) throw Error(response.status===403?'You do not have permission to edit this map.':'Could not load the document map. Please try again.');
      return response.json();
    };
    async function load() {
      const version=++revision; controller?.abort(); controller=new AbortController();
      try { const result=await request('',{signal:controller.signal}); if(version!==revision||!dialog.open)return; const nextSignature=JSON.stringify(result); const changed=signature!==nextSignature;signature=nextSignature; data=mergeDuplicates(result); retry.disabled=!data.canEdit; if(changed) render(); }
      catch(error) { if(error.name!=='AbortError') status.textContent=error.message; }
    }
    async function decision(edge,value) {
      try { for(const original of edge.originals || [edge]) await request('/links',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:original.source,target:original.target,relation:original.relation,decision:value})}); await load(); }
      catch(error) { status.textContent=error.message; }
    }
    function render() {
      if(!data) return;
      const query=search.value.toLowerCase().trim();
      const allEdges=data.edges.filter(e=>check.checked||e.origin!=='suggested');
      const neighbors=new Set([selected]); for(const e of allEdges) if(e.source===selected||e.target===selected){neighbors.add(e.source);neighbors.add(e.target);}
      let nodes=data.nodes.filter(n=>(!query||n.name.toLowerCase().includes(query))&&(!kind.value||n.kind===kind.value));
      const total=nodes.length;
      if(selected&&!query&&!kind.value) nodes=nodes.filter(n=>neighbors.has(n.id));
      nodes=nodes.slice(0,160);
      const ids=new Set(nodes.map(n=>n.id)),edges=allEdges.filter(e=>ids.has(e.source)&&ids.has(e.target));
      status.textContent=(data.status==='error'?data.error:data.status==='ready'?'Map up to date.':'Background agent is reading and connecting documents…')+' '+data.nodes.length+' items · '+allEdges.length+' connections.'+(total>160&&!selected?' Showing the first 160 items; search to narrow the map.':'');
      canvas.replaceChildren();
      if(selected) {const reset=el('button','← Show all documents','dg-reset');reset.onclick=()=>{selected=null;render();};canvas.append(reset);}
      if(!nodes.length) canvas.append(el('p',data.nodes.length?'No matching items.':'No documents yet. Upload a file, read a connected document, or create a project document.','dg-empty'));
      else {
        const columns=[['upload','external'],['document'],['epic'],['ticket']];
        const positions=new Map(); let height=160;
        columns.forEach((kinds,col)=>{const group=nodes.filter(n=>kinds.includes(n.kind));group.forEach((n,row)=>positions.set(n.id,{x:30+col*280,y:65+row*92}));height=Math.max(height,group.length*92+100);});
        const drawing=svg('svg',{width:1140,height,viewBox:`0 0 1140 ${height}`,role:'group','aria-label':'Document relationship map'});
        ['Sources','Documents','Epics','Tickets'].forEach((label,col)=>{const text=svg('text',{x:30+col*280,y:30,class:'dg-column'});text.textContent=label;drawing.append(text);});
        const drawn=new Set();
        for(const edge of edges) {
          const key=JSON.stringify([edge.source,edge.target,edge.origin]);if(drawn.has(key))continue;drawn.add(key);
          const a=positions.get(edge.source),b=positions.get(edge.target); if(!a||!b)continue;
          const same=a.x===b.x; const path=svg('path',{d:same?`M ${a.x+220} ${a.y+29} C ${a.x+265} ${a.y+29}, ${b.x+265} ${b.y+29}, ${b.x+220} ${b.y+29}`:`M ${a.x+220} ${a.y+29} C ${a.x+260} ${a.y+29}, ${b.x-40} ${b.y+29}, ${b.x} ${b.y+29}`,class:'dg-edge '+(edge.origin==='suggested'?'dg-suggested':'')});
          const title=svg('title',{});title.textContent=relation(edge.relation)+': '+edge.reason;path.append(title);drawing.append(path);
        }
        for(const node of nodes) {
          const pos=positions.get(node.id);const group=svg('g',{transform:`translate(${pos.x},${pos.y})`,tabindex:0,role:'button','aria-label':labels[node.kind]+': '+node.name,class:'dg-node dg-'+node.kind+(selected===node.id?' dg-selected':'')});
          group.append(svg('rect',{width:220,height:62,rx:10}));
          const title=svg('title',{});title.textContent=node.name;group.append(title);
          const name=svg('text',{x:12,y:25});name.textContent=node.name.length>27?node.name.slice(0,26)+'…':node.name;group.append(name);
          const type=svg('text',{x:12,y:46,class:'dg-type'});type.textContent=labels[node.kind]+(node.copies?.length>1?' · '+node.copies.length+' copies':'');group.append(type);
          const select=()=>{selected=node.id;render();}; group.onclick=select;group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}};drawing.append(group);
        }
        canvas.append(drawing);
      }
      renderDetails(allEdges);
    }
    function renderDetails(edges) {
      details.replaceChildren();const node=data.nodes.find(n=>n.id===selected);
      if(!node){details.append(el('h3','Follow the connections'),el('p','Select an item to focus its neighborhood, inspect evidence, or tag it to an epic.'),el('p','Uploads and connected sources are private to you. Confirmed tags in this map are personal; existing project links remain shared.'));return;}
      details.append(el('span',labels[node.kind],'dg-badge'),el('h3',node.name));
      if(node.copies?.length>1) {
        details.append(el('p',node.copies.length+' identical copies grouped here. All source files are preserved.'));
        for(const copy of node.copies){const button=el('button','Open '+copy.name,'dg-link');button.onclick=()=>{if(copy.kind==='document'){dialog.close();window.ArtifactsLoader?.loadFileBrowser(projectId,{openFileId:copy.id.slice(9)});}else if(copy.url && (/^https?:\/\//.test(copy.url)||copy.url.startsWith('/api/files/'))){window.open(copy.url,'_blank','noopener,noreferrer');}};details.append(button);}
      }
      if(node.warning) details.append(el('p',node.warning));
      if(node.url && (/^https?:\/\//.test(node.url)||node.url.startsWith('/api/files/'))) {const a=el('a','Open source ↗');a.href=node.url;a.target='_blank';a.rel='noopener noreferrer';details.append(a);}
      if(node.kind==='document') {const button=el('button','Open document');button.onclick=()=>{dialog.close();window.ArtifactsLoader?.loadFileBrowser(projectId,{openFileId:node.id.slice(9)});};details.append(button);}
      if(data.canEdit&&!['epic','ticket'].includes(node.kind)) {
        const select=el('select');select.setAttribute('aria-label','Tag this document to an epic');select.append(new Option('Choose an epic…',''));for(const epic of data.nodes.filter(n=>n.kind==='epic'))select.append(new Option(epic.name,epic.id));
        const tag=el('button','Tag to epic');tag.onclick=()=>{if(select.value)void decision({source:node.id,target:select.value,relation:'relevant_to'},'accepted');};details.append(select,tag);
      }
      const connected=edges.filter(e=>e.source===node.id||e.target===node.id);
      details.append(el('h4',connected.length+' connections'));
      for(const edge of connected){
        const target=data.nodes.find(n=>n.id===(edge.source===node.id?edge.target:edge.source));if(!target)continue;
        const card=el('div',null,'dg-connection');const link=el('button',target.name,'dg-link');link.onclick=()=>{selected=target.id;render();};
        card.append(el('span',(edge.origin==='suggested'?'Suggested · ':edge.origin==='manual'?'Confirmed · ':'Existing · ')+relation(edge.relation),'dg-badge'),link,el('p',edge.reason));
        if(data.canEdit&&edge.origin==='suggested'){for(const [label,value] of [['Accept','accepted'],['Dismiss','rejected']]){const button=el('button',label);button.onclick=()=>void decision(edge,value);card.append(button);}}
        if(data.canEdit&&edge.origin==='manual'){const remove=el('button','Remove tag');remove.onclick=()=>void decision(edge,'rejected');card.append(remove);}
        details.append(card);
      }
      if(!connected.length) details.append(el('p','No connections found yet. You can add an epic tag above.'));
    }
    search.oninput=render;kind.onchange=render;check.onchange=render;
    retry.onclick=async()=>{retry.disabled=true;try{await request('/retry',{method:'POST'});await load();}catch(e){status.textContent=e.message;}finally{retry.disabled=!data?.canEdit;}};
    dialog.addEventListener('close',()=>{clearInterval(timer);controller?.abort();dialog.remove();document.getElementById('document-graph-open')?.focus();},{once:true});
    void load();timer=setInterval(()=>{if(!document.hidden)void load();},7000);
  }
})();
