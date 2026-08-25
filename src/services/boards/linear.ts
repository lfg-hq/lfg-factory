/**
 * Linear board client (GraphQL).
 *
 * A "board" here is a Linear TEAM: teams own workflow states and issue keys (ENG-42),
 * which is what a project actually maps onto. Linear OAuth tokens don't expire, so
 * there's no refresh path — a revoked grant surfaces as a 401 the caller reports.
 */
import type {
  BoardClient, IssueDraft, RemoteBoard, RemoteIssue, RemoteStatus,
} from "./types.ts";
import { guessCategory, normalizePriority } from "./types.ts";

const ENDPOINT = "https://api.linear.app/graphql";

/** Linear priority is an int: 0 none, 1 urgent, 2 high, 3 normal, 4 low. */
function priorityToLinear(p: string | null | undefined): number | undefined {
  const n = normalizePriority(p);
  if (!n) return undefined;
  return n === "Critical" ? 1 : n === "High" ? 2 : n === "Medium" ? 3 : 4;
}
function priorityFromLinear(n: number | null | undefined): string | null {
  if (n === 1) return "Critical";
  if (n === 2) return "High";
  if (n === 3) return "Medium";
  if (n === 4) return "Low";
  return null;
}

/** Linear's own state types map cleanly; don't guess when it tells us. */
function categoryFromType(t: string | null | undefined): RemoteStatus["category"] {
  switch (t) {
    case "backlog": return "backlog";
    case "unstarted": return "todo";
    case "started": return "in_progress";
    case "completed": return "done";
    case "canceled": return "cancelled";
    default: return undefined;
  }
}

interface LinearIssueNode {
  id: string; identifier: string; url: string; title: string;
  description?: string | null; priority?: number | null; updatedAt: string;
  state?: { id: string; name: string } | null;
}

function toIssue(n: LinearIssueNode): RemoteIssue {
  return {
    id: n.id,
    key: n.identifier,
    url: n.url,
    title: n.title ?? "",
    description: n.description ?? "",
    statusId: n.state?.id ?? "",
    statusName: n.state?.name ?? "",
    priority: priorityFromLinear(n.priority),
    updatedAt: new Date(n.updatedAt),
  };
}

export class LinearClient implements BoardClient {
  provider = "linear" as const;
  constructor(private token: string) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        // OAuth access tokens are Bearer; a raw personal API key is sent as-is. Accept
        // both so a token pasted from Linear's settings also works.
        Authorization: this.token.startsWith("lin_api_") ? this.token : `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await r.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
    if (!r.ok || body.errors?.length) {
      const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`;
      throw new Error(`Linear: ${msg}`);
    }
    return body.data as T;
  }

  async whoami() {
    const d = await this.gql<{ viewer: { id: string; name: string; email: string; avatarUrl?: string | null } }>(
      `query { viewer { id name email avatarUrl } }`
    );
    return { id: d.viewer.id, name: d.viewer.name, email: d.viewer.email, avatarUrl: d.viewer.avatarUrl ?? null };
  }

  async listBoards(): Promise<RemoteBoard[]> {
    const d = await this.gql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
      `query { teams(first: 100) { nodes { id key name } } }`
    );
    return d.teams.nodes.map((t) => ({
      id: t.id, key: t.key, name: t.name,
      url: `https://linear.app/team/${t.key}`,
      issueTypes: [],
    }));
  }

  async listStatuses(boardId: string): Promise<RemoteStatus[]> {
    const d = await this.gql<{ workflowStates: { nodes: Array<{ id: string; name: string; type: string; position: number }> } }>(
      `query($id: String!) {
        workflowStates(filter: { team: { id: { eq: $id } } }, first: 100) {
          nodes { id name type position }
        }
      }`,
      { id: boardId }
    );
    return d.workflowStates.nodes
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, name: s.name, category: categoryFromType(s.type) ?? guessCategory(s.name) }));
  }

  async listIssues(boardId: string, opts?: { since?: Date | null; limit?: number }): Promise<RemoteIssue[]> {
    const filter: Record<string, unknown> = { team: { id: { eq: boardId } } };
    if (opts?.since) filter.updatedAt = { gt: opts.since.toISOString() };
    const d = await this.gql<{ issues: { nodes: LinearIssueNode[] } }>(
      `query($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes { id identifier url title description priority updatedAt state { id name } }
        }
      }`,
      { filter, first: Math.min(opts?.limit ?? 200, 250) }
    );
    return d.issues.nodes.map(toIssue);
  }

  async getIssue(_boardId: string, remoteId: string): Promise<RemoteIssue | null> {
    const d = await this.gql<{ issue: LinearIssueNode | null }>(
      `query($id: String!) {
        issue(id: $id) { id identifier url title description priority updatedAt state { id name } }
      }`,
      { id: remoteId }
    );
    return d.issue ? toIssue(d.issue) : null;
  }

  async createIssue(boardId: string, draft: IssueDraft): Promise<RemoteIssue> {
    const input: Record<string, unknown> = {
      teamId: boardId,
      title: draft.title ?? "Untitled",
      description: draft.description ?? "",
    };
    if (draft.statusId) input.stateId = draft.statusId;
    const p = priorityToLinear(draft.priority);
    if (p !== undefined) input.priority = p;
    const d = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssueNode | null } }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url title description priority updatedAt state { id name } }
        }
      }`,
      { input }
    );
    if (!d.issueCreate?.success || !d.issueCreate.issue) throw new Error("Linear: issue creation failed");
    return toIssue(d.issueCreate.issue);
  }

  async updateIssue(_boardId: string, remoteId: string, draft: IssueDraft): Promise<RemoteIssue | null> {
    const input: Record<string, unknown> = {};
    if (draft.title !== undefined) input.title = draft.title;
    if (draft.description !== undefined) input.description = draft.description;
    if (draft.statusId) input.stateId = draft.statusId;
    const p = priorityToLinear(draft.priority);
    if (p !== undefined) input.priority = p;
    if (!Object.keys(input).length) return null;
    const d = await this.gql<{ issueUpdate: { success: boolean; issue: LinearIssueNode | null } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id identifier url title description priority updatedAt state { id name } }
        }
      }`,
      { id: remoteId, input }
    );
    if (!d.issueUpdate?.success || !d.issueUpdate.issue) throw new Error("Linear: issue update failed");
    return toIssue(d.issueUpdate.issue);
  }
}
