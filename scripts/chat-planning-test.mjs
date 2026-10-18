import {chromium} from 'playwright-core';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';

export function parseArgs(args) {
 const options={};
 for(let i=0;i<args.length;i++) {
  const key=args[i];
  if(key==='--help'){options.help=true;continue;}
  if(!['--base-url','--project','--scenario','--profile','--output','--timeout-seconds'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw Error(`Unknown or missing argument: ${key}`);
  options[key.slice(2)]=args[++i];
 }
 return options;
}
export function answerFor(question,scenario) {
 return scenario.answers.find(a=>new RegExp(a.pattern,'i').test(question))?.answer;
}
export function scrub(text) {
 return String(text).replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]')
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi,'Bearer [REDACTED]');
}
export function captureEvent(data) {
 if(data.type==='error')return {type:'error',message:data.message};
 if(data.type!=='ai_chunk')return null;
 const fields=['type','chunk','is_final','end_reason','error_message','conversation_id','notification_type','function_name','detail','file_id','file_name','questions','title','summary'];
 return Object.fromEntries(fields.filter(k=>data[k]!==undefined).map(k=>[k,data[k]]));
}
const help=`Usage: node scripts/chat-planning-test.mjs --base-url http://localhost:3000
Options: --project UUID --scenario FILE --profile DIR --output DIR --timeout-seconds 600
Opens dedicated Chrome. Log in and press Enter in this terminal to start.
Creates real test documents/epics and possibly unscheduled tickets; uses model credits.
Does not authorize building. Captures visible activity, not hidden reasoning.
Defaults to the Recruiting project. Use --base-url https://lfg.run to test production intentionally.`;

