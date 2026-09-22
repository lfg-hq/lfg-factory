import { currentUsage } from "../ai/usage-context.ts";
import { recordCliUsage } from "./token-usage.ts";

export async function registerUsageOutput(workspaceId: string, outputFile: string) {
  const context = currentUsage();
  context?.cliOutputs?.push({ workspaceId, outputFile });
  if (context?.runId) {
    const [{ db }, { tokenUsageRuns }, { eq }] = await Promise.all([import("../config/db.ts"), import("../db/schema/tokens.ts"), import("drizzle-orm")]);
    await db.update(tokenUsageRuns).set({ userId: context.userId, billingMode: context.billingMode ?? "api" }).where(eq(tokenUsageRuns.id, context.runId));
  }
}
export async function collectCliUsage() {
  const context = currentUsage();
  if (!context) return;
  for (const { workspaceId, outputFile } of context.cliOutputs ?? []) {
    try {
      const { execOnWorkspace } = await import("./mags.ts");
      // Deduplicate Claude assistant messages and retain final model totals. Strip
      // all prompts/tool contents on the VM; only accounting fields leave it.
      const script = `import json
messages={}
results=[]
with open(${JSON.stringify(outputFile)}) as f:
 for line in f:
  try: e=json.loads(line)
  except Exception: continue
  m=e.get('message') or {}
  if e.get('type')=='message_end' and m.get('role')=='assistant':
   print(json.dumps({'type':'message_end','message':{k:m.get(k) for k in ['role','id','timestamp','provider','model','usage']}}))
  elif e.get('type')=='assistant' and m.get('id') and m.get('usage'):
   messages[m['id']]={'id':m['id'],'model':m.get('model'),'usage':m['usage']}
  elif e.get('type')=='result' and e.get('modelUsage') and e.get('uuid'):
   results.append({k:e.get(k) for k in ['type','uuid','modelUsage']})
if results:
 for e in results: print(json.dumps(e))
else:
 for m in messages.values(): print(json.dumps({'type':'claude_usage','message':m}))
`;
      const command = `python3 -c '${script.replace(/'/g, "'\\''")}'`;
      const result = await execOnWorkspace(workspaceId, command, { timeout: 30_000 });
      const events = result.output.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      await recordCliUsage(context, events);
    } catch (error) { console.error("[token-usage] CLI collection failed:", error); }
  }
}
