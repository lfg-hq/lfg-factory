/**
 * "Use my computer for AI" is opt-in per person (Settings → Integrations).
 * On: that person's AI work runs on their own computer, through the agent they chose
 * (Claude Code, Codex or Copilot), via LFG Desktop. Off: LFG's server AI, as before.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { profiles } from "../../db/schema/users.ts";
import { runnerDevices } from "../../db/schema/runners.ts";
import { AGENT_LABELS, isAgentKind, type AgentKind } from "./protocol.ts";

export interface LocalAiSettings { enabled: boolean; agent: AgentKind }

export async function localAiSettings(userId: string): Promise<LocalAiSettings> {
  const [row] = await db.select({ enabled: profiles.desktopBuildsEnabled, agent: profiles.localAgent })
    .from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return { enabled: row?.enabled ?? false, agent: isAgentKind(row?.agent) ? row.agent : "claude" };
}

export async function setLocalAiSettings(userId: string, change: Partial<LocalAiSettings>): Promise<LocalAiSettings> {
  const set = {
    ...(change.enabled !== undefined ? { desktopBuildsEnabled: change.enabled } : {}),
    ...(change.agent !== undefined ? { localAgent: change.agent } : {}),
    updatedAt: new Date(),
  };
  await db.insert(profiles).values({ userId, ...set }).onConflictDoUpdate({ target: profiles.userId, set });
  return localAiSettings(userId);
}

/** Kept for existing callers: is local AI on for this person? */
export const desktopBuildsEnabled = async (userId: string) => (await localAiSettings(userId)).enabled;

/** The agents installed on this person's computers, as their computers last reported. */
export async function installedAgents(userId: string): Promise<Array<{ kind: AgentKind; label: string; version: string; device: string }>> {
  const devices = await db.select({ name: runnerDevices.name, agents: runnerDevices.agents, claudeVersion: runnerDevices.claudeVersion })
    .from(runnerDevices)
    .where(and(eq(runnerDevices.userId, userId), isNull(runnerDevices.revokedAt)))
    .orderBy(desc(runnerDevices.lastSeenAt));
  const seen = new Map<AgentKind, { kind: AgentKind; label: string; version: string; device: string }>();
  for (const d of devices) {
    let list: Array<{ kind: unknown; version: unknown }> = [];
    try { list = d.agents ? JSON.parse(d.agents) : d.claudeVersion ? [{ kind: "claude", version: d.claudeVersion }] : []; } catch { /* ignore */ }
    for (const a of list) {
      if (isAgentKind(a.kind) && !seen.has(a.kind)) seen.set(a.kind, { kind: a.kind, label: AGENT_LABELS[a.kind], version: String(a.version), device: d.name });
    }
  }
  return [...seen.values()];
}
