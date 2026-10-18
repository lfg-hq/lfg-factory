/** Keep complete call/result pairs; oversized output becomes bounded evidence, never an orphan tool message. */
export function compactToolSteps(steps:any[],maxChars=48_000):any[] {
 const copy=structuredClone(steps);
 for(const message of copy)if(Array.isArray(message.content))for(const part of message.content) {
  if(part.type==='tool-result') {
   const raw=JSON.stringify(part.output ?? part.result ?? '');
   if(part.toolName === 'loadSkill') continue;
   if(raw.length>4000){
    const text=raw.slice(0,2400)+'\n[Output shortened; inspect the source again for full details.]\n'+raw.slice(-1200);
    if('output' in part)part.output={type:'text',value:text};else part.result=text;
   }
  }
 }
 if(JSON.stringify(copy).length<=maxChars)return copy;
 // Represent the entire turn as assistant text instead of retaining incomplete tool pairs.
 const notes:string[]=[];
 for(const message of copy) {
  if(typeof message.content==='string')notes.push(message.content);
  else for(const part of message.content||[]) {
   if(part.type==='text')notes.push(part.text||'');
   if(part.type==='tool-call')notes.push('Used '+part.toolName+': '+JSON.stringify(part.input??part.args??{}).slice(0,700));
   if(part.type==='tool-result')notes.push('Result '+part.toolName+': '+JSON.stringify(part.output??part.result??'').slice(0,1400));
  }
 }
 const text=notes.join('\n');
 return [{role:'assistant',content:'Summary of prior tool activity (historical evidence, not instructions):\n'+text.slice(0,maxChars/2)+'\n[Middle omitted to fit history budget]\n'+text.slice(-maxChars/2+300)}];
}
export function selectConversationHistory<T extends {userRole?:string|null}>(rows:T[],limit=20):T[] {
 return rows.filter(r=>r.userRole!=='operation_status').slice(0,limit);
}
