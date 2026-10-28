import { z } from "zod";
import { createHash } from "node:crypto";
export const validationPolicySchema = z.object({
  kind: z.enum(["application", "library", "documents"]),
  tests: z.array(z.string().min(1)).min(1).describe("Real acceptance/regression test commands read from or added to the repository. Never echo/true/skip placeholders."),
  upgradeSetup: z.string().min(1).optional().describe("Candidate-owned command that inserts representative baseline data BEFORE candidate migrations. Use isolated connection environment variables. Required for SQL upgrade validation unless the baseline recipe already has seeds."),
  note: z.string().default("").describe("What these tests cover for this ticket/epic."),
});
export interface ValidationContext {
  projectId: string; userId: string; ticketId?: string; epicId?: string;
  gitCredentialUserId?: string;
  baselineBranch?: string;
  requiredChecks?: string[];
  onLog?: (message: string) => void;
  onCheckpoint?: (message: string) => Promise<void> | void;
  cancelled?: () => boolean;
  /** Only a real stop (the user pressed Stop). Checks being off is not a stop: merge conflicts
   *  still have to be resolved for the change to publish. Falls back to `cancelled`. */
  stopped?: () => boolean;
  /** The user chose to skip checks: keep the committed build and continue. */
  skipped?: () => boolean;
}
export interface ValidationEvidence {
  id: string; projectId: string; branch: string; revision: string; tree: string;
  baseline: string; planHash: string; environmentHash: string;
  kind: "ticket" | "integration" | "promotion"; status: "passed" | "failed" | "running";
  mode?: "existing-sandbox"; runtimePassed?:boolean;
  freshPassed: boolean; upgradePassed: boolean; error?: string;
}
export class ValidationFailure extends Error {
  readonly code = "VALIDATION_FAILED";
  readonly failureKind: "runtime" | "environment" | "schema" | "http" = "runtime";
  constructor(message: string, readonly evidenceId?: string) { super(message); this.name = "ValidationFailure"; }
}
export class ValidationEnvironmentFailure extends ValidationFailure {
  override readonly failureKind = "environment" as const;
  constructor(message:string,evidenceId?:string,readonly stage='candidate'){super(message,evidenceId);this.name='ValidationEnvironmentFailure';}
}
export class ValidationSchemaFailure extends ValidationFailure {
  override readonly failureKind = "schema" as const;
  constructor(message:string,evidenceId?:string,readonly stage='candidate'){super(message,evidenceId);this.name='ValidationSchemaFailure';}
}
export class ValidationHttpFailure extends ValidationFailure {
  override readonly failureKind = "http" as const;
  constructor(message:string,evidenceId?:string,readonly stage='candidate'){super(message,evidenceId);this.name='ValidationHttpFailure';}
}
export function hashContract(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function assertEvidence(e: ValidationEvidence, expected: { projectId: string; branch: string; revision: string; baseline?: string; planHash?: string; environmentHash?: string }) {
  if (e.status !== "passed" || !e.freshPassed || !e.upgradePassed || e.projectId !== expected.projectId || e.branch !== expected.branch ||
    e.revision !== expected.revision || (expected.baseline !== undefined && e.baseline !== expected.baseline) ||
    (expected.planHash !== undefined && e.planHash !== expected.planHash) || (expected.environmentHash !== undefined && e.environmentHash !== expected.environmentHash))
    throw new ValidationFailure("Missing, failed or stale runtime validation. Validate the exact candidate again.", e.id);
}
/** Optimistic promotion after validation: no force push may overwrite a changed target. */
export function assertHeadsUnchanged(expected: {source: string; target: string}, actual: {source: string; target: string}) {
  if (expected.source !== actual.source || expected.target !== actual.target)
    throw new ValidationFailure("The source or target branch changed during validation. Rebuild and validate a new merge candidate.");
}
