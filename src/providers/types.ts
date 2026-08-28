export type RepoRef = { name: string; url: string };

export type PullRequest = { number: number; url: string; branch: string };

export type CiStatus = "pending" | "success" | "failure" | "none";

export type Provider = {
  kind: string;
  /** Discover the fleet. `selector` is a topic (GitHub) or a name prefix (local); "*" means everything. */
  listRepos(selector: string): Promise<RepoRef[]>;
  /** URL git can fetch and push with credentials already attached. */
  remoteUrl(repo: RepoRef): string;
  openPr(repo: RepoRef, branch: string, base: string, title: string, body: string): Promise<PullRequest>;
  ciStatus(repo: RepoRef, pr: PullRequest, headSha: string): Promise<CiStatus>;
  /** Merge the PR. Returns the merge commit sha on the base branch. */
  merge(repo: RepoRef, pr: PullRequest, base: string): Promise<string>;
};
