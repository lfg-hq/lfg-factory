import { eq, and, desc } from "drizzle-orm";
import { db } from "../config/db.ts";
import { runtimeValidations } from "../db/schema/runtime-validation.ts";
import { appProfileSchema, probeAppProfile, type AppProfile } from "./app-profile.ts";
import { compileRuntimePlan } from "./runtime-plan.ts";
import { executeSteps, shellQuote as q, type PlanStep } from "./preview-plan.ts";
import { ValidationFailure, hashContract, type ValidationContext, type ValidationEvidence } from "./validation-contract.ts";
import { validationShell, runValidationCommand, environmentScript, cleanupEnvironmentScript, type ValidationEnvironment } from "./validation-sandbox.ts";

export const CONTRACT_FILE = ".lfg-validation.json";
export const CONTRACT_INSTRUCTION = `Maintain .lfg-validation.json at the repository root using the app profile schema. Include validation.kind (application/library/documents), validation.tests (real regression/acceptance commands), validation.upgradeSetup (representative baseline data fixtures before migrations), all database connection environment keys, complete ordered schemaSteps, and verificationPaths for the changed feature. Tests must fail on regressions. Never suppress migration errors, fake migration history, skip tests, or create duplicate Linux asset case aliases. Source repairs and the recipe must be committed together. The server independently validates a clean commit with fresh and baseline-upgrade databases before publication. Do not commit or push yourself.`;

export async function ensureValidationRecipe(workspaceId:string, dir:string, ctx:ValidationContext, baseline = false):Promise<AppProfile> {
  const read = await validationShell(workspaceId, `cd ${q(dir)}; if test -f ${q(CONTRACT_FILE)}; then cat ${q(CONTRACT_FILE)}; else echo MISSING_CONTRACT; fi`);
  if(read.exitCode!==0) throw new ValidationFailure("Cannot read validation contract");
  if(!read.output.trim().endsWith("MISSING_CONTRACT")) {
    try { const p=appProfileSchema.parse(JSON.parse(read.output)); checkRecipe(p, baseline); return p; }
    catch(e) { throw new ValidationFailure(`Invalid ${CONTRACT_FILE}: ${(e as Error).message}`); }
  }
  ctx.onLog?.("Probing the candidate for a versioned runtime and test recipe…");
  const p = await probeAppProfile({workspaceId,userId:ctx.userId,workDir:dir,onLog:ctx.onLog,
    knowledge:[CONTRACT_INSTRUCTION, "Include validation with actual test commands found in this repository. List EVERY database connection key, including aliases. No external database or Redis endpoints. Use $PORT in foreground runCmd; use relative repository paths. Do not write secret values into the recipe."]});
  if(!p) throw new ValidationFailure("Probe did not produce a validation recipe");
  // Runtime patches are not accepted as substitutes for committed source repairs.
  delete p.configPatches; delete p.environmentOverrides; delete p.verifiedRevision; delete p.inputFingerprint; delete p.blockedFailure;
  checkRecipe(p, baseline);
  const encoded=Buffer.from(JSON.stringify(p,null,2)+"\n").toString("base64");
  const written=await validationShell(workspaceId,`cd ${q(dir)}; echo ${encoded} | base64 -d > ${q(CONTRACT_FILE)}`);
  if(written.exitCode!==0) throw new ValidationFailure("Could not save runtime recipe");
  return p;
}
export function checkRecipe(p:AppProfile, baseline = false) {
  if(!baseline && !p.validation?.tests.length) throw new ValidationFailure("No real acceptance/regression test commands are recorded. Add tests and validation to .lfg-validation.json.");
  if(p.validation?.tests.some(t=>/^\s*(true|echo\b|exit\s+0\b)|\|\|\s*(true|exit\s+0)\s*$/.test(t))) throw new ValidationFailure("Placeholder or error-suppressing validation tests are not accepted");
  if(p.configPatches?.length || p.environmentOverrides?.length) throw new ValidationFailure("Commit source repairs; validation cannot rely on hidden preview patches or encrypted overrides");
  if(p.secretsRequired.length) throw new ValidationFailure(`Validation requires test substitutes for external services: ${p.secretsRequired.map(s=>s.key).join(", ")}`);
}

