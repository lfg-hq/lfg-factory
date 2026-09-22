import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/workers/ticket-executor.ts',import.meta.url),'utf8');
const retry=source.slice(source.indexOf('export async function startTicketValidationRetry'));
const success=retry.slice(retry.indexOf('        const reviewStageId ='),retry.indexOf('      } catch(error)'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for (const prior of [{status:'failed',githubCommitSha:'old',githubMergeStatus:'failed'},{status:'open',githubCommitSha:'new',githubMergeStatus:'pushed'}]) {
 test(`successful retry moves ${prior.status} ticket to review with validated revision`,async()=>{
  const saved:any={...prior}; const events:any[]=[]; const logs:string[]=[];
  const db={update:()=>({set:(values:any)=>({where:async()=>Object.assign(saved,values)})})};
  await new AsyncFunction('db','projectTickets','eq','moveTicketToStage','broadcastToUser','addLog','ticketId','project','ticket','sha',success)(db,{id:'id'},()=>true,async(id:string,project:string,name:string)=>{expect(name).toBe('In Review');saved.stageId='review-stage';return 'review-stage';},(owner:string,event:any)=>events.push(event),async(id:string,message:string)=>logs.push(message),'ticket',{id:'project',ownerId:'owner'},prior,'new');
  expect(saved.status).toBe('review');expect(saved.stageId).toBe('review-stage');expect(saved.githubCommitSha).toBe('new');
  expect(saved.githubMergeStatus).toBe(prior.githubCommitSha==='new'?'pushed':'pending');
  expect(events[0]).toMatchObject({ticketId:'ticket',status:'review',stageId:'review-stage'});
  expect(logs[0]).toContain('Moved to **In Review**');
 });
}
