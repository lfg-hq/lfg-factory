/**
 * "Use my computer for AI" is opt-in per person (Settings → Integrations).
 * On: that person's AI work runs on their own computer, through the agent they chose
 * (Claude Code, Codex or Copilot), via LFG Desktop. Off: LFG's server AI, as before.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { profiles } from "../../db/schema/users.ts";
import { runnerDevices } from "../../db/schema/runners.ts";
import { AGENT_LABELS, isAgentEffort, isAgentKind, isAgentModel, type AgentEffort, type AgentEvent, type AgentKind, type AgentLimitWindow } from "./protocol.ts";

/** model/effort: null means the agent's own default (whatever is set on that computer). */
export interface LocalAiSettings { enabled: boolean; agent: AgentKind; model: string | null; effort: AgentEffort | null }

/** The models offered for each agent in the chat's picker. Codex and Copilot: their own default. */
export const LOCAL_AGENT_MODELS: Record<AgentKind, Array<{ id: string; label: string }>> = {
  claude: [
    { id: "opus", label: "Opus 5.5" },
    { id: "sonnet", label: "Sonnet 5.5" },
    { id: "haiku", label: "Haiku 5.5" },
    { id: "fable", label: "Fable 5.2" },
  ],
  codex: [],
  copilot: [],
};
/** Effort levels each agent takes (Codex tops out at high). */
export const LOCAL_AGENT_EFFORTS: Record<AgentKind, AgentEffort[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high"],
  copilot: [],
};

export async function localAiSettings(userId: string): Promise<LocalAiSettings> {
  const [row] = await db.select({ enabled: profiles.desktopBuildsEnabled, agent: profiles.localAgent, model: profiles.localModel, effort: profiles.localEffort })
    .from(profiles).where(eq(profiles.userId, userId)).limit(1);
  const agent: AgentKind = isAgentKind(row?.agent) ? row.agent : "claude";
  const model = isAgentModel(row?.model) && LOCAL_AGENT_MODELS[agent].some(m => m.id === row!.model) ? row!.model : null;
  const effort = isAgentEffort(row?.effort) && LOCAL_AGENT_EFFORTS[agent].includes(row!.effort) ? row!.effort : null;
  return { enabled: row?.enabled ?? false, agent, model, effort };
}

export async function setLocalAiSettings(userId: string, change: Partial<LocalAiSettings>): Promise<LocalAiSettings> {
  const set = {
    ...(change.enabled !== undefined ? { desktopBuildsEnabled: change.enabled } : {}),
    ...(change.agent !== undefined ? { localAgent: change.agent } : {}),
    ...(change.model !== undefined ? { localModel: change.model } : {}),
    ...(change.effort !== undefined ? { localEffort: change.effort } : {}),
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

// ── Plan usage, as the agent on the person's computer reports it ─────

export interface LocalAgentUsage {
  agent: AgentKind;
  /** Plan windows (five_hour, seven_day…): utilization 0–1, resetsAt epoch seconds. */
  windows: AgentLimitWindow[];
  windowsAt?: string;
  lastTurn?: { inputTokens?: number; outputTokens?: number; costUsd?: number; at: string };
}

export async function localAgentUsage(userId: string): Promise<LocalAgentUsage | null> {
  const [row] = await db.select({ usage: profiles.localAgentUsage }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!row?.usage) return null;
  try { return JSON.parse(row.usage) as LocalAgentUsage; } catch { return null; }
}

/** Keep the latest limits / last turn's tokens from an agent event. Other events are ignored. */
export async function recordLocalAgentUsage(userId: string, agent: AgentKind, event: AgentEvent): Promise<void> {
  if (event.type !== "limits" && !(event.type === "result" && event.usage)) return;
  const previous = await localAgentUsage(userId);
  const base: LocalAgentUsage = previous?.agent === agent ? previous : { agent, windows: [] };
  const now = new Date().toISOString();
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const next: LocalAgentUsage = event.type === "limits"
    ? { ...base, windows: event.windows.slice(0, 6).map(w => ({ kind: String(w.kind).slice(0, 40), utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: typeof w.status === "string" ? w.status.slice(0, 40) : undefined })), windowsAt: now }
    : { ...base, lastTurn: { inputTokens: num(event.usage!.inputTokens), outputTokens: num(event.usage!.outputTokens), costUsd: num(event.usage!.costUsd), at: now } };
  await db.insert(profiles).values({ userId, localAgentUsage: JSON.stringify(next) })
    .onConflictDoUpdate({ target: profiles.userId, set: { localAgentUsage: JSON.stringify(next) } });
}
