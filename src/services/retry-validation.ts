import { validationShell } from './validation-sandbox.ts';
import { validateWithRepair, type PublicationOptions } from './validated-git.ts';
import { ValidationFailure } from './validation-contract.ts';
import { shellQuote as q } from './preview-plan.ts';

/** Reuse saved source only. Never check out, reset, implement the ticket or publish. */
export async function retrySavedValidation(o:PublicationOptions,baseline:string) {
 const r=await validationShell(o.workspaceId,`set -e\ncd ${q(o.projectDir)}\ngit branch --show-current\ngit rev-parse HEAD\ngit status --porcelain`);
 const [branch,sha,...dirty]=r.output.trim().split('\n');
 if(r.exitCode!==0 || branch!==o.featureBranch || !/^[a-f0-9]{40}$/.test(sha || ''))throw new ValidationFailure('The saved ticket checkout is missing or on a different branch. Validation retry will not overwrite it.');
 if(dirty.some(line=>line.trim()))throw new ValidationFailure('The saved checkout has uncommitted changes. Save or resolve them before retrying validation; no files were changed.');
 if(!/^[a-f0-9]{40}$/.test(baseline))throw new ValidationFailure('No saved validation baseline is available. Run the ticket build once to establish it.');
 o.validation.onLog?.(`Retrying validation of saved commit ${sha!.slice(0,12)}. Development is skipped; clean compilation, database and runtime checks still run. Nothing will be pushed or merged by this action.`);
 return validateWithRepair(o,o.projectDir,o.featureBranch,baseline,'ticket');
}
