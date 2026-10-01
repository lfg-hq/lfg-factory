/** Only accept task IDs supplied by this ticket, never arbitrary agent-selected rows. */
export function parseEpicTaskProgress(text:string,allowed:ReadonlySet<string>):Array<{id:string;status:string}> {
 try{
  const value=JSON.parse(text);
  if(!Array.isArray(value))return [];
  const updates=new Map<string,{id:string;status:string}>();
  for(const item of value.slice(0,100))if(item && allowed.has(item.id) && ['pending','in_progress','success','failed'].includes(item.status))updates.set(item.id,{id:item.id,status:item.status});
  return [...updates.values()];
 }catch{return [];}
}
