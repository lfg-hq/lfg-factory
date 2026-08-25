/**
 * Jira Cloud board client (REST v3, via api.atlassian.com with a cloudId).
 *
 * Three Jira facts shape this file:
 *  - You cannot SET a status. You fetch the transitions available from where the issue
 *    currently is and execute one; a status with no path from here simply isn't reachable.
 *  - Descriptions are Atlassian Document Format, not text. We convert both ways.
 *  - priority may not exist on a project's screens. Setting it is best-effort: a rejected
 *    priority must never fail an otherwise good sync.
 */
import type {
  BoardClient, IssueDraft, RemoteBoard, RemoteIssue, RemoteStatus,
} from "./types.ts";
import { guessCategory, normalizePriority } from "./types.ts";

type AdfNode = { type: string; text?: string; content?: AdfNode[] };
/** A whole ADF document — Jira rejects a body without `version`. */
type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

/** Plain text / light markdown → ADF. Blank lines separate paragraphs. */
export function textToAdf(text: string): AdfDoc {
  const paras = String(text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: paras.map((p) => ({
      type: "paragraph",
      content: [{ type: "text", text: p }],
    })),
  };
}

/** ADF → plain text, good enough to round-trip a description into a ticket body. */
export function adfToText(node: unknown): string {
  const walk = (n: AdfNode | undefined | null): string => {
    if (!n) return "";
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    const inner = (n.content ?? []).map(walk).join("");
    if (n.type === "paragraph" || n.type === "heading") return inner + "\n\n";
    if (n.type === "listItem") return "- " + inner.trim() + "\n";
    if (n.type === "codeBlock") return "```\n" + inner + "\n```\n\n";
    return inner;
  };
  if (typeof node === "string") return node;
  return walk(node as AdfNode).replace(/\n{3,}/g, "\n\n").trim();
}

function categoryFromJira(key: string | undefined, name: string): RemoteStatus["category"] {
  if (key === "done") return "done";
  if (key === "indeterminate") return guessCategory(name) === "review" ? "review" : "in_progress";
  if (key === "new") return guessCategory(name) === "backlog" ? "backlog" : "todo";
  return guessCategory(name);
}

interface JiraIssueRaw {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    updated?: string;
    status?: { id: string; name: string };
    priority?: { id?: string; name?: string } | null;
  };
}

export class JiraClient implements BoardClient {
  provider = "jira" as const;
  /** siteUrl is the human-facing host (https://acme.atlassian.net) used to build links. */
  constructor(private token: string, private cloudId: string, private siteUrl: string) {}

  private base() { return `https://api.atlassian.com/ex/jira/${this.cloudId}/rest/api/3`; }

