import { execSync } from "node:child_process";
import type { CiStatus, Provider, PullRequest, RepoRef } from "./types.ts";

const API = "https://api.github.com";

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GitHub credentials: set GITHUB_TOKEN or run `gh auth login`.");
  }
}

export class GitHubProvider implements Provider {
  kind = "github";
  owner: string;
  private tok: string;

  constructor(owner: string) {
    this.owner = owner;
    this.tok = token();
  }

  private async api(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.tok}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    // Secondary rate limits are the normal failure mode when touching hundreds of
    // repos at once. Back off and retry rather than failing the repo.
    if ((res.status === 403 || res.status === 429) && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      const wait = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      return this.api(path, init, attempt + 1);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.api(path, init);
    if (!res.ok) throw new Error(`GitHub ${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Selector is a repo topic, or "*" for every non-archived repo the owner has. */
  async listRepos(selector: string): Promise<RepoRef[]> {
    const out: RepoRef[] = [];
    // `/users/{owner}/repos` only ever returns public repos. When the owner is the
    // authenticated user, `/user/repos` is the endpoint that can see private ones --
    // otherwise a private fleet silently discovers as zero repos.
    const base = (await this.isOrg())
      ? `/orgs/${this.owner}/repos`
      : (await this.login()) === this.owner
        ? `/user/repos?affiliation=owner&`
        : `/users/${this.owner}/repos`;
    for (let page = 1; ; page++) {
      const sep = base.endsWith("&") ? "" : "?";
      const batch = await this.json<{ name: string; topics: string[]; archived: boolean }[]>(
        `${base}${sep}per_page=100&page=${page}`,
      );
      for (const r of batch) {
        if (r.archived) continue;
        if (selector !== "*" && !(r.topics ?? []).includes(selector)) continue;
        out.push({ name: r.name, url: `https://github.com/${this.owner}/${r.name}.git` });
      }
      if (batch.length < 100) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private loginCache: string | undefined;
  private async login(): Promise<string> {
    if (this.loginCache === undefined) {
      this.loginCache = (await this.json<{ login: string }>("/user")).login;
    }
    return this.loginCache;
  }

  private orgCache: boolean | undefined;
  private async isOrg(): Promise<boolean> {
    if (this.orgCache === undefined) {
      const res = await this.api(`/orgs/${this.owner}`);
      this.orgCache = res.ok;
    }
    return this.orgCache;
  }

  remoteUrl(repo: RepoRef): string {
    return `https://x-access-token:${this.tok}@github.com/${this.owner}/${repo.name}.git`;
  }

  async openPr(repo: RepoRef, branch: string, base: string, title: string, body: string): Promise<PullRequest> {
    const res = await this.api(`/repos/${this.owner}/${repo.name}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head: branch, base, body }),
    });
    if (res.ok) {
      const pr = (await res.json()) as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url, branch };
    }
    // A PR for this branch already exists (resumed run). Adopt it instead of failing.
    if (res.status === 422) {
      const existing = await this.json<{ number: number; html_url: string }[]>(
        `/repos/${this.owner}/${repo.name}/pulls?head=${this.owner}:${branch}&state=open`,
      );
      if (existing[0]) return { number: existing[0].number, url: existing[0].html_url, branch };
    }
    throw new Error(`openPr ${repo.name} -> ${res.status} ${await res.text()}`);
  }

  async ciStatus(repo: RepoRef, _pr: PullRequest, headSha: string): Promise<CiStatus> {
    const runs = await this.json<{
      total_count: number;
      check_runs: { status: string; conclusion: string | null }[];
    }>(`/repos/${this.owner}/${repo.name}/commits/${headSha}/check-runs`);
    if (runs.total_count === 0) {
      const combined = await this.json<{ state: string; total_count: number }>(
        `/repos/${this.owner}/${repo.name}/commits/${headSha}/status`,
      );
      if (combined.total_count === 0) return "none";
      return combined.state === "success" ? "success" : combined.state === "pending" ? "pending" : "failure";
    }
    if (runs.check_runs.some((c) => c.status !== "completed")) return "pending";
    const bad = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
    if (runs.check_runs.some((c) => bad.has(c.conclusion ?? ""))) return "failure";
    return "success";
  }

  async merge(repo: RepoRef, pr: PullRequest, _base: string): Promise<string> {
    const res = await this.api(`/repos/${this.owner}/${repo.name}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "merge" }),
    });
    if (!res.ok) throw new Error(`merge ${repo.name}#${pr.number} -> ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { sha: string };
    return body.sha;
  }
}
