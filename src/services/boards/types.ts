/**
 * One shape for two very different issue trackers.
 *
 * Linear is GraphQL with workflow states you set directly; Jira is REST with statuses
 * you can only reach through a TRANSITION, descriptions in Atlassian Document Format,
 * and a priority field that may not even be on the screen. All of that stays behind this
 * interface so the sync engine never branches on provider.
 */
export type BoardProvider = "linear" | "jira";

export const BOARD_PROVIDERS: BoardProvider[] = ["linear", "jira"];

export function isBoardProvider(v: string): v is BoardProvider {
  return v === "linear" || v === "jira";
}

export function providerLabel(p: BoardProvider): string {
  return p === "linear" ? "Linear" : "Jira";
}

/** A board a project can be bound to: a Linear team, or a Jira project. */
export interface RemoteBoard {
  id: string;
  key?: string | null;
  name: string;
  url?: string | null;
  /** Jira: the issue types new issues can be created as. Linear: empty. */
  issueTypes?: Array<{ id: string; name: string }>;
}

/** Where an issue can sit on the board. `category` is the provider's own grouping. */
export interface RemoteStatus {
  id: string;
  name: string;
  category?: "backlog" | "todo" | "in_progress" | "review" | "done" | "cancelled";
}

export interface RemoteIssue {
  id: string;
  key: string;
  url: string;
  title: string;
  description: string;
  statusId: string;
  statusName: string;
  /** Normalized to LFG's vocabulary ("Critical" | "High" | "Medium" | "Low"), or null. */
  priority: string | null;
  updatedAt: Date;
}

/** What we ask a provider to create or change. Undefined = leave alone. */
export interface IssueDraft {
  title?: string;
  description?: string;
  statusId?: string | null;
  priority?: string | null;
}

export interface BoardClient {
  provider: BoardProvider;
  /** Identity of the connected account, for the Settings row. */
  whoami(): Promise<{ id: string; name: string; email?: string | null; avatarUrl?: string | null }>;
  listBoards(): Promise<RemoteBoard[]>;
  listStatuses(boardId: string): Promise<RemoteStatus[]>;
  /** Issues on the board, newest-updated first. `since` narrows a re-sync. */
  listIssues(boardId: string, opts?: { since?: Date | null; limit?: number }): Promise<RemoteIssue[]>;
  createIssue(boardId: string, draft: IssueDraft, opts?: { issueTypeId?: string | null }): Promise<RemoteIssue>;
  updateIssue(boardId: string, remoteId: string, draft: IssueDraft): Promise<RemoteIssue | null>;
  getIssue(boardId: string, remoteId: string): Promise<RemoteIssue | null>;
}

/** LFG's priority vocabulary, lowercased for comparison. */
export const LFG_PRIORITIES = ["critical", "high", "medium", "low"] as const;

export function normalizePriority(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s.startsWith("crit") || s === "urgent" || s === "highest" || s === "blocker") return "Critical";
  if (s === "high" || s === "major") return "High";
  if (s === "medium" || s === "normal" || s === "moderate") return "Medium";
  if (s === "low" || s === "minor" || s === "lowest" || s === "trivial") return "Low";
  return null;
}

/**
 * Categorize a status by NAME when the provider doesn't tell us. Used for auto-mapping
 * a fresh link — a guess that's visible and editable, never a silent one.
 */
export function guessCategory(name: string): RemoteStatus["category"] {
  const s = name.trim().toLowerCase();
  if (/(^|\b)(done|complete|completed|closed|shipped|released|resolved)\b/.test(s)) return "done";
  if (/(cancel|won'?t\s?do|wontfix|duplicate|rejected|abandoned)/.test(s)) return "cancelled";
  if (/(review|qa|testing|verify|verification|approval)/.test(s)) return "review";
  if (/(progress|doing|develop|building|started|active|implementation)/.test(s)) return "in_progress";
  if (/(todo|to do|selected|ready|planned|next|open|new)/.test(s)) return "todo";
  if (/(backlog|icebox|triage|inbox)/.test(s)) return "backlog";
  return "todo";
}
