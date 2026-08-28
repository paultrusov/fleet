import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { exec, git } from "../util.ts";
import type { RepoCache } from "../worktree.ts";
import type { CiStatus, Provider, PullRequest, RepoRef } from "./types.ts";

/**
 * A local git forge: bare repositories in one directory stand in for the remote,
 * a PR is a branch plus a record in `fleet-prs.json`, and CI is the repo's own
 * `fleet-ci.sh` run against the branch tip.
 *
 * This exists so the fleet can be scaled to hundreds of repos and benchmarked
 * without creating hundreds of repositories on github.com. The engine, the
 * worktree isolation, the git operations and the state machine are the same code
 * either way -- only this file swaps out.
 */
export class LocalProvider implements Provider {
  kind = "local";
  root: string;
  cache: RepoCache;
  runId: string;

  constructor(root: string, cache: RepoCache, runId: string) {
    this.root = root;
    this.cache = cache;
    this.runId = runId;
  }

  async listRepos(selector: string): Promise<RepoRef[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.endsWith(".git"))
      .map((e) => ({ name: e.name.replace(/\.git$/, ""), url: join(this.root, e.name) }))
      .filter((r) => selector === "*" || r.name.includes(selector))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  remoteUrl(repo: RepoRef): string {
    return repo.url;
  }

  private prFile(repo: RepoRef): string {
    return join(repo.url, "fleet-prs.json");
  }

  private readPrs(repo: RepoRef): PullRequest[] {
    const f = this.prFile(repo);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as PullRequest[]) : [];
  }

  async openPr(repo: RepoRef, branch: string, _base: string, _title: string, _body: string): Promise<PullRequest> {
    const prs = this.readPrs(repo);
    const existing = prs.find((p) => p.branch === branch);
    if (existing) return existing;
    const pr: PullRequest = { number: prs.length + 1, url: `file://${repo.url}#pr-${prs.length + 1}`, branch };
    prs.push(pr);
    writeFileSync(this.prFile(repo), JSON.stringify(prs, null, 2));
    return pr;
  }

  /** Check out the branch tip and run the repo's own CI script. */
  async ciStatus(repo: RepoRef, _pr: PullRequest, headSha: string): Promise<CiStatus> {
    const mirror = this.cache.mirrorPath(repo.name, repo.url);
    const wt = await this.cache.detached(mirror, this.runId, repo.name, headSha);
    try {
      if (!existsSync(join(wt, "fleet-ci.sh"))) return "none";
      const r = await exec("bash", ["fleet-ci.sh"], { cwd: wt, timeoutMs: 120_000 });
      return r.code === 0 ? "success" : "failure";
    } finally {
      await this.cache.release(mirror, wt);
    }
  }

  async merge(repo: RepoRef, pr: PullRequest, base: string): Promise<string> {
    const mirror = this.cache.mirrorPath(repo.name, repo.url);
    const wt = await this.cache.detached(mirror, this.runId, repo.name, `refs/heads/${base}`);
    try {
      await git(["merge", "--no-ff", "-m", `Merge fleet PR #${pr.number} (${pr.branch})`, `refs/heads/${pr.branch}`], wt);
      const sha = (await git(["rev-parse", "HEAD"], wt)).trim();
      await git(["push", repo.url, `HEAD:refs/heads/${base}`], wt);
      return sha;
    } finally {
      await this.cache.release(mirror, wt);
    }
  }
}
