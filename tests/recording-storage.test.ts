import {test,expect} from 'bun:test';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {prepareRecordingDirectory} from '../src/services/recording-storage.ts';
import {LiveFeatureBrowser} from '../src/services/live-feature-browser.ts';
test('recorder verifies server-side storage before provisioning or sandbox repairs',async()=>{
 const root=await mkdtemp(tmpdir()+'/recorder-permissions-');
 const dir=root+'/uploads/ticket-tests';
 await prepareRecordingDirectory(dir);
 await chmod(dir,0o500);
 let sandboxCalls=0,browserCalls=0;
 const controller=new LiveFeatureBrowser({workspaceId:'test',ticketId:'test',redact:s=>s,progress:async()=>{},shell:async()=>{sandboxCalls++;return {exitCode:0,output:''}}},{startBrowserSession:async()=>{browserCalls++;throw Error('Must not provision');},enableHttpAccess:async()=>{browserCalls++;return ''},stopWorkspace:async()=>{}},root);
 try{
  await expect(controller.command({action:'start',appUrl:'http://127.0.0.1:5080'})).rejects.toThrow('LFG recorder storage unavailable (EACCES)');
  expect(browserCalls).toBe(0);expect(sandboxCalls).toBe(0);
  await chmod(dir,0o750);await prepareRecordingDirectory(dir+'/repaired');
 }finally{await chmod(dir,0o750);await rm(root,{recursive:true,force:true});}
});
