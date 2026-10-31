/**
 * The project's branch workflow on GitHub, for the Git tab: every branch with its
 * ahead/behind against the default branch, merged state, latest commit and pull
 * request, plus the actions on them (open a PR, merge, delete).
 *
 * "Merged" means the branch has nothing the default branch lacks (ahead 0), or its
 * pull request was merged (squash/rebase merges leave the branch "ahead" forever).
 */
import { client, ref, type Gh } from "./ticket-diff-github.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GitHub REST payloads
type Json = any;

export type BranchPull = { number: number; title: string; url: string; state: "open" | "merged" | "closed"; draft: boolean; base: string; mergeable?: boolean | null };
export type BranchRow = {
  name: string; isDefault: boolean; protected: boolean;
  /** What ahead/behind and "merged" are measured against: the default branch, or the
   *  branch this one merges into (a ticket's epic branch). */
  base: string;
  aheadBy: number | null; behindBy: number | null; status: string;
  merged: boolean; pull: BranchPull | null;
  lastCommit: { sha: string; message: string; author: string; date: string } | null;
  url: string;
};
export type BranchOverview = {
  repo: string; repoUrl: string; defaultBranch: string;
  branches: BranchRow[]; total: number; truncated: boolean;
  counts: { merged: number; unmerged: number; openPulls: number; stale: number };
  error?: string;
};

const STALE_DAYS = 30;
const tipOf = (c: Json) => c ? {
  sha: String(c.sha).slice(0, 7), message: String(c.commit?.message ?? "").split("\n")[0]!,
  author: String(c.author?.login ?? c.commit?.author?.name ?? ""), date: String(c.commit?.committer?.date ?? c.commit?.author?.date ?? ""),
} : null;
const pullView = (p: Json): BranchPull => ({
  number: p.number, title: String(p.title ?? ""), url: String(p.html_url ?? ""), draft: !!p.draft, base: String(p.base?.ref ?? ""),
  state: p.state === "open" ? "open" : p.merged_at ? "merged" : "closed",
});

