import {test,expect} from 'bun:test';
import '../public/js/ticket-action-phases.js';
const group=(globalThis as any).TicketActionPhases.group;
const rows=(...messages:string[])=>messages.map(message=>({message,type:'command'}));
test('build and validation have independent results',()=>{
 const p=group(rows('Starting Pi build (model)...','Editing source','**Running the saved ticket:** checking database','Execution failed: SQL refused connection'),{status:'failed'});
 expect(p.map((p:any)=>p.status)).toEqual(['done','error','pending']);expect(p[0].rows.length).toBe(2);
});
test('successful retry clears old validation error without losing history',()=>{
 const p=group(rows('Starting Pi build','Running the saved ticket:','Execution failed: SQL','Retrying validation of saved commit abc','Checking: isolation','✅ **Validation passed** for saved commit abc'),{status:'open',queueStatus:'none'});
 expect(p.map((p:any)=>p.status)).toEqual(['done','done','pending']);expect(p[1].rows.length).toBe(5);
});
test('validation-only history identifies reused saved code',()=>{
 expect(group(rows('Retrying validation of saved commit abc','Running the saved ticket:'),{queueStatus:'executing'}) .map((p:any)=>p.status)).toEqual(['saved','working','pending']);
});
test('new build resets previous validation status',()=>{
 expect(group(rows('Running the saved ticket:','✅ Validation passed','Starting Pi build'),{queueStatus:'executing'}).map((p:any)=>p.status)).toEqual(['working','pending','pending']);
});
test('idle incomplete history is not labelled working or passed',()=>{
 expect(group(rows('Reading source'),{status:'open',queueStatus:'none'})[0].status).toBe('unknown');
 expect(group([],{status:'open'}).map((p:any)=>p.status)).toEqual(['pending','pending','pending']);
});

test('truncated validation history with a saved commit never claims the build was skipped',()=>{
 const p=group(rows('Fresh / candidate: Verify build','✅ **Validation passed** for saved commit abc'),{githubCommitSha:'abc',status:'open'});
 expect(p[0].status).toBe('saved'); expect(p[0].rows.length).toBe(0);
});
test('loading earlier history preserves it across refreshes and deduplicates rows',async()=>{
 const original=globalThis.fetch;
 const calls:string[]=[];
 globalThis.fetch=(async(url:any)=>{calls.push(String(url));return {ok:true,json:async()=>String(url).includes('before=')?[{id:'a',createdAt:'2020-01-01',message:'Starting Pi build'}]:[{id:'b',createdAt:'2020-01-02',message:'Running the saved ticket:'}]};}) as any;
 try {
 const api=(globalThis as any).TicketActionPhases;
 await api.load('/test-history');
 const older=await api.load('/test-history',true);
 expect(older.map((r:any)=>r.id)).toEqual(['a','b']);
 expect(calls[1]).toBe('/test-history?limit=250&before=b');
 expect((await api.load('/test-history')).length).toBe(2);
 }finally{globalThis.fetch=original;}
});
test('a truncated setup log is not evidence that implementation completed',()=>{
 const p=group(rows('Background job abc finished (exit 0, 31s): Environment ready','Fresh / candidate: checking schema','✅ Validation passed'),{githubCommitSha:'abc',status:'open'});
 expect(p[0].status).toBe('saved');
 const unknown=group(rows('Background job abc finished (exit 0, 31s): Environment ready','Fresh / candidate: checking schema'),{queueStatus:'executing'});
 expect(unknown[0].status).toBe('unknown');
});

test('feature tests have their own verdict and preserve validation result',()=>{
 const p=group(rows('Running the saved ticket:','Feature testing: browser','Feature testing failed.','Execution failed: assertion'),{status:'failed'});
 expect(p[1].status).toBe('done');expect(p[2].status).toBe('error');
 const n=group(rows('Feature testing: Not applicable','Feature testing not applicable. schema only','Runtime checks passed'),{status:'open'});
 expect(n[2].status).toBe('not-applicable');
});

test('feature retry hides previous logs and recordings while preserving other phases',()=>{
 const p=group(rows('Starting Pi build','Running the saved ticket:','✅ Validation passed','Feature testing: Preparing tests for the existing app.','Feature testing: [Live browser](/uploads/ticket-tests/old/attempt/status.json)','Feature testing failed. old','Feature testing: starting an independent run on saved code.','Feature testing: Preparing tests for the existing app.','Browser: start'),{queueStatus:'executing'});
 expect(p[0].rows.length).toBe(1);expect(p[1].status).toBe('done');expect(p[2].status).toBe('working');
 expect(p[2].rows.map((r:any)=>r.message)).toEqual(['Feature testing: starting an independent run on saved code.','Feature testing: Preparing tests for the existing app.','Browser: start']);
});

