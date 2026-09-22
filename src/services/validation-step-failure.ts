import type { PlanStep } from "./preview-plan.ts";
import { failureSummary } from "./preview-plan.ts";
import { ValidationHttpFailure, ValidationEnvironmentFailure, ValidationSchemaFailure, ValidationFailure } from "./validation-contract.ts";

/** Exit 137 suggests SIGKILL, but does not by itself prove an OOM kill. */
export function isResourceFailure(output: string): boolean {
  return /(?:exited with code|exit(?:ed)?(?: code| status)?)[:\s]+137\b|out of memory|outofmemoryexception|oom[-_ ]kill|cannot allocate memory/i.test(output);
}

/** Put the diagnostic before the potentially huge command so cards retain the cause. */
export function validationStepFailure(step: PlanStep, upgrade: boolean, stage: string, evidenceId?: string) {
  const resource=isResourceFailure(step.error || "");
  const environment=resource || step.phase === "toolchain" || step.phase === "install";
  const label=step.label === step.command || step.label.length > 160 ? `${step.phase} step` : step.label;
  const message=`${upgrade ? "Upgrade" : "Fresh"} ${stage} ${environment ? "environment" : "validation"} failed (${label}): ${resource ? "Process terminated or memory allocation failed; exit 137 can indicate SIGKILL. Memory exhaustion is not confirmed by the exit code alone. " : ""}${failureSummary(step.error || "Command failed")}\nFailed command: ${step.command}`;
  return environment ? new ValidationEnvironmentFailure(message,evidenceId,stage) : step.phase === "schema" ? new ValidationSchemaFailure(message,evidenceId,stage) : step.id.includes("http-") ? new ValidationHttpFailure(message,evidenceId,stage) : new ValidationFailure(message,evidenceId);
}
