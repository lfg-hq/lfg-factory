/** Pure preview plan contracts. No database/VM imports: exercised with fake executors. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const schemaStepSchema = z.object({
  kind: z.enum(["migration", "sqlScript", "seed"]),
  command: z.string().min(1),
  connectionKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional().describe("For SQL files: exact databases[].connectionEnvVar identifying the target connection. Required when multiple databases exist."),
  note: z.string().default(""),
  verify: z.string().optional().describe("Read-only command returning zero only if this schema step is already applied. Required for non-idempotent scripts/seeds."),
});
export const replayActionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  phase: z.enum(["beforeBuild", "afterBuild", "beforeSchema", "verify"]),
  command: z.string(),
  verify: z.string().min(1).describe("Read-only assertion returning zero only when the required outcome holds."),
  note: z.string().default(""),
});
export type ReplayAction = z.infer<typeof replayActionSchema>;
export type SchemaStep = z.infer<typeof schemaStepSchema>;
export type PlanStep = {
  id: string; phase: "prepare" | "toolchain" | "install" | "build" | "schema" | "run" | "verify" | "recovery";
  label: string; command: string; verify?: string;
  status: "pending" | "running" | "done" | "failed";
  error?: string; startedAt?: string; finishedAt?: string; attempt?: number;
  optional?: boolean;
};
export function orderedSchema(plan: { schemaSteps?: SchemaStep[]; migrations?: string[]; sqlScripts?: string[]; seedCmd?: string }): SchemaStep[] {
  return plan.schemaSteps ?? [
    ...(plan.migrations ?? []).map(command => ({ kind: "migration" as const, command, note: "" })),
    ...(plan.sqlScripts ?? []).map(command => ({ kind: "sqlScript" as const, command, note: "" })),
    ...(plan.seedCmd ? [{ kind: "seed" as const, command: plan.seedCmd, note: "" }] : []),
  ];
}
export function mergeKnowledge<T extends { learnings?: string[]; directives?: string[]; recoveryBackups?: Array<{id:string}>; configPatches?: Array<{file:string;find:string}>; replayActions?: ReplayAction[]; environmentOverrides?: Array<{key:string;encryptedValue:string}> }>(next: T, previous?: T): T {
  if (!previous) return next;
  const keyed = <V>(a: V[], b: V[], key: (v: V) => string) => [...new Map([...a, ...b].map(v => [key(v), v])).values()];
  return { ...next,
    learnings: [...new Set([...(previous.learnings ?? []), ...(next.learnings ?? [])])],
    directives: [...new Set([...(previous.directives ?? []), ...(next.directives ?? [])])],
    recoveryBackups: keyed(previous.recoveryBackups ?? [], next.recoveryBackups ?? [], p => p.id),
    configPatches: keyed(previous.configPatches ?? [], next.configPatches ?? [], p => `${p.file}\0${p.find}`),
    environmentOverrides: keyed(previous.environmentOverrides ?? [], next.environmentOverrides ?? [], p => p.key),
    replayActions: keyed(previous.replayActions ?? [], next.replayActions ?? [], p => p.id),
  };
}
export function failureSummary(output: string, limit = 2400): string {
  const text = output.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@").replace(/\x1b\[[0-9;]*m/g, "").replace(/(Password|Pwd|API_KEY|token)(\s*[=:]\s*)[^;\s"']+/gi, "$1$2[redacted]");
  const lines = text.split("\n");
  const first = lines.findIndex(line => /(?:exception|error\b|failed|fatal|pendingmodelchanges|conflicting assets|recovery stopped|tar:|invalid magic|short read)/i.test(line) && !/^\s*at /.test(line));
  return (first >= 0 ? lines.slice(first, first + 16).join("\n") : text).slice(0, limit).trim();
}
export function failureKey(revision: string, step: PlanStep, output: string): string {
  return createHash("sha256").update(JSON.stringify([revision, step.id, step.command, failureSummary(output).replace(/\b\d{2}:\d{2}:\d{2}\b/g, "")] )).digest("hex");
}
export function shellQuote(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

/** Every success comes from execution or an explicit assertion, never an old step ID. */
export async function executeSteps(steps: PlanStep[], io: {
  run: (step: PlanStep, command: string) => Promise<{exitCode: number; output: string}>;
  persist: () => Promise<void>;
  cancelled: () => boolean;
}): Promise<PlanStep | null> {
  for (const step of steps) {
    if (step.phase === "prepare" || step.phase === "recovery") continue;
    if (io.cancelled()) throw new Error("__CANCELLED__");
    step.status = "running"; step.startedAt = new Date().toISOString(); step.error = undefined;
    step.attempt = (step.attempt ?? 0) + 1;
    await io.persist();
    try {
      // Assertions can avoid repeating non-idempotent schema setup or costly installation.
      let result = step.verify ? await io.run(step, step.verify) : null;
      if (result?.exitCode === -3 || io.cancelled()) throw new Error("__CANCELLED__");
      if (!result || result.exitCode !== 0) {
        result = await io.run(step, step.command);
        if (result.exitCode === -3 || io.cancelled()) throw new Error("__CANCELLED__");
        if (result.exitCode === 0 && step.verify) result = await io.run(step, step.verify);
      }
      if (result.exitCode === -3 || io.cancelled()) throw new Error("__CANCELLED__");
      if (result.exitCode !== 0) throw new Error(failureSummary(result.output) || `Command exited ${result.exitCode}`);
      step.status = "done";
    } catch (e) {
      if ((e as Error).message === "__CANCELLED__") { step.status = "pending"; await io.persist(); throw e; }
      step.status = "failed"; step.error = failureSummary((e as Error).message);
    }
    step.finishedAt = new Date().toISOString();
    await io.persist();
    if (step.status === "failed") return step;
  }
  return null;
}

/** Never manufacture duplicate assets to repair Linux references. */
export function assetCaseCheck(dir: string): string {
  return `python3 - ${shellQuote(dir)} <<'PYEOF'
import os, sys
base = sys.argv[1]
bad = []
for root, dirs, files in os.walk(base):
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "bin", "obj")]
    if "wwwroot" not in root.split(os.sep): continue
    seen = {}
    for name in dirs + files:
        key = name.casefold()
        if key in seen:
            bad.append(os.path.relpath(os.path.join(root, seen[key]), base) + " / " + name)
        seen[key] = name
if bad:
    print("Static asset case collision. Remove preview-created aliases and fix references to the canonical filename; do not recreate aliases after building.")
    print("\\n".join(bad[:30]))
    sys.exit(1)
PYEOF`;
}


export function validateSchemaTargets(steps: SchemaStep[], databases: Array<{connectionEnvVar:string;engine:string}>) {
  const sql=databases.filter(d=>d.engine!=="redis");
  for (const step of steps.filter(s=>s.kind==="sqlScript")) {
    if (step.connectionKey && !sql.some(d=>d.connectionEnvVar===step.connectionKey))
      throw new Error(`SQL_TARGET_REQUIRED: Unknown connectionKey for ${step.command}: ${step.connectionKey}`);
    if (!step.connectionKey && sql.length>1)
      throw new Error(`SQL_TARGET_REQUIRED: Set connectionKey for ${step.command} in schemaSteps. Available connections: ${sql.map(d=>d.connectionEnvVar).join(', ')}. Persist this mapping before schema repair; retain migrations before dependent scripts and target the same connection in verify.`);
  }
}
