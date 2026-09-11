import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import { describe, test, expect, mock } from "bun:test";
let result = {exitCode:0,output:"GIT_SETUP_COMPLETE\nGIT_CHECKOUT_VERIFIED\n",stderr:""};
let command = "";
let probeInput: any;
let executed: string[]=[];
let sdkExit=0;
mock.module("../src/services/app-profile.ts",()=>({
  loadAppProfile:async()=>({profile:{stack:".NET 8",runtimeVersion:"net8.0",toolchain:["install-sdk"],directives:["Match Linux asset casing"],environmentOverrides:["must-not-copy"]}}),
  probeAppProfile:async (opts:any)=>{probeInput=opts;return {stack:".NET 8",runtime:"dotnet",runtimeVersion:"net8.0",toolchain:["install-sdk"]};}
}));
mock.module("../src/services/background-command.ts",()=>({runBackgroundCommand:async (o:{command:string})=>{executed.push(o.command);return {exitCode:sdkExit,output:"SDK installation failed"};}}));
mock.module("../src/services/mags.ts",()=>({execOnWorkspace:async (_:string,c:string)=>{command=c;return result;}}));
const {runGitSetup,redactSetupOutput,runtimeCheck,prepareBuildRuntime,refreshOriginCommand}=await import("../src/services/build-preflight.ts");
describe("build preflight",()=>{
  test("preserves stderr-only failure and redacts credentials",async()=>{
    result={exitCode:128,output:"",stderr:"fatal: authentication failed for https://oauth2:secret@git.example/repo"};
    await expect(runGitSetup("vm","git clone repo","/data/project","feature/a",["secret"])).rejects.toThrow("Reconnect your Git provider");
    try { await runGitSetup("vm","git clone repo","/data/project","feature/a",["secret"]); } catch(e) {
      expect((e as Error).message).toContain("authentication failed");expect((e as Error).message).not.toContain("secret");
    }
  });
  test("missing completion evidence is a blocker even with exit zero",async()=>{
    result={exitCode:0,output:"",stderr:""};
    await expect(runGitSetup("vm","true","/data/project","feature/a")).rejects.toThrow("No stdout or stderr");
  });
  test("nonzero status cannot be overridden by an earlier success marker",async()=>{
    result={exitCode:1,output:"GIT_CHECKOUT_VERIFIED",stderr:"checkout failed"};
    await expect(runGitSetup("vm","true","/data/project","feature/a")).rejects.toThrow("checkout failed");
  });
  test("requires branch and HEAD verification and runs fail-fast",async()=>{
    result={exitCode:0,output:"GIT_CHECKOUT_VERIFIED\n",stderr:""};
    await runGitSetup("vm","echo setup","/data/project","feature/a");
    const script=Buffer.from(command.split(" ")[1],"base64").toString();
    expect(script).toContain("set -e");expect(script).toContain("git rev-parse --verify HEAD");expect(script).toContain("git branch --show-current");expect(script).toContain("GIT_TERMINAL_PROMPT=0");
  });
  test("SDK verification requires an SDK rather than only dotnet runtime",()=>{
    expect(runtimeCheck("dotnet")).toContain("--list-sdks");
    expect(()=>runtimeCheck("unrecognized")).toThrow("No build runtime verification");
    expect(redactSetupOutput("token abc",["abc"])).toBe("token [redacted]");
  });
  test("reuses preview knowledge and installs before verifying target SDK",async()=>{
    executed=[];sdkExit=0;
    await prepareBuildRuntime({workspaceId:"vm",projectId:"p",branch:"feature/a",dir:"/data/project",userId:"u",onLog:()=>{}});
    expect(probeInput.knowledge.join(" ")).toContain("Match Linux asset casing");
    expect(probeInput.knowledge.join(" ")).not.toContain("must-not-copy");
    expect(executed[0]).toContain("install-sdk");
    expect(executed[1]).toContain("grep -q '^8\\.'");
  });
  test("SDK installation failure blocks without claiming runtime ready",async()=>{
    executed=[];sdkExit=127;const logs:string[]=[];
    await expect(prepareBuildRuntime({workspaceId:"vm",projectId:"p",branch:"a",dir:"/data/project",userId:"u",onLog:s=>logs.push(s)})).rejects.toThrow("exit 127");
    expect(executed.length).toBe(1);
    expect(logs.some(s=>s.includes("runtime ready"))).toBe(false);
  });
});

test("reused repository replaces stale origin credentials, including duplicate URLs",()=>{
  const dir=mkdtempSync(join(tmpdir(),"lfg-origin-"));
  try {
    execFileSync("git",["init","-q",dir]);
    const git=(...args:string[])=>execFileSync("git",["-C",dir,...args],{encoding:"utf8"});
    git("config","--add","remote.origin.url","https://oauth2:expired@gitlab.com/team/repo.git");
    git("config","--add","remote.origin.url","https://oauth2:older@gitlab.com/team/repo.git");
    const fresh="https://oauth2:fresh-token@gitlab.com/team/repo.git";
    execFileSync("sh",["-ec",refreshOriginCommand(fresh)],{cwd:dir});
    expect(git("config","--get-all","remote.origin.url").trim()).toBe(fresh);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("GitLab auth failure gives reconnect guidance without exposing token",async()=>{
  result={exitCode:128,output:"REPO_EXISTS",stderr:"remote: HTTP Basic: Access denied. fatal: Authentication failed for https://oauth2:secret@gitlab.com/team/repo.git"};
  try {await runGitSetup("vm","true","/data/project","a",["secret"]);throw new Error("expected failure");}
  catch(e){expect((e as Error).message).toContain("Reconnect GitLab in Settings");expect((e as Error).message).not.toContain("secret");}
});
