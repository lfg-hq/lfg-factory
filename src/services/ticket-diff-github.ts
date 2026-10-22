/**
 * A ticket's changes read straight from GitHub, so the Git tab works without a preview
 * sandbox (isolated builds push from a VM that is gone afterwards).
 *
 * A ticket can reach its epic several times (the first build, follow-ups, rebuilds).
 * Each time is a merge commit on the epic whose second parent sits on the ticket
 * branch's own first-parent line. Every such merge is a "round", diffed from the epic
 * as it stood just before it (the merge's first parent). Work pushed but not merged
 * yet is a pending round, diffed against the epic directly.
 */
const API = "https://api.github.com";

export type TicketCommit = { sha: string; when: number; subject: string };
export type TicketRound = {
  id: string; mergeSha: string | null; mergedAt: number; pending: boolean;
  commits: TicketCommit[]; files: number; added: number; removed: number;
};
export type TicketDiff = {
  branches: string[]; base: string; head: string;
  files: Array<{ path: string; added: number; removed: number }>; diff: string;
  commits: TicketCommit[];
  rounds?: TicketRound[]; round?: string; canRevert?: boolean;
  merged?: boolean; compareUrl?: string; error?: string;
};
type Gh = { owner: string; repo: string; token: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GitHub REST payloads
type Json = any;

/** owner, repo and token from an authenticated clone URL (https://x-access-token:T@github.com/o/r.git). */
export function parseAuthedGithubUrl(authUrl: string): Gh | null {
  const m = authUrl.match(/^https:\/\/(?:[^:@\/]+):([^@]+)@github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/);
  return m ? { token: decodeURIComponent(m[1]!), owner: m[2]!, repo: m[3]! } : null;
}

const ref = (name: string) => name.split("/").map(encodeURIComponent).join("/");

function client(gh: Gh, fetcher: typeof fetch) {
  const headers = { Authorization: `Bearer ${gh.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "LFG" };
  const repo = `${API}/repos/${gh.owner}/${gh.repo}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetcher(repo + path, { method, headers: body ? { ...headers, "Content-Type": "application/json" } : headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (r.ok ? await r.json() : null) as Json };
  };
  return { get: (path: string) => call("GET", path), post: (path: string, body: unknown) => call("POST", path, body), patch: (path: string, body: unknown) => call("PATCH", path, body) };
}

const seconds = (iso?: string) => Math.floor(Date.parse(iso ?? "") / 1000) || 0;
const commitView = (c: Json): TicketCommit => ({
  sha: String(c.sha).slice(0, 7), when: seconds(c.commit?.committer?.date ?? c.commit?.author?.date), subject: String(c.commit?.message ?? "").split("\n")[0]!,
});

/** The ticket's merges into its epic (newest first), plus unmerged pushed work. */
async function findRounds(api: ReturnType<typeof client>, base: string, head: string, knownMerges: string[] = []) {
  const [headLog, baseLog, ahead] = await Promise.all([
    api.get(`/commits?sha=${ref(head)}&per_page=100`), api.get(`/commits?sha=${ref(base)}&per_page=100`), api.get(`/compare/${ref(base)}...${ref(head)}`),
  ]);
  // The ticket branch's own line: follow first parents from its tip.
  const bySha = new Map<string, Json>((Array.isArray(headLog.body) ? headLog.body : []).map((c: Json) => [c.sha, c]));
  const own = new Set<string>();
  for (let c = (headLog.body ?? [])[0]; c && !own.has(c.sha); c = bySha.get(c.parents?.[0]?.sha)) own.add(c.sha);
  // A rebuild recreates the branch from the epic, so earlier merges fall off its line;
  // the platform's own log of merge SHAs for this ticket still identifies them.
  const logged = (sha: string) => knownMerges.some((k) => k.length >= 7 && sha.startsWith(k));
  const merges = (Array.isArray(baseLog.body) ? baseLog.body : [])
    .filter((c: Json) => c.parents?.length > 1 && (own.has(c.parents[1].sha) || logged(c.sha)))
    .map((c: Json) => ({ id: c.sha as string, mergeSha: c.sha as string, mergedAt: seconds(c.commit?.committer?.date), pending: false, from: c.parents[0].sha as string, to: c.parents[1].sha as string }));
  const pending = ahead.body && ahead.body.ahead_by > 0
    ? [{ id: "pending", mergeSha: null, mergedAt: 0, pending: true, from: base, to: head }] : [];
  return { rounds: [...pending, ...merges], baseTip: (baseLog.body ?? [])[0]?.sha as string | undefined, compareStatus: ahead.status };
}

export async function githubTicketDiff(gh: Gh, base: string, head: string, fetcher: typeof fetch = fetch, roundId?: string, knownMerges: string[] = []): Promise<TicketDiff> {
  const api = client(gh, fetcher);
  const branchList = await api.get("/branches?per_page=100");
  const branches = Array.isArray(branchList.body) ? branchList.body.map((b: { name: string }) => b.name).sort() : [];
  const empty = { branches, base, head, files: [], diff: "", commits: [] };
  if (branchList.status === 401 || branchList.status === 403) return { ...empty, error: "GitHub refused access to this repository. Reconnect GitHub in settings." };
  if (branchList.status === 404) return { ...empty, error: `GitHub repository ${gh.owner}/${gh.repo} was not found.` };
  if (branches.length && !branches.includes(head)) return { ...empty, error: `Branch ${head} isn't on GitHub yet. It appears once the ticket's build pushes it.` };

  const { rounds, baseTip, compareStatus } = await findRounds(api, base, head, knownMerges);
  if (!rounds.length) return { ...empty, rounds: [], merged: false, error: compareStatus === 404 ? `Couldn't compare ${head} with ${base}: one of them isn't on GitHub.` : undefined };
  // One compare per round gives its commits and size; the selected one also gives the diff.
  const compares = await Promise.all(rounds.map((r) => api.get(`/compare/${r.pending ? ref(r.from) : r.from}...${r.pending ? ref(r.to) : r.to}`)));
  type GhFile = { filename: string; additions: number; deletions: number; patch?: string; previous_filename?: string; status: string };
  const views: TicketRound[] = rounds.map((r, i) => {
    const files: GhFile[] = compares[i]!.body?.files ?? [];
    return { id: r.id, mergeSha: r.mergeSha, mergedAt: r.mergedAt, pending: r.pending,
      commits: ((compares[i]!.body?.commits ?? []) as Json[]).map(commitView).reverse(),
      files: files.length, added: files.reduce((n, f) => n + f.additions, 0), removed: files.reduce((n, f) => n + f.deletions, 0) };
  });
  const index = Math.max(0, rounds.findIndex((r) => r.id === roundId));
  const selected = rounds[index]!;
  const files: GhFile[] = compares[index]!.body?.files ?? [];
  const diff = files.map((f) => {
    const a = f.previous_filename ?? f.filename;
    const body = f.patch ?? (f.status === "removed" || f.status === "added" ? "" : "(binary or very large file: open it on GitHub)");
    return `diff --git a/${a} b/${f.filename}\n--- ${f.status === "added" ? "/dev/null" : "a/" + a}\n+++ ${f.status === "removed" ? "/dev/null" : "b/" + f.filename}\n${body}`;
  }).join("\n").slice(0, 300_000);
  return {
    branches, base, head, diff, rounds: views, round: selected.id,
    merged: rounds.some((r) => !r.pending),
    // Undo is a clean reversal only while the merge is still the newest thing on the epic.
    canRevert: !!selected.mergeSha && selected.mergeSha === baseTip,
    commits: views[index]!.commits,
    files: files.map((f) => ({ path: f.filename, added: f.additions, removed: f.deletions })),
    compareUrl: `https://github.com/${gh.owner}/${gh.repo}/compare/${selected.pending ? ref(base) : selected.from.slice(0, 12)}...${selected.pending ? ref(head) : selected.to.slice(0, 12)}`,
  };
}

/**
 * Undo a ticket's merge into its epic: a new commit on the epic whose tree is the epic
 * as it was before the merge. Only while that merge is still the epic's newest commit,
 * so no later work is lost.
 */
export async function revertTicketMerge(gh: Gh, base: string, mergeSha: string, message: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const api = client(gh, fetcher);
  const tip = (await api.get(`/git/ref/heads/${ref(base)}`)).body?.object?.sha;
  if (!tip) return { ok: false, error: `Couldn't read ${base} on GitHub.` };
  if (tip !== mergeSha) return { ok: false, error: "Newer work has landed on the epic since this merge, so undoing it here could drop that work. Ask the agent to revert it instead." };
  const merge = (await api.get(`/git/commits/${mergeSha}`)).body;
  const before = merge?.parents?.[0]?.sha;
  if (!before || merge.parents.length < 2) return { ok: false, error: "That commit isn't a ticket merge." };
  const tree = (await api.get(`/git/commits/${before}`)).body?.tree?.sha;
  if (!tree) return { ok: false, error: "Couldn't read the epic as it was before the merge." };
  const created = await api.post("/git/commits", { message, tree, parents: [mergeSha] });
  if (!created.body?.sha) return { ok: false, error: `GitHub refused the revert commit (HTTP ${created.status}).` };
  const moved = await api.patch(`/git/refs/heads/${ref(base)}`, { sha: created.body.sha, force: false });
  if (!moved.body) return { ok: false, error: moved.status === 422 ? "The epic changed while undoing; nothing was changed. Try again." : `GitHub refused to update ${base} (HTTP ${moved.status}).` };
  return { ok: true, sha: created.body.sha };
}
