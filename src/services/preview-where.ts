/**
 * Which copy of a project's preview the person is looking at, for the agent.
 *
 * A project can preview in the cloud (a sandbox at preview-…app.lfg.run) or on the
 * person's computer (LFG Desktop, http://localhost:…). They are separate copies, each
 * with its own database and its own snapshot of the project's environment keys. The
 * agent's preview tools must act on the copy the person uses, and say which it is;
 * otherwise it fixes and verifies one copy while the person looks at the other.
 */

import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";

export interface PreviewSituation {
  where: "computer" | "cloud";
  running: boolean;
  url: string | null;
  branch: string | null;
  /** Computer only: which computer runs it. */
  deviceName?: string | null;
  /** Environment keys saved on the project since this copy started: it hasn't loaded them yet. */
  keysNotLoaded: string[];
  /** The other copy, when it is up too (it has its own database). */
  otherCopy?: { where: "computer" | "cloud"; url: string } | null;
}

/** Where the person's preview of this project is, and whether it runs. */
export async function previewSituation(userId: string, projectId: string): Promise<PreviewSituation> {
  const { runningLocalPreview, resolvePreviewWhere, localPreviewStartedEnv, currentProjectEnv } = await import("./runner/preview-job.ts");
  const [cloud] = await db.select({ status: projectEnvironments.previewStatus, url: projectEnvironments.appUrl, branch: projectEnvironments.previewBranch })
    .from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId)).limit(1);
  const cloudUp = cloud?.status === "running" && !!cloud.url;
  const local = await runningLocalPreview(userId, projectId);
  const where = local ? "computer" : (await resolvePreviewWhere(userId, { projectId })).where;
  if (where === "computer") {
    let keysNotLoaded: string[] = [];
    if (local) {
      const started = await localPreviewStartedEnv(local.jobId);
      const now = await currentProjectEnv(projectId);
      keysNotLoaded = Object.keys(now).filter(k => started[k] !== now[k]).sort();
    }
    return {
      where, running: !!local, url: local?.url ?? null, branch: local?.branch ?? null, deviceName: local?.deviceName ?? null, keysNotLoaded,
      otherCopy: cloudUp ? { where: "cloud", url: cloud!.url! } : null,
    };
  }
  return { where, running: cloudUp, url: cloudUp ? cloud!.url : null, branch: cloud?.branch ?? null, keysNotLoaded: [], otherCopy: null };
}

/** The agent's standing note about the preview, appended to its instructions each turn. */
export function previewSituationText(s: PreviewSituation): string {
  const lines = ["", "", "---", "", "## The preview the user is looking at", ""];
  if (s.where === "computer") {
    lines.push(s.running
      ? `It runs ON THE USER'S COMPUTER${s.deviceName ? ` (${s.deviceName}, LFG Desktop)` : ""} at ${s.url}${s.branch ? `, branch ${s.branch}` : ""}. That is the copy they see in the Preview tab and sign in to.`
      : "This project previews ON THE USER'S COMPUTER, and it is NOT running right now. Start it with handlePreview restart_app (it starts it on their computer); don't describe the cloud preview as theirs.");
    if (s.otherCopy) lines.push(`A separate cloud copy is also up at ${s.otherCopy.url}. It has its OWN database and keys: logins, data or restarts there do not change what the user sees. Don't test or fix it unless they ask for the cloud preview.`);
    lines.push("handlePreview (restart_app, manage_data) and getPreviewDiagnostics act on the copy on their computer. inspectPreview and runInPreview reach only the cloud sandbox and refuse here.");
    if (s.keysNotLoaded.length) lines.push(`Environment keys saved since it started, which it has NOT loaded yet: ${s.keysNotLoaded.join(", ")}. After saving keys, restart it with handlePreview restart_app so the app sees them.`);
    else lines.push("After saving environment keys with setEnvVar, restart it with handlePreview restart_app: a running app only reads keys when it starts.");
  } else {
    lines.push(s.running
      ? `It runs in the cloud at ${s.url}${s.branch ? `, branch ${s.branch}` : ""}.`
      : "It runs in the cloud and is not running right now.");
    lines.push("After saving environment keys with setEnvVar, restart it with handlePreview restart_app: a running app only reads keys when it starts.");
  }
  lines.push("When you report a check (sign-in works, a page loads), say which copy you checked.");
  return lines.join("\n");
}

/** Wrap tools that reach only the cloud sandbox so they refuse, instead of checking the wrong copy, when the preview is on the person's computer. */
export function cloudOnlyTools<T extends Record<string, any>>(tools: T, userId: string, projectId: string): T {
  const out: Record<string, any> = { ...tools };
  for (const [name, t] of Object.entries(tools)) {
    if (!t || typeof t.execute !== "function") continue;
    out[name] = { ...t, execute: async (...args: unknown[]) => (await cloudOnlyRefusal(userId, projectId)) ?? t.execute(...args) };
  }
  return out as T;
}

/** Shell-based preview tools reach only the cloud sandbox: refuse plainly when the person's preview is on their computer. */
export async function cloudOnlyRefusal(userId: string, projectId: string): Promise<{ error: string } | null> {
  const s = await previewSituation(userId, projectId);
  if (s.where !== "computer") return null;
  return { error: `The user's preview runs on their computer${s.url ? ` (${s.url})` : ""}, and this tool reaches only the cloud sandbox, a separate copy. Use getPreviewDiagnostics for its status and log, handlePreview restart_app to start or restart it, and handlePreview manage_data for logins and data.${s.running ? "" : " It is not running now: start it with handlePreview restart_app."}` };
}
