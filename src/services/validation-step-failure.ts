import type { PlanStep } from "./preview-plan.ts";
import { failureSummary } from "./preview-plan.ts";
import { ValidationHttpFailure, ValidationEnvironmentFailure, ValidationSchemaFailure, ValidationFailure } from "./validation-contract.ts";

/** Put the diagnostic before the potentially huge command so cards retain the cause. */
export function validationStepFailure(step: PlanStep, upgrade: boolean, stage: string, evidenceId?: string) {
  const environment=step.phase === "toolchain" || step.phase === "install";
  const label=step.label === step.command || step.label.length > 160 ? `${step.phase} step` : step.label;
  const message=`${upgrade ? "Upgrade" : "Fresh"} ${stage} ${environment ? "environment" : "validation"} failed (${label}): ${failureSummary(step.error || "Command failed")}\nFailed command: ${step.command}`;
  return environment ? new ValidationEnvironmentFailure(message,evidenceId,stage) : step.phase === "schema" ? new ValidationSchemaFailure(message,evidenceId,stage) : step.id.includes("http-") ? new ValidationHttpFailure(message,evidenceId,stage) : new ValidationFailure(message,evidenceId);
}
