import {test,expect} from "bun:test";
import {runBackgroundCommand,backgroundLaunch} from "../src/services/background-command.ts";
function harness(states:(string|Error)[],launchError=false) {
  let time=0;const calls:string[]=[];
  return {calls,deps:{now:()=>time,wait:async()=>{time+=2000;},exec:async (_:string,command:string)=>{
    calls.push(command);
    if(command.includes("mkdir -p /data/lfg-jobs")){if(launchError)throw new Error("lost launch response");return {exitCode:0,output:"STARTED"};}
    if(command.includes("kill -TERM --"))return {exitCode:0,output:""};
    const state=states.shift() ?? "RUNNING";if(state instanceof Error)throw state;return {exitCode:0,output:state};
  }}};
}
test("keeps polling through silence and transient transport failures without rerunning",async()=>{
  const h=harness(["RUNNING",new Error("context deadline exceeded"),"RUNNING","DONE\n0\ninstalled"]);
  const r=await runBackgroundCommand({workspaceId:"vm",command:"install-sdk",jobId:"sdk"},h.deps);
  expect(r.output).toBe("installed");expect(r.exitCode).toBe(0);
  expect(h.calls.filter(c=>c.includes("mkdir -p /data/lfg-jobs")).length).toBe(1);
  expect(h.calls.some(c=>c.includes("kill -TERM --"))).toBe(false);
});
test("uncertain launch attaches to existing result",async()=>{
  const h=harness(["RUNNING","DONE\n7\ninstall failed"],true);
  const r=await runBackgroundCommand({workspaceId:"vm",command:"install",jobId:"same-job"},h.deps);
  expect(r.exitCode).toBe(7);expect(r.jobId).toBe("same-job");
  expect(h.calls.filter(c=>c.includes("mkdir -p /data/lfg-jobs")).length).toBe(1);
});
test("launch script guards duplicate starts and writes exit atomically",()=>{
  const script=backgroundLaunch("/data/lfg-jobs/a","sleep 100","/data",1800);
  expect(script).toContain("if mkdir");expect(script).toContain("JOB_REQUEST_MISMATCH");
  expect(script).toContain("setsid");expect(script).toContain("exit.tmp");expect(script).toContain("timeout -k 10 1800");
});
test("maximum runtime stops the job and reports its saved log",async()=>{
  const h=harness([]);
  await expect(runBackgroundCommand({workspaceId:"vm",command:"sleep forever",timeoutMs:1000,jobId:"slow"},h.deps)).rejects.toThrow("maximum runtime");
  expect(h.calls.some(c=>c.includes("kill -TERM --"))).toBe(true);
});
test("cancellation stops the job",async()=>{
  const h=harness([]);
  await expect(runBackgroundCommand({workspaceId:"vm",command:"install",cancelled:()=>true},h.deps)).rejects.toThrow("cancelled");
  expect(h.calls.some(c=>c.includes("kill -TERM --"))).toBe(true);
});
test("missing completion record fails explicitly rather than becoming success",async()=>{
  const h=harness(["LOST\nprocess terminated"]);
  await expect(runBackgroundCommand({workspaceId:"vm",command:"install"},h.deps)).rejects.toThrow("without a completion record");
});
test("completion log identifies command and exit status",async()=>{
 const h=harness(["DONE\n7\nfailed download"]);const logs:string[]=[];
 await runBackgroundCommand({workspaceId:"vm",command:"install-sdk",jobId:"sdk",log:s=>logs.push(s)},h.deps);
 expect(logs[0]).toContain("command: install-sdk");expect(logs.at(-1)).toContain("finished (exit 7,");
});
test('terminal output stops only the current process group and returns failure immediately', async()=>{
 const h=harness(['RUNNING\nerror NU1301: Unable to load service index']);
 const r=await runBackgroundCommand({workspaceId:'vm',command:'restore',abortOnOutput:output=>output.includes('error NU1301:')?'Package source unavailable':undefined},h.deps);
 expect(r.exitCode).toBe(1);expect(r.output).toContain('NU1301');
 expect(h.calls.filter(c=>c.includes('mkdir -p /data/lfg-jobs'))).toHaveLength(1);
 expect(h.calls.some(c=>c.includes('kill -TERM --') && c.includes('kill -KILL --'))).toBe(true);
});
test('unchanged polled output is logged once, while changed output is reported', async()=>{
 const h=harness([...Array(20).fill('RUNNING\nsame output'),...Array(20).fill('RUNNING\nnew output'),'DONE\n0\nfinished']);
 const logs:string[]=[];
 await runBackgroundCommand({workspaceId:'vm',command:'work',log:s=>logs.push(s)},h.deps);
 expect(logs.filter(s=>s.includes('still running')&&s.includes('same output'))).toHaveLength(1);
 expect(logs.filter(s=>s.includes('still running')&&s.includes('new output'))).toHaveLength(1);
});