/** `bases` maps a branch to the branch it merges into; unlisted (or missing on GitHub) → the default branch. */
export async function githubBranchOverview(gh: Gh, fetcher: typeof fetch = fetch, limit = 100, bases: Record<string, string> = {}): Promise<BranchOverview> {
  const api = client(gh, fetcher);
  const repoUrl = `https://github.com/${gh.owner}/${gh.repo}`;
  const empty = (error: string, defaultBranch = ""): BranchOverview => ({
    repo: `${gh.owner}/${gh.repo}`, repoUrl, defaultBranch, branches: [], total: 0, truncated: false,
    counts: { merged: 0, unmerged: 0, openPulls: 0, stale: 0 }, error,
  });
  const info = await api.get("");
  if (info.status === 401 || info.status === 403) return empty("GitHub refused access to this repository with the connected token. Reconnect GitHub in Settings.");
  if (info.status === 404) return empty(`GitHub repository ${gh.owner}/${gh.repo} was not found (or the connected GitHub account can't see it).`);
  if (!info.body) return empty(`GitHub didn't answer for ${gh.owner}/${gh.repo} (HTTP ${info.status}).`);
  const defaultBranch = String(info.body.default_branch ?? "main");

  const listed: Json[] = [];
  for (let page = 1; page <= 10; page++) {
    const list = await api.get(`/branches?per_page=100&page=${page}`);
    const rows = Array.isArray(list.body) ? list.body : [];
    listed.push(...rows);
    if (rows.length < 100) break;
  }
  // Newest pull per head branch (the list is newest first); an open one wins over closed ones.
  const pulls = await api.get("/pulls?state=all&per_page=100&sort=created&direction=desc");
  const pullByHead = new Map<string, BranchPull>();
  for (const p of Array.isArray(pulls.body) ? pulls.body : []) {
    if (p.head?.repo?.full_name && p.head.repo.full_name !== `${gh.owner}/${gh.repo}`) continue;
    const head = String(p.head?.ref ?? ""), view = pullView(p), seen = pullByHead.get(head);
    if (!seen || (seen.state !== "open" && view.state === "open")) pullByHead.set(head, view);
  }

  const others = listed.filter((b) => b.name !== defaultBranch).map((b) => b as { name: string; protected?: boolean });
  const picked = others.slice(0, limit);
  const def = listed.find((b) => b.name === defaultBranch);
  const defTip = def ? (await api.get(`/commits/${ref(defaultBranch)}`)).body : null;
  const rows: BranchRow[] = [{
    name: defaultBranch, isDefault: true, protected: !!def?.protected, base: defaultBranch, aheadBy: 0, behindBy: 0, status: "default",
    merged: false, pull: null, lastCommit: tipOf(defTip), url: `${repoUrl}/tree/${ref(defaultBranch)}`,
  }];
  for (let i = 0; i < picked.length; i += 10) {
    rows.push(...await Promise.all(picked.slice(i, i + 10).map(async (b): Promise<BranchRow> => {
      const wanted = bases[b.name];
      const base = wanted && wanted !== b.name && listed.some((x) => x.name === wanted) ? wanted : defaultBranch;
      const c = await api.get(`/compare/${ref(base)}...${ref(b.name)}`);
      const pull = pullByHead.get(b.name) ?? null;
      const commits: Json[] = c.body?.commits ?? [];
      const tip = !c.body ? null : c.body.ahead_by === 0 ? c.body.merge_base_commit : commits.length === c.body.ahead_by ? commits[commits.length - 1] : null;
      const aheadBy = c.body ? Number(c.body.ahead_by) : null;
      return {
        name: b.name, isDefault: false, protected: !!b.protected, base,
        aheadBy, behindBy: c.body ? Number(c.body.behind_by) : null, status: c.body ? String(c.body.status) : `error (HTTP ${c.status})`,
        merged: aheadBy === 0 || (pull?.state === "merged"), pull, lastCommit: tipOf(tip), url: `${repoUrl}/tree/${ref(b.name)}`,
      };
    })));
  }
  const staleBefore = Date.now() - STALE_DAYS * 86_400_000;
  const branchRows = rows.slice(1);
  return {
    repo: `${gh.owner}/${gh.repo}`, repoUrl, defaultBranch, branches: rows, total: others.length, truncated: others.length > picked.length,
    counts: {
      merged: branchRows.filter((r) => r.merged).length,
      unmerged: branchRows.filter((r) => !r.merged).length,
      openPulls: branchRows.filter((r) => r.pull?.state === "open").length,
      stale: branchRows.filter((r) => !r.merged && r.lastCommit?.date && Date.parse(r.lastCommit.date) < staleBefore).length,
    },
  };
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
const refusal = (what: string, status: number, message: string) =>
  `GitHub refused to ${what}${message ? `: ${message}` : ` (HTTP ${status})`}.`;

export async function openPullRequest(gh: Gh, p: { head: string; base: string; title: string; body?: string; draft?: boolean }, fetcher: typeof fetch = fetch): Promise<Result<{ pull: BranchPull }>> {
  if (!p.head || !p.base || !p.title.trim()) return { ok: false, error: "A pull request needs a branch, a base and a title." };
  if (p.head === p.base) return { ok: false, error: "A branch can't be merged into itself." };
  const r = await client(gh, fetcher).post("/pulls", { head: p.head, base: p.base, title: p.title.trim(), body: p.body ?? "", draft: !!p.draft });
  return r.body ? { ok: true, pull: pullView(r.body) } : { ok: false, error: refusal("open the pull request", r.status, r.message) };
}

export async function mergePullRequest(gh: Gh, number: number, method: "merge" | "squash" | "rebase" = "merge", fetcher: typeof fetch = fetch): Promise<Result<{ sha: string }>> {
  const r = await client(gh, fetcher).put(`/pulls/${number}/merge`, { merge_method: method });
  if (r.body?.merged) return { ok: true, sha: String(r.body.sha) };
  if (r.status === 405) return { ok: false, error: `Pull request #${number} can't be merged yet${r.message ? `: ${r.message}` : " (checks or reviews pending, or it has conflicts)"}.` };
  return { ok: false, error: refusal(`merge #${number}`, r.status, r.message) };
}

/** Merge a branch straight into another without a pull request (GitHub's merge API). */
export async function mergeBranch(gh: Gh, head: string, base: string, fetcher: typeof fetch = fetch): Promise<Result<{ sha: string | null }>> {
  if (head === base) return { ok: false, error: "A branch can't be merged into itself." };
  const r = await client(gh, fetcher).post("/merges", { base, head, commit_message: `Merge ${head} into ${base}` });
  if (r.status === 201) return { ok: true, sha: String(r.body?.sha ?? "") };
  if (r.status === 204) return { ok: true, sha: null }; // already up to date
  if (r.status === 409) return { ok: false, error: `${head} conflicts with ${base}. Open a pull request and resolve the conflicts there.` };
  return { ok: false, error: refusal(`merge ${head} into ${base}`, r.status, r.message) };
}

export async function deleteBranch(gh: Gh, name: string, fetcher: typeof fetch = fetch): Promise<Result<object>> {
  const api = client(gh, fetcher);
  const info = await api.get("");
  if (info.body?.default_branch === name) return { ok: false, error: `${name} is the default branch and can't be deleted.` };
  const r = await api.del(`/git/refs/heads/${ref(name)}`);
  if (r.status === 204) return { ok: true };
  if (r.status === 422 || r.status === 404) return { ok: false, error: `Branch ${name} is already gone or is protected.` };
  return { ok: false, error: refusal(`delete ${name}`, r.status, r.message) };
}

export type ChangeSet = {
  base: string; head: string; aheadBy: number; behindBy: number;
  commits: Array<{ sha: string; message: string }>;
  files: Array<{ path: string; status: string; added: number; removed: number; patch: string }>;
  compareUrl: string; error?: string;
};

/** What a pull request from `head` into `base` would contain, for the pre-PR review. */
export async function githubChangeSet(gh: Gh, base: string, head: string, fetcher: typeof fetch = fetch): Promise<ChangeSet> {
  const compareUrl = `https://github.com/${gh.owner}/${gh.repo}/compare/${ref(base)}...${ref(head)}`;
  const c = await client(gh, fetcher).get(`/compare/${ref(base)}...${ref(head)}`);
  const empty = { base, head, aheadBy: 0, behindBy: 0, commits: [], files: [], compareUrl };
  if (!c.body) return { ...empty, error: c.status === 404 ? `Couldn't compare ${head} with ${base}: one of them isn't on GitHub.` : refusal(`compare ${head} with ${base}`, c.status, c.message) };
  return {
    base, head, aheadBy: Number(c.body.ahead_by), behindBy: Number(c.body.behind_by), compareUrl,
    commits: ((c.body.commits ?? []) as Json[]).map((x) => ({ sha: String(x.sha).slice(0, 7), message: String(x.commit?.message ?? "").split("\n")[0]! })),
    files: ((c.body.files ?? []) as Json[]).map((f) => ({
      path: String(f.filename), status: String(f.status), added: Number(f.additions ?? 0), removed: Number(f.deletions ?? 0),
      patch: String(f.patch ?? (f.status === "removed" ? "" : "(binary or too large to show)")),
    })),
  };
}

/** A file's full text at a branch, for reviewing a change in context. */
export async function githubFileAt(gh: Gh, path: string, branch: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const r = await client(gh, fetcher).get(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`);
  if (!r.body || Array.isArray(r.body) || typeof r.body.content !== "string") return null;
  return Buffer.from(r.body.content, "base64").toString("utf8");
}
