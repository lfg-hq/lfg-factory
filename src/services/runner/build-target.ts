/**
 * Where a ticket builds: on the person's own computer (LFG Desktop, in a git worktree
 * on their disk, with their Claude Code / Codex / Copilot login) or in an LFG cloud
 * sandbox. Each ticket can pick its own; otherwise the person's "Use my computer for AI"
 * setting decides. Stored in the ticket's `details.buildWith`, like its checks choice.
 */

import { isAgentKind, type AgentKind } from "./protocol.ts";
import { localAiSettings } from "./opt-in.ts";

export type BuildWith = "cloud" | AgentKind;
/** The project's choice of where builds and previews run; null = each person's setting. */
export type ProjectRunOn = "cloud" | "computer" | null;
export function projectRunOn(v: unknown): ProjectRunOn {
  return v === "cloud" || v === "computer" ? v : null;
}
export type BuildTarget = { where: "computer"; agent: AgentKind } | { where: "cloud"; reason?: string };

/** The ticket's own choice, or null when it follows the person's setting. */
export function ticketBuildWith(details: unknown): BuildWith | null {
  const v = (details as { buildWith?: unknown } | null)?.buildWith;
  return v === "cloud" || isAgentKind(v) ? v : null;
}

export function isBuildWith(v: unknown): v is BuildWith {
  return v === "cloud" || isAgentKind(v);
}

/** Decide where this person's build of this ticket runs: the ticket's own choice, then the
 *  project's setting (Project settings → Config), then the person's own setting. */
export async function resolveBuildTarget(actorId: string | null | undefined, details: unknown, runOn: ProjectRunOn = null): Promise<BuildTarget> {
  const choice = ticketBuildWith(details);
  if (choice === "cloud" || !actorId) return { where: "cloud" };
  if (!choice && runOn === "cloud") return { where: "cloud" };
  const settings = await localAiSettings(actorId);
  if (!settings.enabled) {
    return choice || runOn === "computer"
      ? { where: "cloud", reason: `This ${choice ? "ticket" : "project"} is set to build on your computer, but Use my computer for AI is off (Settings → Integrations), so it builds in the cloud.` }
      : { where: "cloud" };
  }
  return { where: "computer", agent: choice ?? settings.agent };
}
