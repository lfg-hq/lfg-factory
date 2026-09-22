import { orderedSchema, assetCaseCheck, type PlanStep, type SchemaStep, type ReplayAction } from "./preview-plan.ts";

/** Shared plan compiler: preview and build validation run the same ordered stages. */
export interface RuntimeRecipe {
  runtime: string; framework: string; toolchain: string[]; installCmd: string; buildCmd: string; runCmd: string;
  schemaSteps?: SchemaStep[]; migrations?: string[]; sqlScripts?: string[]; seedCmd?: string;
  replayActions?: ReplayAction[]; verificationPaths?: string[];
}
export function compileRuntimePlan(recipe: RuntimeRecipe, io: {
  dir: string; localize: (command: string) => string;
  configure: string; start: string; sql: (file: string, step: SchemaStep) => string;
  http: (path: string) => string; beforeSchema?: string[]; tests?: string[]; application?: boolean;
}): PlanStep[] {
  const steps: PlanStep[] = [];
  const add = (id: string, phase: PlanStep["phase"], command: string, label = command, verify?: string) =>
    steps.push({ id, phase, command: io.localize(command), label, verify: verify ? io.localize(verify) : undefined, status: "pending" });
  const actions = (phase: ReplayAction["phase"]) => (recipe.replayActions ?? []).filter(a => a.phase === phase)
    .forEach(a => add(`action-${a.id}`, phase === "verify" ? "verify" : "build", a.command, a.note || a.id, a.verify));
  recipe.toolchain.forEach((command, i) => add(`toolchain-${i}`, "toolchain", command));
  add("configuration", "install", io.configure, "Configure isolated runtime");
  if (recipe.installCmd) add("install", "install", recipe.installCmd);
  actions("beforeBuild");
  const dotnet = /dotnet|aspnet/i.test(recipe.runtime + recipe.framework);
  if (dotnet) add("asset-case", "build", assetCaseCheck(io.dir), "Check static asset casing");
  if (recipe.buildCmd) add("build", "build", recipe.buildCmd);
  actions("afterBuild");
  if (dotnet) add("asset-case-after-build", "build", assetCaseCheck(io.dir), "Verify build did not recreate case aliases");
  actions("beforeSchema");
  (io.beforeSchema ?? []).forEach((command,i)=>add(`upgrade-fixture-${i}`, "schema", command, "Prepare representative baseline data"));
  orderedSchema(recipe).forEach((s, i) => add(`schema-${i}`, "schema",
    s.kind !== "migration" && !s.verify ? "echo 'Schema scripts and seeds require a read-only verify assertion'; exit 1"
      : s.kind === "sqlScript" ? io.sql(s.command, s) : s.command,
    s.note || `${s.kind}: ${s.command}`, s.verify));
  if (io.application !== false) {
    add("run", "run", io.start, `Start app: ${recipe.runCmd}`);
    for (const [i, path] of [...new Set(["/", ...(recipe.verificationPaths ?? [])])].entries())
      add(`http-${i}`, "verify", io.http(path), `Verify route ${path}`);
  }
  actions("verify");
  (io.tests ?? []).forEach((command, i) => add(`test-${i}`, "verify", command, `Acceptance/regression test: ${command}`));
  return steps;
}