export async function main(args=process.argv.slice(2)) {
 const opts=parseArgs(args);if(opts.help){console.log(help);return;}
 if(!opts['base-url'])throw Error('Choose the target explicitly with --base-url. Run --help for details.');
 const base=new URL(opts['base-url']);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Use an HTTP(S) URL without credentials.');
 const scenario=JSON.parse(await readFile(resolve(opts.scenario||'scripts/scenarios/recruiting-planning.json'),'utf8'));
 const project=opts.project||scenario.projectId;
 if(!/^[a-f0-9-]{36}$/i.test(project))throw Error('Expected a project UUID.');
 if(!Array.isArray(scenario.turns)||!scenario.turns.length||scenario.turns.some(x=>typeof x!=='string'))throw Error('Scenario needs text turns.');
 const timeout=Number(opts['timeout-seconds']||600)*1000;
 if(!Number.isFinite(timeout)||timeout<1000||timeout>3600000)throw Error('Timeout must be 1–3600 seconds.');
 const runId='planning-test-'+new Date().toISOString().replace(/[:.]/g,'-');
 const out=resolve(opts.output||`test-results/chat-planning/${runId}`);
 await mkdir(out,{recursive:true});
 const context=await chromium.launchPersistentContext(resolve(opts.profile||`${homedir()}/.lfg-planning-test-chrome`),{
  channel:'chrome',headless:false,viewport:{width:1440,height:1000},
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const report={runId,scenario:scenario.name,base:base.origin,project,startedAt:new Date().toISOString(),status:'running',turns:[],events:[],snapshots:[]};
 let finalCount=0,conversationId=null,fatal=null;
 const save=async()=>{
  await writeFile(`${out}/report.json`,scrub(JSON.stringify(report,null,2)));
  await writeFile(`${out}/report.md`,scrub(`# ${report.scenario}\n\nStatus: ${report.status}\nRun: ${runId}\nTarget: ${base.origin}\nConversation: ${conversationId||'not created'}\n\n${report.error||''}\n\n`+
   report.turns.map((t,i)=>`## ${i+1}. ${t.kind}\n\n${t.prompt}\n\n${t.text||''}\n`).join('\n')+
   '\n## Review checklist\n\n- Did it brainstorm before saving?\n- Did it reuse settled decisions?\n- Were requirements and technical analysis saved and grounded?\n- Were dependencies and acceptance criteria concrete?\n- Did it stop before implementation?\n\nSee report.json for visible activity and before/after artifact snapshots. Completion of the script is not a quality pass.\n'));
 };
 page.on('websocket',socket=>socket.on('framereceived',({payload})=>{
  try {const event=captureEvent(JSON.parse(String(payload)));if(!event)return;
   report.events.push({at:new Date().toISOString(),...event});
   if(event.conversation_id)conversationId=event.conversation_id;
   if(event.is_final)finalCount++;
   if(event.type==='error'||event.error_message)fatal=event.error_message||event.message||'Chat error';
  }catch{}
 }));
 const get=async path=>{
  const r=await context.request.get(new URL(path,base.origin).href,{timeout:30000});
  if(!r.ok())throw Error(`Artifact read failed: ${r.status()} ${path}`);
  return r.json();
 };
 let before;
 const snapshot=async label=>{
  const files=await get(`/projects/${project}/api/files/browser`);
  const tickets=await get(`/api/projects/${project}/tickets`);
  const epics=await get(`/api/projects/${project}/epics`);
  const data={label,files,tickets,epics,documents:[]};
  if(before)for(const file of files.files||[]) {
   const old=(before.files.files||[]).find(f=>f.id===file.id);
   if(file.type!=='upload'&&(!old||old.updated_at!==file.updated_at))data.documents.push({id:file.id,name:file.name,content:await get(`/projects/${project}/api/files/${encodeURIComponent(file.id)}/content`)});
  }
  report.snapshots.push(data);return data;
 };
 const waitTurn=async count=>{
  const end=Date.now()+timeout;
  while(finalCount<=count){if(fatal)throw Error(fatal);if(Date.now()>end)throw Error('Turn timed out. The server may still be running; inspect the chat before retrying.');await new Promise(r=>setTimeout(r,250));}
  if(fatal)throw Error(fatal);
  await page.waitForFunction(()=>!window.__isAgentStreaming__,{},{timeout:15000});
 };
 const recordTurn=async(prompt,kind,action)=>{
  const count=finalCount,eventStart=report.events.length;
  report.turns.push({prompt,kind});await save();
  console.log(`${report.turns.length}: ${kind}`);
  await action();await waitTurn(count);
  const turn=report.turns.at(-1);
  turn.text=report.events.slice(eventStart).filter(e=>!e.notification_type).map(e=>e.chunk||'').join('');
  turn.endReason=report.events.slice(eventStart).findLast(e=>e.is_final)?.end_reason;
  if(turn.endReason&&!['completed','complete'].includes(turn.endReason))throw Error(`Turn ended: ${turn.endReason}`);
  await page.screenshot({path:`${out}/turn-${report.turns.length}.png`,fullPage:true});
  await snapshot(`turn-${report.turns.length}`);await save();
 };
 try {
  await page.goto(new URL(`/chat/project/${project}?new=1`,base.origin).href);
  const rl=createInterface({input:process.stdin,output:process.stdout});
  await rl.question(`Chrome is open. Log in if needed, verify the project and model, then press Enter to start ${runId}. This creates real planning artifacts. `);rl.close();
  // Always reset to a new session after login; never reuse an existing chat.
  await page.goto(new URL(`/chat/project/${project}?new=1`,base.origin).href);
  await page.locator('#chat-input').waitFor();
  before=await snapshot('before');await save();
  const boundary=`This is planning test ${runId}. Name all new test documents and the test epic with this label. Preserve existing project assets. Never start/schedule builds, execute code, deploy, or make calls. Create draft tickets only if supported separately from execution. `;
  for(const [index,prompt] of scenario.turns.entries()) {
   // Never click a generic Yes: dismiss confirmation and send the scoped scenario authorization.
   const confirm=page.locator('.confirm-action-card:not(.dismissed) .confirm-action-no-btn');
   if(await confirm.count())await confirm.last().click();
   await recordTurn(prompt,'scenario',async()=>{await page.locator('#chat-input').fill((index===0?boundary:'')+prompt);await page.locator('#send-btn').click();});
   for(let n=0;n<5;n++) {
    const card=page.locator('.ask-user-card:not(.dismissed)').last();
    if(!await card.count())break;
    const questions=await card.locator('.ask-user-section-header h4').allTextContents();
    const answers=questions.map(q=>answerFor(q,scenario));
    if(answers.some(a=>!a))throw Error(`Needs a scenario answer for: ${questions.filter((_,i)=>!answers[i]).join('; ')}. Add an answer rule or review manually.`);
    await recordTurn(questions.map((q,i)=>`${q}\n${answers[i]}`).join('\n'),'clarification',async()=>{
     for(let i=0;i<questions.length;i++) {
      const section=card.locator('.ask-user-section').nth(i);
      await section.locator('.ask-user-option-row').filter({hasText:'Something else'}).click();
      await section.locator('.ask-user-custom-input').fill(answers[i]);
      if(i<questions.length-1)await card.locator('.ask-user-next-btn').click();
     }
     await card.locator('.ask-user-submit-btn').click();
    });
    if(n===4)throw Error('Repeated clarification limit reached; review the captured conversation.');
   }
  }
  report.status='completed-for-review';
 }catch(error){report.status='needs-review';report.error=error.message;process.exitCode=1;}
 finally {
  report.finishedAt=new Date().toISOString();report.conversationId=conversationId;
  try{await page.screenshot({path:`${out}/final.png`,fullPage:true});if(before)await snapshot('after');}catch(error){report.captureError=error.message;}
  await save();console.log(`Report: ${out}/report.md\nStatus: ${report.status}`);await context.close();
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
