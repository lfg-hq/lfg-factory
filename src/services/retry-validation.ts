import { validationShell } from './validation-sandbox.ts';
import { validateWithRepair, type PublicationOptions } from './validated-git.ts';
import { ValidationFailure } from './validation-contract.ts';
import { shellQuote as q } from './preview-plan.ts';

/** Reuse saved source only. Never check out, reset, implement the ticket or publish. */
export async function retrySavedValidation(o:PublicationOptions,baseline:string,phase:'validation'|'feature-testing'|'checks'='checks') {
 const r=await validationShell(o.workspaceId,`set -e\ncd ${q(o.projectDir)}\ngit branch --show-current\ngit rev-parse HEAD\ngit status --porcelain`);
 const [branch,sha]=r.output.trim().split('\n');
 if(r.exitCode!==0 || branch!==o.featureBranch || !/^[a-f0-9]{40}$/.test(sha || ''))throw new ValidationFailure('The saved ticket checkout is missing or on a different branch. Validation retry will not overwrite it.');


 o.validation.onLog?.(phase==='feature-testing' ? 'Feature testing: starting an independent run on saved code.' : `Retrying ${phase==='checks'?'checks':'validation'} of saved commit ${sha!.slice(0,12)}. Development is skipped; the agent will check the existing database, restore dependencies and run the app. Nothing will be pushed or merged by this action.`);
 if(phase==='feature-testing')await o.validation.onCheckpoint?.(`**Resuming saved app:** Connected to ticket sandbox \`${o.workspaceId}\`, checkout \`${o.projectDir}\`, commit \`${sha!.slice(0,12)}\`. Checking whether its existing server is still responding before opening the browser. No replacement app sandbox was created.`);
 const {runTicketRuntime}=await import('./ticket-runtime.ts');
 // 'checks' is the combined stage: app startup, then the browser walkthrough.
 try {
  return await runTicketRuntime(o,undefined,{kind:'ticket',baseline,phase:phase==='checks'?undefined:phase});
 } catch(error) {
  // Skipping keeps the saved commit; unsaved repairs from this attempt are dropped.
  if(!o.validation.skipped?.())throw error;
  await o.validation.onCheckpoint?.(`**Checks skipped:** keeping saved commit \`${sha!.slice(0,7)}\`.`);
  return sha!;
 }
}