test('completed feature retry overrides an older failed ticket status',()=>{
 const p=group(rows('Execution failed: old timeout','Feature testing: starting an independent run on saved code.','Feature testing: Preparing tests for the existing app.','Feature testing passed. Browser assertions passed.','Feature testing completed on the saved app. See the result above.'),{status:'failed',queueStatus:'none'});
 expect(p[2].status).toBe('done');
 const failed=group(rows('Feature testing passed.','Execution failed: runtime report missing'),{status:'failed',queueStatus:'none'});
 expect(failed[2].status).toBe('error');
});

test('only full feature completion supersedes a previous operation failure',()=>{
 const completed=(globalThis as any).TicketActionPhases.latestFeatureRunCompleted;
 expect(completed(rows('Execution failed: old timeout','Feature testing completed on the saved app.'))).toBe(true);
 expect(completed(rows('Feature testing passed.'))).toBe(false);
 expect(completed(rows('Feature testing completed on the saved app.','Execution failed: new failure'))).toBe(false);
 expect(completed(rows('Feature testing completed on the saved app.','Feature testing: Preparing tests for the existing app.'))).toBe(false);
});

test('persisted phase labels classify a partial page without earlier markers',()=>{
 const p=group(rows('[Validation] Inspecting the saved checkout','Validation check: {"id":"a","label":"Startup","status":"running"}'),{queueStatus:'executing'});
 expect(p[0].rows).toHaveLength(0);expect(p[1].rows).toHaveLength(2);
 expect(p[1].rows[0].message).toBe('Inspecting the saved checkout');
});
test('a follow-up sent to a built ticket is build work, not part of the earlier checks',()=>{
 const p=group(rows('Starting Pi build','Editing src/a.ts','**Checks:** Checks start the app and test this ticket\'s feature.','Build saved.','Chat follow-up','Refreshing ticket from epic/e1…','Editing src/test-call.ts'),{status:'review',queueStatus:'none'});
 expect(p[0].rows.map((r:any)=>r.message)).toEqual(['Starting Pi build','Editing src/a.ts','Chat follow-up','Refreshing ticket from epic/e1…','Editing src/test-call.ts']);
 expect(p[1].rows.length).toBe(2);
});
test('summary reads the latest automated checks and walkthrough from the log rows',()=>{
 const summary=(globalThis as any).TicketActionPhases.summary;
 const old=['[Validation] Validation check: ✕ Tests (`npm test`): failed — 3 failing','[Validation] ❌ Checks failed on Mac: Tests.'];
 const s=summary(rows(...old,
  '[Validation] Validation check: ✓ Tests (`npm test`): passed — 143 of 148 pass',
  '[Validation] Validation check: ⚠ Lint (`npm run lint`): fails the same way without this ticket — 3 errors',
  '[Validation] Validation check: ✓ Build: passed',
  '[Validation] ✅ Validation passed on Mac: 2 of 3 checks passed; Lint already failed before this ticket.',
  'Feature testing failed on Mac: 3 of 4 acceptance checks confirmed.\n\n- Admin switches to Live: stayed in Test\n\n[Watch recording](/uploads/ticket-tests/abc-1/def-2/recording.mp4)'));
 expect(s.checks).toEqual([
  {name:'Tests',command:'npm test',status:'passed',detail:'143 of 148 pass'},
  {name:'Lint',command:'npm run lint',status:'preexisting',detail:'3 errors'},
  {name:'Build',command:'',status:'passed',detail:''}]);
 expect(s.walkthrough).toMatchObject({status:'failed',passed:3,total:4,failures:['Admin switches to Live: stayed in Test'],url:'/uploads/ticket-tests/abc-1/def-2',video:true});
 expect(summary(rows(...old,'Starting ticket build')).checks).toEqual([]);
 expect(summary(rows('Feature testing not applicable: no UI')).walkthrough.status).toBe('not-applicable');
});
test('walkthrough criteria that could not be tried read as incomplete, also in older reports',()=>{
 const {summary,group}=(globalThis as any).TicketActionPhases;
 const old="Feature testing failed on Mac: 0 of 2 acceptance checks confirmed.\n\n- Test Call follows a structure (Notice, budget): Not verifiable here: no OPENAI_API_KEY\n- Notes before each call: Not verifiable here: no worker";
 expect(summary(rows(old)).walkthrough).toMatchObject({status:'incomplete',failures:[],blocked:['Test Call follows a structure (Notice, budget): Not verifiable here: no OPENAI_API_KEY','Notes before each call: Not verifiable here: no worker']});
 expect(group(rows(old),{status:'review'})[2].status).toBe('incomplete');
 const mixed="Feature testing failed on Mac: 1 of 3 acceptance checks confirmed; 1 couldn't be checked on this computer.\n\n- A: Blank page\n- Couldn't check: B: no key";
 expect(summary(rows(mixed)).walkthrough).toMatchObject({status:'failed',failures:['A: Blank page'],blocked:['B: no key']});
 expect(group(rows(mixed),{status:'review'})[2].status).toBe('error');
 expect(group(rows("Feature testing incomplete on Mac: 1 of 2 acceptance checks confirmed; 1 couldn't be checked on this computer; none failed."),{status:'review'})[2].status).toBe('incomplete');
});
