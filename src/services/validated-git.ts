import { validationShell } from "./validation-sandbox.ts";
import { ValidationFailure, assertHeadsUnchanged, hashContract, type ValidationContext, type ValidationEvidence } from "./validation-contract.ts";
import { shellQuote as q } from "./preview-plan.ts";

export interface PublicationOptions {
  workspaceId:string;projectDir:string;featureBranch:string;repoUrl:string;githubToken?:string;tokenUser?:string;
  validation:ValidationContext;
}
const locks=new Map<string,Promise<unknown>>();
async function serialized<T>(key:string,fn:()=>Promise<T>):Promise<T> {
  const previous=locks.get(key)??Promise.resolve();let release!:()=>void;const current=new Promise<void>(r=>release=r);
  const tail=previous.catch(()=>{}).then(()=>current);locks.set(key,tail);
  await previous.catch(()=>{});try{return await fn();}finally{release();if(locks.get(key)===tail)locks.delete(key);}
}
export function checkedRef(ref:string) { if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)||ref.includes('..')||ref.includes('//')||ref.endsWith('.lock'))throw new ValidationFailure('Invalid publication branch');return ref; }
function client(o:PublicationOptions) {
  const url=new URL(o.repoUrl);if(o.githubToken){url.username=o.tokenUser??'x-access-token';url.password=o.githubToken;}
  const auth=url.toString();
  const secrets=new Set([auth,o.githubToken || '__NO_TOKEN__']);
  const redact=(output:string)=>{for(const secret of secrets)output=output.replaceAll(secret,'[credential]');return output;};
  const sh=async(script:string)=>{
    const remote=/\bgit\s+(?:fetch|push|ls-remote)\b/.test(script);
    let currentAuth=auth, token=o.githubToken;
    const refresh=async(rejected?:string)=>{
      if(!remote || !o.validation.gitCredentialUserId || url.hostname!=='gitlab.com')return;
      const {getValidGitlabToken}=await import('./gitlab-token.ts');
      token=await getValidGitlabToken(o.validation.gitCredentialUserId,rejected) || undefined;
      if(!token)throw new ValidationFailure('GitLab credentials could not be refreshed. Check the GitLab integration and OAuth configuration; committed work is preserved.');
      const fresh=new URL(o.repoUrl);fresh.username='oauth2';fresh.password=token;currentAuth=fresh.toString();secrets.add(token);secrets.add(currentAuth);
    };
    const execute=()=>validationShell(o.workspaceId,`set -eo pipefail\ncd ${q(o.projectDir)}\n${remote ? `git remote set-url origin ${q(currentAuth)}\n` : ''}${script.replaceAll(auth,currentAuth)}`,120_000);
    await refresh();let r=await execute();
    if(r.exitCode!==0 && remote && o.validation.gitCredentialUserId && url.hostname==='gitlab.com' && /HTTP Basic: Access denied|Authentication failed/i.test(r.output)){
      await refresh(token);r=await execute(); // Retry only an explicit authentication rejection, never a lost push response.
    }
    if(r.exitCode!==0)throw new ValidationFailure(redact(r.output)||'Git operation failed');return r.output.trim();
  };
  return {sh,auth};
}
/** Runtime verification reuses the existing sandbox for tickets and merge candidates. */
export async function validateWithRepair(o:PublicationOptions,dir:string,branch:string,baseline:string,kind:ValidationEvidence['kind']) {
  const {runTicketRuntime}=await import('./ticket-runtime.ts');
  return runTicketRuntime({...o,projectDir:dir,featureBranch:branch},undefined,{kind,baseline,allowDetached:kind!=="ticket"});
}
/** Point the ticket at its latest saved commit so a later failure still shows where the work is. */
async function recordSavedCommit(o:PublicationOptions,sha:string) {
  if(!o.validation.ticketId)return;
  const [{db},{projectTickets},{eq}]=await Promise.all([import('../config/db.ts'),import('../db/schema/tickets.ts'),import('drizzle-orm')]);
  await db.update(projectTickets).set({githubBranch:o.featureBranch,githubCommitSha:sha,updatedAt:new Date()}).where(eq(projectTickets.id,o.validation.ticketId)).catch(()=>{});
}
export async function publishValidatedTicket(o:PublicationOptions) {
  checkedRef(o.featureBranch);
  return serialized(`${o.repoUrl}:${o.featureBranch}`,async()=>{
    const {sh,auth}=client(o);
    await sh(`git remote set-url origin ${q(auth)}`);
    const old=await sh(`git ls-remote --heads origin ${q('refs/heads/'+o.featureBranch)} | cut -f1`);
    const baselineBranch=checkedRef(o.validation.baselineBranch??'main');
    await sh(`git fetch --no-tags origin ${q(baselineBranch)}`);
    const baseline=await sh('git rev-parse FETCH_HEAD');
    let remote=old;
    const push=async(sha:string)=>{
      if(sha===remote)return;
      await sh(`git push origin ${q(sha+':refs/heads/'+o.featureBranch)} ${q('--force-with-lease=refs/heads/'+o.featureBranch+':'+remote)}\ntest "$(git ls-remote --heads origin ${q('refs/heads/'+o.featureBranch)} | cut -f1)" = ${q(sha)}`);
      remote=sha;
    };
    // The build is saved before any check runs: a crashed sandbox or a failed check
    // must never be able to lose finished work. Checks and their repairs build on it.
    const branch=await sh('git branch --show-current');
    if(branch!==o.featureBranch)throw new ValidationFailure('Ticket checkout is on a different branch; refusing to save it.');
    await sh(`git add -A\nif ! git diff --cached --quiet; then git -c user.name='LFG Agent' -c user.email='agent@lfg.dev' commit -q -m 'feat: save ticket implementation (before checks)'; fi`);
    const saved=await sh('git rev-parse HEAD');
    await push(saved);
    await recordSavedCommit(o,saved);
    await o.validation.onCheckpoint?.(`**Build saved:** commit \`${saved.slice(0,7)}\` is pushed to \`${o.featureBranch}\` before checks run.`);
    const {loadBuildStageSettings}=await import('./build-stage-settings.ts');
    const settings=await loadBuildStageSettings(o.validation.projectId);
    let sha:string;
    if(settings.validationEnabled!==false && settings.featureTestingEnabled!==false && o.validation.ticketId){
      // Validation first; save its repairs, then test the saved app in the browser.
      const {runTicketRuntime}=await import('./ticket-runtime.ts');
      const validated=await runTicketRuntime(o,undefined,{kind:'ticket',baseline,phase:'validation'});
      await push(validated);
      await recordSavedCommit(o,validated);
      sha=await runTicketRuntime(o,undefined,{kind:'ticket',baseline,phase:'feature-testing'});
    } else {
      sha=await validateWithRepair(o,o.projectDir,o.featureBranch,baseline,'ticket');
    }
    await push(sha);
    return {sha,branch:o.featureBranch};
  });
}
export async function publishValidatedMerge(o:PublicationOptions & {targetBranch:string;baseBranch?:string;kind?:'integration'|'promotion'}) {
  checkedRef(o.featureBranch);checkedRef(o.targetBranch);checkedRef(o.baseBranch??'main');
  return serialized(`${o.repoUrl}:${o.targetBranch}`,async()=>{
    const startedAt=Date.now();
    const {sh,auth}=client(o);
    const heads=async()=>({source:await sh(`git ls-remote --heads origin ${q('refs/heads/'+o.featureBranch)} | cut -f1`),target:await sh(`git ls-remote --heads origin ${q('refs/heads/'+o.targetBranch)} | cut -f1`)});
    await sh(`git remote set-url origin ${q(auth)}\nif test "$(git rev-parse --is-shallow-repository)" = true; then git fetch --unshallow origin; fi`);
    const expected=await heads();if(!expected.source)throw new ValidationFailure('Source branch is not published');
    await sh(`git fetch --no-tags origin ${q(o.featureBranch)} ${q(expected.target?o.targetBranch:(o.baseBranch??'main'))}`);
    const baseline=expected.target||await sh(`git rev-parse ${q('origin/'+(o.baseBranch??'main'))}`);
    // The same source/target revisions resume the saved merge, including partial
    // repairs. Changed revisions get a different candidate and fresh validation.
    const candidate=`/data/validation-merge-${hashContract({root:o.projectDir,source:expected.source,baseline,target:o.targetBranch}).slice(0,32)}`;
    let published=false;
    try {
      const exists=await sh(`if test -e ${q(candidate+'/.git')}; then echo yes; fi`);
      if(exists==='yes') {
        await sh(`git -C ${q(candidate)} merge-base --is-ancestor ${q(baseline)} HEAD`);
        o.validation.onLog?.('Resuming the saved merge repair; ticket implementation will not run again.');
      } else {
        await sh(`git worktree add --detach ${q(candidate)} ${q(baseline)}`);
        const merged=await validationShell(o.workspaceId,`cd ${q(candidate)}; git -c user.name='LFG Agent' -c user.email='agent@lfg.dev' merge --no-commit --no-ff ${q(expected.source)} -m ${q('Integrate '+o.featureBranch)}`,120_000);
        if(merged.exitCode!==0 && !(await sh(`git -C ${q(candidate)} diff --name-only --diff-filter=U`)))throw new ValidationFailure('Merge candidate failed: '+merged.output);
      }
      const deadline=Date.now()+20*60_000;
      for(let attempt=0;attempt<2;attempt++) {
        const conflicts=await sh(`git -C ${q(candidate)} diff --name-only --diff-filter=U`);
        if(!conflicts)break;
        if(o.validation.cancelled?.())throw new ValidationFailure('Merge repair cancelled; candidate preserved.');
        o.validation.onLog?.(`Resolving ${conflicts.split('\n').length} merge conflict(s), attempt ${attempt+1}/2.`);
        const {runValidationRepair}=await import('./merge-resolver.ts');
        await runValidationRepair({projectId:o.validation.projectId,userId:o.validation.userId,workspaceId:o.workspaceId,projectDir:candidate,onLog:o.validation.onLog,cancelled:o.validation.cancelled,
          timeoutMs:Math.max(1,deadline-Date.now()),
          prompt:`Resolve only the pending merge conflicts in ${candidate}, preserving both branches' intent. Continue from existing partial resolutions. Inspect the conflict stages and make the smallest coherent resolution; do not rebuild the ticket, refactor unrelated code, or provision an app runtime. Do not commit, abort, reset, checkout, or push. Stage each resolved path with git add. Conflicted paths:\n${conflicts}\nBefore finishing, verify git diff --name-only --diff-filter=U is empty and git diff --cached --check passes. The server will commit and run configured validation after conflict resolution.`});
        await sh(`test "$(git -C ${q(candidate)} rev-parse HEAD)" = ${q(baseline)}`);
        if(Date.now()>=deadline)break;
      }
      const remaining=await sh(`git -C ${q(candidate)} diff --name-only --diff-filter=U`);
      if(remaining)throw new ValidationFailure('Merge repair left unresolved paths: '+remaining.split('\n').join(', '));
      await sh(`git -C ${q(candidate)} diff --check\ngit -C ${q(candidate)} diff --cached --check`);
      const candidateTree=await sh(`git -C ${q(candidate)} write-tree`);
      const sourceTree=await sh(`git rev-parse ${q(expected.source+'^{tree}')}`);
      let reused:any=null;
      if(candidateTree===sourceTree && !o.validation.requiredChecks?.length) {
        const local=await sh('if test -f .env; then git hash-object .env; else echo missing; fi');
        const {readReusableMergeEvidence}=await import('./validation-policy.ts');
        reused=await readReusableMergeEvidence(o,{revision:expected.source,tree:candidateTree,baseline},local);
      }
      let sha:string;
      if(reused) {
        if(o.validation.cancelled?.())throw new ValidationFailure('Merge cancelled');
        o.validation.onLog?.('Reusing ticket validation '+reused.id+': identical source tree, unchanged target baseline and environment in the same sandbox.');
        await sh(`git -C ${q(candidate)} -c user.name='LFG Agent' -c user.email='agent@lfg.dev' commit -m 'merge: integrate verified ticket'`);
        sha=await sh(`git -C ${q(candidate)} rev-parse HEAD`);
        if(await sh(`git rev-parse ${q(sha+'^{tree}')}`)!==candidateTree)throw new ValidationFailure('Merge tree changed after evidence reuse');
      } else {
        o.validation.onLog?.('Merge requires fresh checks: no matching ticket evidence for this tree, baseline and environment.');
        sha=await validateWithRepair(o,candidate,o.targetBranch,baseline,o.kind??'integration');
      }
      await sh(`git merge-base --is-ancestor ${q(expected.source)} ${q(sha)}\ngit merge-base --is-ancestor ${q(baseline)} ${q(sha)}`);
      assertHeadsUnchanged(expected,await heads());
      const files=(await sh(`git diff --name-only ${q(baseline)} ${q(sha)}`)).split('\n').filter(Boolean);
      await sh(`git push origin ${q(sha+':refs/heads/'+o.targetBranch)} ${q('--force-with-lease=refs/heads/'+o.targetBranch+':'+expected.target)}\ntest "$(git ls-remote --heads origin ${q('refs/heads/'+o.targetBranch)} | cut -f1)" = ${q(sha)}`);
      published=true;
      return {sha,files};
    } finally {
      o.validation.onLog?.(`Merge elapsed: ${Math.round((Date.now()-startedAt)/1000)} seconds.`);
      if(published)await validationShell(o.workspaceId,`git -C ${q(o.projectDir)} worktree remove --force ${q(candidate)}`).catch(()=>{});
      else o.validation.onLog?.(`Merge did not publish. Partial resolutions are preserved in ${candidate}; retry merging the saved ticket branch to continue.`);
    }
  });
}
