import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const source=readFileSync('src/services/dev-preview.ts','utf8');
function implementation(name:string,end:string,dependencies:Record<string,unknown>){
 const start=source.indexOf('export async function '+name+'(');const code=source.slice(start,source.indexOf(end,start)).replace('export async function','async function');
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(code);
 return new Function(...Object.keys(dependencies),js+';return '+name)(...Object.values(dependencies));
}
function fixture(started:boolean){
 const calls:any[]=[];const profile={framework:'web',runCmd:'serve',port:3000,services:[{name:'web',primary:true,enabled:true,port:3000},{name:'admin',enabled:false,port:3001}]};
 const dependencies={acquirePreviewAccess:async()=>()=>calls.push(['release']),getEnv:async()=>({previewBranch:'feature/current',appUrl:'https://preview',stableAlias:'pv'}),environmentBranch:(b:string)=>b,
 loadAppProfile:async(_p:string,branch:string)=>{calls.push(['load',branch]);return {profile};},saveAppProfile:async(_p:string,_profile:any,branch:string)=>calls.push(['save',branch]),deriveManifestFromProfile:(p:any)=>p,
 db:{update:()=>({set:()=>({where:async()=>{}})})},projectEnvironments:{projectId:'id'},eq:()=>true,startCompanionInBackground:async()=>started,restartPreview:async(_p:string,options:any)=>{calls.push(['restart',options]);},envWorkspaceId:async()=> 'workspace',sh:async()=>calls.push(['stop']),broadcastToUser:()=>{},pub:(s:string)=>s,svcSlug:(s:string)=>s};
 return {calls,dependencies,profile};
}
test('enabling a companion saves the selected branch and carries selection through fallback refresh',async()=>{
 const x=fixture(false);const enable=implementation('setServiceEnabled','\nconst svcSlug',x.dependencies);const result=await enable('p','u','admin',true);
 expect(result.ok).toBe(true);expect(x.calls).toContainEqual(['load','feature/current']);expect(x.calls).toContainEqual(['save','feature/current']);expect(x.calls).toContainEqual(['restart',{userId:'u',branch:'feature/current',expectedBranch:'feature/current'}]);
});
test('disabling a companion stops only that service and never refreshes preview',async()=>{
 const x=fixture(false);const enable=implementation('setServiceEnabled','\nconst svcSlug',x.dependencies);await enable('p','u','admin',false);expect(x.calls).toContainEqual(['stop']);expect(x.calls.some(c=>c[0]==='restart')).toBe(false);
});
test('adding a companion to a running branch keeps the primary up',async()=>{
 const x=fixture(true);const add=implementation('addService','\n/** Remove a MANUALLY',x.dependencies);const result=await add('p','u',{name:'reports',runCmd:'serve reports',port:3002});expect(result.ok).toBe(true);expect(x.calls).toContainEqual(['save','feature/current']);expect(x.calls.some(c=>c[0]==='restart')).toBe(false);expect(x.profile.services[0]!.enabled).toBe(true);
});