export async function latestValidation(projectId:string,branch:string,revision:string) {
  const [row]=await db.select().from(runtimeValidations).where(and(eq(runtimeValidations.projectId,projectId),eq(runtimeValidations.branch,branch),eq(runtimeValidations.revision,revision),eq(runtimeValidations.status,"passed"))).orderBy(desc(runtimeValidations.createdAt)).limit(1);
  return row ? JSON.parse(row.evidence) as ValidationEvidence : null;
}

/** Server-owned clean-checkout validation. Uses only the supplied workspace and newly allocated service containers. */
export async function validateRevision(o:{workspaceId:string;sourceDir:string;revision:string;branch:string;baseline?:string;kind?:ValidationEvidence["kind"];context:ValidationContext}):Promise<ValidationEvidence> {
  const ctx=o.context; const id=crypto.randomUUID(); const steps:PlanStep[]=[];
  const evidence:ValidationEvidence={id,projectId:ctx.projectId,branch:o.branch,revision:o.revision,tree:"",baseline:o.baseline??"",planHash:"",environmentHash:"",kind:o.kind??"ticket",status:"running",freshPassed:false,upgradePassed:false};
  await db.insert(runtimeValidations).values({id,projectId:ctx.projectId,ticketId:ctx.ticketId,epicId:ctx.epicId,branch:o.branch,revision:o.revision,baseline:evidence.baseline,kind:evidence.kind,status:"running",evidence:JSON.stringify(evidence)});
  const persist=async()=>{await db.update(runtimeValidations).set({status:evidence.status,evidence:JSON.stringify(evidence),steps:JSON.stringify(steps.map(s=>s.phase==="run"?{...s,command:"[isolated app launcher]"}:s)),...(evidence.status!=="running"?{completedAt:new Date()}: {})}).where(eq(runtimeValidations.id,id));};
  const shell=async(script:string)=>{const r=await validationShell(o.workspaceId,script);if(r.exitCode!==0)throw new ValidationFailure(r.output||"Validation sandbox command failed",id);return r.output.trim();};
  const groups:Array<{scope:string;root:string;dirs:string[]}>=[];
  const cleanup = async (g: typeof groups[number]) => {
      await validationShell(o.workspaceId,`if test -f ${q(g.root+'/app.pid')}; then p=$(cat ${q(g.root+'/app.pid')}); case "$p" in ''|*[!0-9]*) ;; *) kill -TERM -- -"$p" 2>/dev/null || true; sleep 1; kill -KILL -- -"$p" 2>/dev/null || true;; esac; fi`).catch(()=>{});
      for(const dir of g.dirs)await validationShell(o.workspaceId,`git -C ${q(o.sourceDir)} worktree remove --force ${q(dir)}`).catch(()=>{});
      await validationShell(o.workspaceId,cleanupEnvironmentScript(g.scope,g.root)).catch(()=>{});
  };
  try {
    if(!/^[a-f0-9]{40}$/.test(o.revision)|| (o.baseline && !/^[a-f0-9]{40}$/.test(o.baseline))) throw new ValidationFailure("Validation requires immutable commit IDs");
    await shell(`command -v bash >/dev/null || apk add --no-cache bash; command -v python3 >/dev/null || apk add --no-cache python3; command -v curl >/dev/null || apk add --no-cache curl; command -v setsid >/dev/null || apk add --no-cache util-linux`);
    evidence.tree=await shell(`git -C ${q(o.sourceDir)} rev-parse ${q(o.revision+'^{tree}')}`);
    const raw=await shell(`git -C ${q(o.sourceDir)} show ${q(o.revision+':'+CONTRACT_FILE)}`);
    const recipe=appProfileSchema.parse(JSON.parse(raw)); checkRecipe(recipe);
    evidence.planHash=hashContract(recipe); evidence.environmentHash=hashContract({version:1,databases:recipe.databases,runtime:recipe.runtimeVersion});
    const pass=async(upgrade:boolean)=>{
      const scope=`val-${crypto.randomUUID()}`;const root=`/data/validation/${scope}`;const group={scope,root,dirs:[] as string[]};groups.push(group);
      await shell(`mkdir -p ${q(root)}; chmod 700 ${q(root)}`);
      if(recipe.databases.length) await shell(`if ! docker info >/dev/null 2>&1; then command -v docker >/dev/null || apk add --no-cache docker docker-cli; mkdir -p /data/docker /etc/docker; test -f /etc/docker/daemon.json || echo '{"data-root":"/data/docker"}' > /etc/docker/daemon.json; rc-service docker start >/dev/null 2>&1 || true; for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; docker info >/dev/null 2>&1; fi`);
      const provision=await runValidationCommand({workspaceId:o.workspaceId,cwd:root,root,command:environmentScript(root,scope,recipe.databases),timeoutMs:900_000,cancelled:ctx.cancelled,log:ctx.onLog});
      if(provision.exitCode!==0)throw new ValidationFailure(`Isolated services failed: ${provision.output}`,id);
      const env:ValidationEnvironment=JSON.parse(await shell(`cat ${q(root+'/environment.json')}`));
      const imageIds = env.engines.length ? await shell(`docker inspect --format '{{.Image}}' ${env.engines.map(e=>q(e.container)).join(" ")}`) : "none";
      evidence.environmentHash = hashContract({recipe: recipe.databases, runtime: recipe.runtimeVersion, imageIds, validatorVersion: 1});
      const vars={...Object.fromEntries(recipe.autoEnvVars.map(v=>[v.key,v.value])),...env.vars,PORT:String(env.port),ASPNETCORE_URLS:`http://0.0.0.0:${env.port}`,ASPNETCORE_ENVIRONMENT:"Development",LFG_VALIDATION:"1",LFG_SQL_PASSWORD:env.engines.find(e=>e.engine!=="redis")?.password??""};
      const stopApp=()=>shell(`if test -f ${q(root+'/app.pid')}; then p=$(cat ${q(root+'/app.pid')}); case "$p" in ''|*[!0-9]*) exit 1;; esac; kill -TERM -- -"$p" 2>/dev/null || true; sleep 1; kill -KILL -- -"$p" 2>/dev/null || true; rm -f ${q(root+'/app.pid')}; fi`);
      const run=async(rev:string,p:AppProfile,stage:string,tests:boolean)=>{
        const dir=`${root}/${stage}`;group.dirs.push(dir);
        await shell(`git -C ${q(o.sourceDir)} worktree add --detach ${q(dir)} ${q(rev)}`);
        const localize=(c:string)=>c.replaceAll('/data/project',dir);
        const app=p.runCmd.replace(new RegExp(`(:|--port[ =])${p.port}\\b`,'g'),`$1${env.port}`);
        const body=Buffer.from(`cd ${q(dir)}\n${Object.entries(vars).map(([k,v])=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)?`export ${k}=${q(v)}`:'').join('\n')}\nexec bash -c ${q(localize(app))}`).toString('base64');
        const plan=compileRuntimePlan(p,{dir,localize,configure:"true",application:p.validation?.kind!=="library"&&p.validation?.kind!=="documents",
          start:`echo ${body} | base64 -d > ${q(root+'/app.sh')}; setsid bash ${q(root+'/app.sh')} > ${q(root+'/app.log')} 2>&1 </dev/null & echo $! > ${q(root+'/app.pid')}`,
          sql:file=>{
            const engines=env.engines.filter(e=>e.engine!=="redis");
            if(engines.length!==1 || new Set(p.databases.filter(d=>d.engine!=="redis").map(d=>d.databaseName??"app")).size>1) return "echo 'SQL script needs exactly one declared SQL engine; otherwise use an explicit migration command'; exit 1";
            const e=engines[0]!; const input=q(file); const database = p.databases.find(d=>d.engine===e.engine)?.databaseName??"app";
            if(e.engine==="mssql")return `docker exec -i -e SQLCMDPASSWORD="$LFG_SQL_PASSWORD" ${q(e.container)} sh -c 'c=/opt/mssql-tools18/bin/sqlcmd; test -x "$c" || c=/opt/mssql-tools/bin/sqlcmd; exec "$c" -S localhost -U sa -C -b -d ${database}' < ${input}`;
            if(e.engine==="postgres")return `docker exec -i -e PGPASSWORD="$LFG_SQL_PASSWORD" ${q(e.container)} psql -v ON_ERROR_STOP=1 -U app -d ${q(database)} < ${input}`;
            return `docker exec -i -e MYSQL_PWD="$LFG_SQL_PASSWORD" ${q(e.container)} mysql -uapp ${q(database)} < ${input}`;
          },
          http:path=>`for i in $(seq 1 60); do s=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' ${q(`http://127.0.0.1:${env.port}${path}`)} || true); case "$s" in 2??|3??) exit 0;; esac; sleep 1; done; tail -c 12000 ${q(root+'/app.log')}; exit 1`,
          beforeSchema: upgrade && tests && p.validation?.upgradeSetup ? [p.validation.upgradeSetup] : [],
          tests:tests?p.validation!.tests:[]});
        plan.forEach(s=>{s.id=`${upgrade?'upgrade':'fresh'}-${stage}-${s.id}`;});steps.push(...plan);
        const failed=await executeSteps(plan,{cancelled:ctx.cancelled??(()=>false),persist,run:async(s,command)=>{
          ctx.onLog?.(`${upgrade?'Upgrade':'Fresh'} / ${stage}: ${s.label}`);
          const r=await runValidationCommand({workspaceId:o.workspaceId,cwd:dir,root,command,vars,cancelled:ctx.cancelled,log:ctx.onLog});
          // Runtime service scripts run in their own process group and survive the command group cleanup.
          for(const value of Object.values(env.vars)) r.output=r.output.replaceAll(value,'[redacted connection]');
          for(const e of env.engines) r.output=r.output.replaceAll(e.password,'[redacted]');
          return r;
        }});
        if(failed)throw new ValidationFailure(`${upgrade?'Upgrade':'Fresh'} validation failed at ${failed.label}: ${failed.error}`,id);
        const dirty=await shell(`git -C ${q(dir)} diff --name-only HEAD`);
        if(dirty)throw new ValidationFailure(`Runtime changed tracked source (${dirty}). Commit the repair and validate again.`,id);
        await stopApp();
      };
      if(upgrade && o.baseline) {
        const baselineDir=`${root}/baseline-probe`;group.dirs.push(baselineDir);
        await shell(`git -C ${q(o.sourceDir)} worktree add --detach ${q(baselineDir)} ${q(o.baseline)}`);
        const baseline=await ensureValidationRecipe(o.workspaceId,baselineDir,ctx,true);
        if(hashContract(baseline.databases)!==hashContract(recipe.databases))throw new ValidationFailure("Baseline and candidate service mappings differ. Record an explicit compatible upgrade environment before validation.",id);
        if(recipe.databases.some(d=>d.engine!=="redis") && !recipe.validation?.upgradeSetup && !baseline.schemaSteps.some(s=>s.kind==="seed"))
          throw new ValidationFailure("SQL upgrade validation needs representative baseline data: add validation.upgradeSetup fixtures or a baseline seed step.",id);
        await run(o.baseline,baseline,'baseline',false);
      }
      await run(o.revision,recipe,'candidate',true);
      // Free the fresh SQL Server before allocating the upgrade environment.
      await cleanup(group);
      groups.splice(groups.indexOf(group),1);
    };
    await pass(false);evidence.freshPassed=true;await persist();
    if(recipe.databases.length && o.baseline && o.baseline!==o.revision) await pass(true);
    else if(recipe.databases.length && !o.baseline)throw new ValidationFailure("Database upgrade validation requires an explicit baseline commit",id);
    evidence.upgradePassed=true;evidence.status="passed";await persist();ctx.onLog?.(`Runtime validation passed for ${o.revision.slice(0,12)} (evidence ${id}).`);return evidence;
  } catch(e) {evidence.status="failed";evidence.error=(e as Error).message;await persist();throw new ValidationFailure(evidence.error,id);}
  finally {
    for(const g of groups) await cleanup(g);
  }
}
