/**
 * A ticket's changes read straight from GitHub's compare API, so the Git tab works
 * without a preview sandbox (isolated builds push from a VM that is gone afterwards).
 *
 * Once a ticket is merged into its epic, `epic...ticket` is empty: the merge-base is
 * the ticket's own tip. The ticket's real changes are then measured from the epic as
 * it stood just before the merge (the merge commit's first parent).
 */
const API = "https://api.github.com";

export type TicketDiff = {
  branches: string[]; base: string; head: string;
  files: Array<{ path: string; added: number; removed: number }>; diff: string;
  commits: Array<{ sha: string; when: number; subject: string }>;
  merged?: boolean; compareUrl?: string; error?: string;
};

/** owner, repo and token from an authenticated clone URL (https://x-access-token:T@github.com/o/r.git). */
export function parseAuthedGithubUrl(authUrl: string): { owner: string; repo: string; token: string } | null {
  const m = authUrl.match(/^https:\/\/(?:[^:@\/]+):([^@]+)@github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/);
  return m ? { token: decodeURIComponent(m[1]!), owner: m[2]!, repo: m[3]! } : null;
}

const ref = (name: string) => name.split("/").map(encodeURIComponent).join("/");

export async function githubTicketDiff(
  gh: { owner: string; repo: string; token: string }, base: string, head: string,
  fetcher: typeof fetch = fetch,
): Promise<TicketDiff> {
  const headers = { Authorization: `Bearer ${gh.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "LFG" };
  const repo = `${API}/repos/${gh.owner}/${gh.repo}`;
  const get = async (path: string) => {
    const r = await fetcher(repo + path, { headers });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GitHub REST payloads
    return { status: r.status, body: (r.ok ? await r.json() : null) as any };
  };
  const branchList = await get("/branches?per_page=100");
  const branches = Array.isArray(branchList.body) ? branchList.body.map((b: { name: string }) => b.name).sort() : [];
  const empty = { branches, base, head, files: [], diff: "", commits: [] };
  if (branchList.status === 401 || branchList.status === 403) return { ...empty, error: "GitHub refused access to this repository. Reconnect GitHub in settings." };
  if (branchList.status === 404) return { ...empty, error: `GitHub repository ${gh.owner}/${gh.repo} was not found.` };
  if (branches.length && !branches.includes(head)) return { ...empty, error: `Branch ${head} isn't on GitHub yet. It appears once the ticket's build pushes it.` };

  let from = base, merged = false;
  let cmp = await get(`/compare/${ref(base)}...${ref(head)}`);
  if (cmp.body && cmp.body.ahead_by === 0) {
    // Merged into the base already: find the merge commit and diff from its first parent.
    const tip = (await get(`/commits/${ref(head)}`)).body?.sha as string | undefined;
    const recent = (await get(`/commits?sha=${ref(base)}&per_page=100`)).body;
    const merge = Array.isArray(recent) ? recent.find((c: { parents: Array<{ sha: string }> }) => c.parents?.length > 1 && c.parents.slice(1).some((p) => p.sha === tip)) : null;
    if (merge) { from = merge.parents[0].sha; merged = true; cmp = await get(`/compare/${from}...${ref(head)}`); }
  }
  if (!cmp.body) return { ...empty, error: cmp.status === 404 ? `Couldn't compare ${head} with ${base}: one of them isn't on GitHub.` : `GitHub returned ${cmp.status} for this comparison.` };

  type GhFile = { filename: string; additions: number; deletions: number; patch?: string; previous_filename?: string; status: string };
  const files: GhFile[] = cmp.body.files ?? [];
  const diff = files.map((f) => {
    const a = f.previous_filename ?? f.filename;
    const body = f.patch ?? (f.status === "removed" || f.status === "added" ? "" : "(binary or very large file: open it on GitHub)");
    return `diff --git a/${a} b/${f.filename}\n--- ${f.status === "added" ? "/dev/null" : "a/" + a}\n+++ ${f.status === "removed" ? "/dev/null" : "b/" + f.filename}\n${body}`;
  }).join("\n").slice(0, 300_000);
  type GhCommit = { sha: string; commit: { message: string; author?: { date?: string } } };
  const commits = ((cmp.body.commits ?? []) as GhCommit[]).reverse().slice(0, 100).map((c) => ({
    sha: c.sha.slice(0, 7), when: Math.floor(Date.parse(c.commit.author?.date ?? "") / 1000) || 0, subject: c.commit.message.split("\n")[0]!,
  }));
  return {
    branches, base, head, merged, diff, commits,
    files: files.map((f) => ({ path: f.filename, added: f.additions, removed: f.deletions })),
    compareUrl: `https://github.com/${gh.owner}/${gh.repo}/compare/${merged ? from.slice(0, 12) : ref(base)}...${ref(head)}`,
  };
}
