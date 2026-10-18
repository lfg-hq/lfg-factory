import {test,expect} from 'bun:test';
import {compileRuntimePlan,previewAvailabilityCommand,type RuntimeRecipe} from '../src/services/runtime-plan.ts';
import {executeSteps} from '../src/services/preview-plan.ts';
const recipe:RuntimeRecipe={runtime:'node',framework:'next',toolchain:[],installCmd:'npm ci',buildCmd:'npm run build',runCmd:'npm start',schemaSteps:[{kind:'migration',command:'migrate',note:''}],replayActions:[{id:'browser-login',phase:'verify',command:'npm install playwright && test-login',verify:'test-login',note:''},{id:'bootstrap-admin',phase:'verify',command:'reset-admin',verify:'compare-password',note:''}],verificationPaths:['/private','/login']};
const io={dir:'/app',localize:(s:string)=>s,configure:'configure',start:'start',sql:(s:string)=>s,http:(p:string)=>'GET '+p,tests:['acceptance-test'],beforeSchema:['load-test-fixtures']};
test('preview ignores legacy login/account replay actions, feature routes and acceptance fixtures',()=>{
 const steps=compileRuntimePlan(recipe,io);
 expect(steps.map(s=>s.command)).toEqual(['configure','npm ci','npm run build','migrate','start','GET /']);
});
test('ticket validation retains feature tests and fixtures',()=>{
 const commands=compileRuntimePlan(recipe,{...io,purpose:'validation'}).map(s=>s.command);
 for(const command of ['load-test-fixtures','GET /private','npm install playwright && test-login','acceptance-test'])expect(commands).toContain(command);
});
test('preview seeds require repository evidence and an existence check',()=>{
 for(const seed of [{kind:'seed' as const,command:'seed',note:''},{kind:'seed' as const,command:'seed',note:'',verify:'exists'}]) {
  expect(compileRuntimePlan({...recipe,schemaSteps:[seed]},io).some(s=>s.command==='seed')).toBe(false);
 }
 const steps=compileRuntimePlan({...recipe,schemaSteps:[{kind:'seed',command:'seed',note:'',requiredBy:'src/config.ts requires a default site',verify:'site-exists'}]},io);
 expect(steps.find(s=>s.command==='seed')?.verify).toBe('site-exists');
});
test('required initialization runs once and never overwrites existing data on the next run',async()=>{
 let exists=false;let writes=0;
 const required={...recipe,schemaSteps:[{kind:'seed' as const,command:'initialize',note:'',requiredBy:'README.md initial site requirement',verify:'exists'}]};
 const execute=()=>executeSteps(compileRuntimePlan(required,io),{persist:async()=>{},cancelled:()=>false,run:async(_,command)=>{
  if(command==='exists')return {exitCode:exists?0:1,output:''};
  if(command==='initialize'){exists=true;writes++;}
  return {exitCode:0,output:''};
 }});
 expect(await execute()).toBeNull();expect(await execute()).toBeNull();expect(writes).toBe(1);
});

test('availability accepts an auth challenge but rejects a down or failing server',()=>{
 const {spawnSync}=require('node:child_process');
 for(const code of ['200','307','401','403','000','500']) {
  const script=`curl() { printf '%s' '${code}'; }; `+previewAvailabilityCommand(8080);
  const result=spawnSync('bash',['-c',script]);
  expect(result.status).toBe(['000','500'].includes(code)?1:0);
 }
});
