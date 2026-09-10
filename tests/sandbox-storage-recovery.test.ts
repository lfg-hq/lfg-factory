import {test,expect} from "bun:test";
import {isSandboxStorageFailure,recoverSandboxStorage,destroyWorkspaceAfterStop} from "../src/services/sandbox-storage-recovery.ts";
const failure = new Error("Git setup failed (exit 128): fatal: fsync error on '/data/project/.git/objects/pack/tmp_pack_123': I/O error\nfatal: fetch-pack: invalid index-pack output");
const activeJob=()=>Object.assign(new Error("workspace has 1 active job(s); stop them first"),{statusCode:409});
test("stops the job then waits through active-job conflicts before deletion completes",async()=>{
  const events:string[]=[];let calls=0;
  await destroyWorkspaceAfterStop({stop:async()=>{events.push("stop");},remove:async()=>{events.push("delete");if(calls++<2)throw activeJob();},wait:async()=>{events.push("wait");}});
  expect(events).toEqual(["stop","delete","wait","delete","wait","delete"]);
});
test("stop failure prevents deletion",async()=>{
  let deletes=0;
  await expect(destroyWorkspaceAfterStop({stop:async()=>{throw new Error("unauthorized");},remove:async()=>{deletes++;}})).rejects.toThrow("Could not stop");
  expect(deletes).toBe(0);
});
test("cleanup timeout never starts replacement",async()=>{
  let creates=0,deletes=0;
  await expect(recoverSandboxStorage({run:async()=>{throw failure;},discard:()=>destroyWorkspaceAfterStop({stop:async()=>{},remove:async()=>{deletes++;throw activeJob();},wait:async()=>{}}),create:async()=>{creates++;},onLog:async()=>{}})).rejects.toThrow("cleanup window");
  expect(creates).toBe(0);expect(deletes).toBe(30);
});
test("already removed jobs and workspaces are idempotent",async()=>{
  const missing=()=>Object.assign(new Error("not found"),{statusCode:404});
  await destroyWorkspaceAfterStop({stop:async()=>{throw missing();},remove:async()=>{throw missing();}});
});
test("recognizes observed Git fsync failure without treating auth or generic EIO as corruption",()=>{
  expect(isSandboxStorageFailure(failure)).toBe(true);
  for(const text of ["401 Incorrect API key","fatal: Authentication failed","Pi build failed: EIO: i/o error, read","fetch-pack: invalid index-pack output","connection timed out"])
    expect(isSandboxStorageFailure(new Error(text))).toBe(false);
});
test("destroys before provisioning and reruns checkout on the replacement",async()=>{
  const events:string[]=[];let vm="broken";
  const result=await recoverSandboxStorage({run:async()=>{events.push("clone:"+vm);if(vm==="broken")throw failure;return "remote-head";},
    discard:async()=>{events.push("destroy:"+vm);},create:async()=>{events.push("create");vm="fresh";},onLog:async()=>{}});
  expect(result).toBe("remote-head");expect(events).toEqual(["clone:broken","destroy:broken","create","clone:fresh"]);
});
test("repeated storage failure destroys replacement and stops without another allocation",async()=>{
  let creates=0,removes=0,runs=0;
  await expect(recoverSandboxStorage({run:async()=>{runs++;throw failure;},discard:async()=>{removes++;},create:async()=>{creates++;},onLog:async()=>{}})).rejects.toThrow("Storage failed again");
  expect([runs,removes,creates]).toEqual([2,2,1]);
});
test("failed or forbidden destruction cannot allocate a replacement",async()=>{
  let creates=0;
  await expect(recoverSandboxStorage({run:async()=>{throw failure;},discard:async()=>{throw new Error("shared sandbox protected");},create:async()=>{creates++;},onLog:async()=>{}})).rejects.toThrow("shared sandbox protected");
  expect(creates).toBe(0);
});
test("ordinary Git errors propagate without destroying the sandbox",async()=>{
  let removes=0;
  await expect(recoverSandboxStorage({run:async()=>{throw new Error("Authentication failed");},discard:async()=>{removes++;},create:async()=>{},onLog:async()=>{}})).rejects.toThrow("Authentication failed");
  expect(removes).toBe(0);
});