  private async req<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
    const r = await fetch(`${this.base()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Jira ${r.status}: ${body.slice(0, 300) || r.statusText}`);
    }
    if (r.status === 204) return undefined as T;
    return (await r.json().catch(() => ({}))) as T;
  }

  private issueUrl(key: string) { return `${this.siteUrl.replace(/\/$/, "")}/browse/${key}`; }

  private toIssue(raw: JiraIssueRaw): RemoteIssue {
    return {
      id: raw.id,
      key: raw.key,
      url: this.issueUrl(raw.key),
      title: raw.fields?.summary ?? "",
      description: adfToText(raw.fields?.description),
      statusId: raw.fields?.status?.id ?? "",
      statusName: raw.fields?.status?.name ?? "",
      priority: normalizePriority(raw.fields?.priority?.name ?? null),
      updatedAt: raw.fields?.updated ? new Date(raw.fields.updated) : new Date(0),
    };
  }

  async whoami() {
    const me = await this.req<{ accountId: string; displayName: string; emailAddress?: string; avatarUrls?: Record<string, string> }>("/myself");
    return {
      id: me.accountId,
      name: me.displayName,
      email: me.emailAddress ?? null,
      avatarUrl: me.avatarUrls?.["48x48"] ?? null,
    };
  }

  async listBoards(): Promise<RemoteBoard[]> {
    const out: RemoteBoard[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.req<{ values: Array<{ id: string; key: string; name: string }>; isLast?: boolean; total?: number }>(
        `/project/search?maxResults=50&startAt=${startAt}&orderBy=name`
      );
      for (const p of page.values ?? []) {
        out.push({
          id: p.id, key: p.key, name: p.name,
          url: `${this.siteUrl.replace(/\/$/, "")}/browse/${p.key}`,
          issueTypes: [],
        });
      }
      if (page.isLast !== false || !(page.values ?? []).length) break;
      startAt += 50;
      if (startAt > 500) break; // don't page forever on a huge instance
    }
    // Issue types decide what we can CREATE; fetch them for the boards we found.
    await Promise.all(out.map(async (b) => {
      try {
        const meta = await this.req<Array<{ id: string; name: string; subtask?: boolean }>>(
          `/project/${encodeURIComponent(b.id)}/statuses`
        ).then((types) => (types as unknown as Array<{ id: string; name: string; subtask?: boolean }>));
        b.issueTypes = (meta ?? []).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
      } catch { /* leave empty; create falls back to "Task" */ }
    }));
    return out;
  }

  async listStatuses(boardId: string): Promise<RemoteStatus[]> {
    // Statuses are per ISSUE TYPE in Jira; flatten and de-duplicate — a board column is a
    // status, and the user doesn't care that Bug and Task each declare it.
    const types = await this.req<Array<{ id: string; name: string; statuses: Array<{ id: string; name: string; statusCategory?: { key: string } }> }>>(
      `/project/${encodeURIComponent(boardId)}/statuses`
    );
    const seen = new Map<string, RemoteStatus>();
    for (const t of types ?? []) {
      for (const s of t.statuses ?? []) {
        if (!seen.has(s.id)) {
          seen.set(s.id, { id: s.id, name: s.name, category: categoryFromJira(s.statusCategory?.key, s.name) });
        }
      }
    }
    return [...seen.values()];
  }

  async listIssues(boardId: string, opts?: { since?: Date | null; limit?: number }): Promise<RemoteIssue[]> {
    const jql = [
      `project = ${JSON.stringify(boardId)}`,
      opts?.since ? `updated > "${jiraDate(opts.since)}"` : "",
      "ORDER BY updated DESC",
    ].filter(Boolean).join(" AND ").replace(" AND ORDER BY", " ORDER BY");
    const fields = ["summary", "description", "status", "priority", "updated"];
    const max = Math.min(opts?.limit ?? 100, 100);

    // POST /search is being retired on Jira Cloud in favour of GET /search/jql. Try the
    // new one first and fall back, so this keeps working on both.
    try {
      const q = new URLSearchParams({ jql, maxResults: String(max), fields: fields.join(",") });
      const page = await this.req<{ issues: JiraIssueRaw[] }>(`/search/jql?${q.toString()}`);
      return (page.issues ?? []).map((i) => this.toIssue(i));
    } catch {
      const page = await this.req<{ issues: JiraIssueRaw[] }>("/search", {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: max, fields }),
      });
      return (page.issues ?? []).map((i) => this.toIssue(i));
    }
  }

  async getIssue(_boardId: string, remoteId: string): Promise<RemoteIssue | null> {
    try {
      const raw = await this.req<JiraIssueRaw>(`/issue/${encodeURIComponent(remoteId)}?fields=summary,description,status,priority,updated`);
      return this.toIssue(raw);
    } catch { return null; }
  }

  async createIssue(boardId: string, draft: IssueDraft, opts?: { issueTypeId?: string | null }): Promise<RemoteIssue> {
    const fields: Record<string, unknown> = {
      project: { id: boardId },
      summary: (draft.title ?? "Untitled").slice(0, 250),
      description: textToAdf(draft.description ?? ""),
      issuetype: opts?.issueTypeId ? { id: opts.issueTypeId } : { name: "Task" },
    };
    if (draft.priority) fields.priority = { name: draft.priority };

    let created: { id: string; key: string };
    try {
      created = await this.req<{ id: string; key: string }>("/issue", { method: "POST", body: JSON.stringify({ fields }) });
    } catch (e) {
      // Priority is the usual culprit — not on the create screen for this project.
      // Retry without it rather than failing the whole sync over a nice-to-have.
      if (!fields.priority) throw e;
      delete fields.priority;
      created = await this.req<{ id: string; key: string }>("/issue", { method: "POST", body: JSON.stringify({ fields }) });
    }

    if (draft.statusId) await this.transitionTo(created.id, draft.statusId).catch(() => {});
    return (await this.getIssue(boardId, created.id)) ?? {
      id: created.id, key: created.key, url: this.issueUrl(created.key),
      title: draft.title ?? "", description: draft.description ?? "",
      statusId: "", statusName: "", priority: draft.priority ?? null, updatedAt: new Date(),
    };
  }

  async updateIssue(boardId: string, remoteId: string, draft: IssueDraft): Promise<RemoteIssue | null> {
    const fields: Record<string, unknown> = {};
    if (draft.title !== undefined) fields.summary = draft.title.slice(0, 250);
    if (draft.description !== undefined) fields.description = textToAdf(draft.description);
    if (draft.priority) fields.priority = { name: draft.priority };

    if (Object.keys(fields).length) {
      try {
        await this.req<void>(`/issue/${encodeURIComponent(remoteId)}`, { method: "PUT", body: JSON.stringify({ fields }) });
      } catch (e) {
        if (!fields.priority) throw e;
        delete fields.priority;
        await this.req<void>(`/issue/${encodeURIComponent(remoteId)}`, { method: "PUT", body: JSON.stringify({ fields }) });
      }
    }
    if (draft.statusId) await this.transitionTo(remoteId, draft.statusId);
    return this.getIssue(boardId, remoteId);
  }

  /** Move an issue to a status by finding a transition that lands there. */
  private async transitionTo(remoteId: string, statusId: string): Promise<void> {
    const cur = await this.req<{ transitions: Array<{ id: string; name: string; to: { id: string; name: string } }> }>(
      `/issue/${encodeURIComponent(remoteId)}/transitions`
    );
    const match = (cur.transitions ?? []).find((t) => t.to?.id === statusId);
    if (!match) {
      // Already there? Then nothing to do; otherwise the workflow forbids this hop.
      const issue = await this.getIssue("", remoteId);
      if (issue?.statusId === statusId) return;
      throw new Error(
        `no transition to that status from "${issue?.statusName ?? "current status"}" — the Jira workflow doesn't allow that move`
      );
    }
    await this.req<void>(`/issue/${encodeURIComponent(remoteId)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }
}

/** Jira's JQL date literal: "yyyy/MM/dd HH:mm". */
function jiraDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
