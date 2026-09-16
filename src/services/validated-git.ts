import { validationShell } from "./validation-sandbox.ts";
import { ValidationFailure, assertHeadsUnchanged, type ValidationContext, type ValidationEvidence } from "./validation-contract.ts";
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
export async function publishValidatedTicket(o:PublicationOptions) {
  checkedRef(o.featureBranch);
  return serialized(`${o.repoUrl}:${o.featureBranch}`,async()=>{
    const {sh,auth}=client(o);
    await sh(`git remote set-url origin ${q(auth)}`);
    const old=await sh(`git ls-remote --heads origin ${q('refs/heads/'+o.featureBranch)} | cut -f1`);
    const baselineBranch=checkedRef(o.validation.baselineBranch??'main');
    await sh(`git fetch --no-tags origin ${q(baselineBranch)}`);
    const baseline=await sh('git rev-parse FETCH_HEAD');
    const sha=await validateWithRepair(o,o.projectDir,o.featureBranch,baseline,'ticket');
    await sh(`git push origin ${q(sha+':refs/heads/'+o.featureBranch)} ${q('--force-with-lease=refs/heads/'+o.featureBranch+':'+old)}\ntest "$(git ls-remote --heads origin ${q('refs/heads/'+o.featureBranch)} | cut -f1)" = ${q(sha)}`);
    return {sha,branch:o.featureBranch};
  });
}
export async function publishValidatedMerge(o:PublicationOptions & {targetBranch:string;baseBranch?:string;kind?:'integration'|'promotion'}) {
  checkedRef(o.featureBranch);checkedRef(o.targetBranch);checkedRef(o.baseBranch??'main');
  return serialized(`${o.repoUrl}:${o.targetBranch}`,async()=>{
    const {sh,auth}=client(o);const candidate=`/data/validation-merge-${crypto.randomUUID()}`;
    const heads=async()=>({source:await sh(`git ls-remote --heads origin ${q('refs/heads/'+o.featureBranch)} | cut -f1`),target:await sh(`git ls-remote --heads origin ${q('refs/heads/'+o.targetBranch)} | cut -f1`)});
    await sh(`git remote set-url origin ${q(auth)}\nif test "$(git rev-parse --is-shallow-repository)" = true; then git fetch --unshallow origin; fi`);
    const expected=await heads();if(!expected.source)throw new ValidationFailure('Source branch is not published');
    await sh(`git fetch --no-tags origin ${q(o.featureBranch)} ${q(expected.target?o.targetBranch:(o.baseBranch??'main'))}`);
    const baseline=expected.target||await sh(`git rev-parse ${q('origin/'+(o.baseBranch??'main'))}`);
    try {
      await sh(`git worktree add --detach ${q(candidate)} ${q(baseline)}`);
      const merged=await validationShell(o.workspaceId,`cd ${q(candidate)}; git -c user.name='LFG Agent' -c user.email='agent@lfg.dev' merge --no-commit --no-ff ${q(expected.source)} -m ${q('Integrate '+o.featureBranch)}`,120_000);
      if(merged.exitCode!==0) {
        const conflicts=await sh(`git -C ${q(candidate)} diff --name-only --diff-filter=U`);
        if(!conflicts)throw new ValidationFailure('Merge candidate failed: '+merged.output);
        const {runValidationRepair}=await import('./merge-resolver.ts');
        await runValidationRepair({projectId:o.validation.projectId,userId:o.validation.userId,workspaceId:o.workspaceId,projectDir:candidate,onLog:o.validation.onLog,cancelled:o.validation.cancelled,
          prompt:`Resolve the pending merge conflicts in ${candidate}, preserving both branches' intent. Do not commit, abort, reset, checkout, or push. Conflicted paths:\n${conflicts}\nThe server will commit and independently validate the merged application.`});
        await sh(`test "$(git -C ${q(candidate)} rev-parse HEAD)" = ${q(baseline)}\ngit -C ${q(candidate)} add -A`);
      }
      const sha=await validateWithRepair(o,candidate,o.targetBranch,baseline,o.kind??'integration');
      await sh(`git merge-base --is-ancestor ${q(expected.source)} ${q(sha)}\ngit merge-base --is-ancestor ${q(baseline)} ${q(sha)}`);
      assertHeadsUnchanged(expected,await heads());
      const files=(await sh(`git diff --name-only ${q(baseline)} ${q(sha)}`)).split('\n').filter(Boolean);
      await sh(`git push origin ${q(sha+':refs/heads/'+o.targetBranch)} ${q('--force-with-lease=refs/heads/'+o.targetBranch+':'+expected.target)}\ntest "$(git ls-remote --heads origin ${q('refs/heads/'+o.targetBranch)} | cut -f1)" = ${q(sha)}`);
      return {sha,files};
    } finally { await validationShell(o.workspaceId,`git -C ${q(o.projectDir)} worktree remove --force ${q(candidate)}`).catch(()=>{}); }
  });
}
