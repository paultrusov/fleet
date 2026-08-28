import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { RunStore } from "./db.ts";
import type { RepoRow } from "./db.ts";
import { pool } from "./pool.ts";
import { GitHubProvider } from "./providers/github.ts";
import { LocalProvider } from "./providers/local.ts";
import type { Provider, RepoRef } from "./providers/types.ts";
import { getTransform } from "./transforms/index.ts";
import type { TransformArgs } from "./transforms/types.ts";
import { fmtDuration, git } from "./util.ts";
import { RepoCache } from "./worktree.ts";

const MAX_DIFF = 8000;
const COMMITTER = ["-c", "user.name=fleet", "-c", "user.email=fleet@localhost"];

export function makeProvider(cfg: Config, cache: RepoCache, runId: string): Provider {
  if (cfg.provider === "github") {
    if (!cfg.githubOwner) throw new Error("provider github needs githubOwner in fleet.config.json");
    return new GitHubProvider(cfg.githubOwner);
  }
  return new LocalProvider(cfg.localRoot, cache, runId);
}

export function openStore(cfg: Config): RunStore {
  return new RunStore(join(cfg.stateDir, "fleet.db"));
}

export type RunOptions = {
  cfg: Config;
  transform: string;
  args: TransformArgs;
  selector: string;
  dryRun: boolean;
  resume?: string;
  onProgress?: (done: number, total: number, repo: string, state: string) => void;
};

export type RunSummary = { runId: string; total: number; elapsedMs: number; counts: Record<string, number> };

/**
 * Propose the change on every repo in the fleet.
 *
 * Resumability is not a feature bolted on top -- it falls out of writing each repo's
 * outcome to SQLite as it happens and only ever picking up repos still in `pending`.
 * A killed run, a laptop that slept, a GitHub outage halfway through: re-run with the
 * same run id and only the unfinished repos are touched.
 */
export async function runFleet(opts: RunOptions): Promise<RunSummary> {
  const { cfg, selector, dryRun } = opts;
  const transform = getTransform(opts.transform);
  for (const required of transform.requiredArgs) {
    if (!opts.args[required]) throw new Error(`transform ${transform.name} requires --${required}`);
  }

  const started = Date.now();
  const store = openStore(cfg);
  const runId = opts.resume ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const cache = new RepoCache(cfg.stateDir);
  const provider = makeProvider(cfg, cache, runId);

  let repos: RepoRef[];
  if (opts.resume) {
    if (!store.getRun(runId)) throw new Error(`no such run: ${runId}`);
    repos = store.repos(runId).map((r) => ({ name: r.repo, url: r.url }));
  } else {
    store.createRun({
      id: runId,
      transform: transform.name,
      args: JSON.stringify(opts.args),
      selector,
      provider: provider.kind,
      dry_run: dryRun ? 1 : 0,
    });
    repos = await provider.listRepos(selector);
    for (const r of repos) store.seedRepo(runId, r.name, r.url);
  }

  const pending = new Set(store.repos(runId, ["pending"]).map((r) => r.repo));
  const todo = repos.filter((r) => pending.has(r.name));
  const branch = `${cfg.branchPrefix}/${runId}`;
  let done = 0;

  await pool(todo, cfg.concurrency, async (repo) => {
    let mirror = "";
    let worktree = "";
    let state = "error";
    try {
      mirror = await cache.mirror(repo.name, provider.remoteUrl(repo));
      const base = await cache.defaultBranch(mirror);
      worktree = await cache.worktree(mirror, runId, repo.name, branch, `refs/heads/${base}`);
      const baseSha = (await git(["rev-parse", "HEAD"], worktree)).trim();

      const result = await transform.apply(worktree, opts.args);
      if (!result.changed) {
        store.update(runId, repo.name, { state: "skipped", summary: result.summary });
        state = "skipped";
        return;
      }

      await git(["add", "-A"], worktree);
      await git([...COMMITTER, "commit", "-m", `${transform.name}: ${result.summary}\n\nfleet-run: ${runId}`], worktree);
      const headSha = (await git(["rev-parse", "HEAD"], worktree)).trim();
      const diff = (await git(["diff", `${baseSha}..HEAD`], worktree)).slice(0, MAX_DIFF);

      if (dryRun) {
        store.update(runId, repo.name, { state: "pending", summary: result.summary, diff, branch, head_sha: headSha });
        state = "planned";
        return;
      }

      await git(["push", "--force", provider.remoteUrl(repo), `HEAD:refs/heads/${branch}`], worktree);
      const pr = await provider.openPr(
        repo,
        branch,
        base,
        `[fleet] ${transform.name}: ${result.summary}`,
        prBody(runId, transform.name, opts.args, result.summary),
      );
      store.update(runId, repo.name, {
        state: "pr_open",
        summary: result.summary,
        diff,
        branch,
        head_sha: headSha,
        pr_number: pr.number,
        pr_url: pr.url,
      });
      state = "pr_open";
    } catch (err) {
      store.update(runId, repo.name, { state: "error", error: String(err).slice(0, 2000) });
      state = "error";
    } finally {
      if (mirror && worktree) await cache.release(mirror, worktree).catch(() => {});
      done++;
      opts.onProgress?.(done, todo.length, repo.name, state);
    }
  });

  if (!dryRun) store.finishRun(runId);
  return { runId, total: repos.length, elapsedMs: Date.now() - started, counts: store.counts(runId) };
}

function prBody(runId: string, transform: string, args: TransformArgs, summary: string): string {
  const argLine = Object.entries(args).map(([k, v]) => `--${k} ${v}`).join(" ");
  return [
    `Automated change opened by **fleet**.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| run | \`${runId}\` |`,
    `| transform | \`${transform} ${argLine}\` |`,
    `| effect here | ${summary} |`,
    ``,
    `This PR merges automatically once CI is green. If CI fails it is quarantined for a human`,
    `and never retried blindly. \`fleet revert ${runId}\` undoes every merge from this run.`,
  ].join("\n");
}

export type StatusSummary = { merged: number; quarantined: number; pending: number; errors: number };

/**
 * Poll CI on every open PR, merge the green ones, quarantine the red ones.
 * Failures are never retried: a red test on a codemod means the codemod was wrong
 * for that repo, and retrying it just produces the same red twice.
 */
export async function statusFleet(cfg: Config, runId: string, opts: { wait?: boolean; intervalMs?: number } = {}): Promise<StatusSummary> {
  const store = openStore(cfg);
  const run = store.getRun(runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  const cache = new RepoCache(cfg.stateDir);
  const provider = makeProvider(cfg, cache, runId);
  const summary: StatusSummary = { merged: 0, quarantined: 0, pending: 0, errors: 0 };

  while (true) {
    const open = store.repos(runId, ["pr_open"]);
    if (open.length === 0) break;
    summary.pending = 0;

    await pool(open, cfg.concurrency, async (row) => {
      const repo: RepoRef = { name: row.repo, url: row.url };
      const pr = { number: row.pr_number!, url: row.pr_url!, branch: row.branch! };
      try {
        const ci = await provider.ciStatus(repo, pr, row.head_sha!);
        if (ci === "pending") {
          store.update(runId, row.repo, { ci });
          summary.pending++;
          return;
        }
        if (ci === "failure") {
          store.update(runId, row.repo, { state: "quarantined", ci });
          summary.quarantined++;
          return;
        }
        const mergeSha = await provider.merge(repo, pr, await defaultBranchOf(cache, repo, provider));
        store.update(runId, row.repo, { state: "merged", ci, merge_sha: mergeSha });
        summary.merged++;
      } catch (err) {
        store.update(runId, row.repo, { state: "error", error: String(err).slice(0, 2000) });
        summary.errors++;
      }
    });

    if (!opts.wait || summary.pending === 0) break;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 15_000));
  }
  return summary;
}

async function defaultBranchOf(cache: RepoCache, repo: RepoRef, provider: Provider): Promise<string> {
  const mirror = await cache.mirror(repo.name, provider.remoteUrl(repo));
  return cache.defaultBranch(mirror);
}

/** Revert every merge this run landed, in one command. */
export async function revertFleet(cfg: Config, runId: string): Promise<{ reverted: number; errors: number }> {
  const store = openStore(cfg);
  if (!store.getRun(runId)) throw new Error(`no such run: ${runId}`);
  const cache = new RepoCache(cfg.stateDir);
  const provider = makeProvider(cfg, cache, runId);
  const merged = store.repos(runId, ["merged"]);
  let reverted = 0;
  let errors = 0;

  await pool(merged, cfg.concurrency, async (row) => {
    const repo: RepoRef = { name: row.repo, url: row.url };
    let mirror = "";
    let wt = "";
    try {
      mirror = await cache.mirror(repo.name, provider.remoteUrl(repo)); // fetch the merge we are undoing
      const base = await cache.defaultBranch(mirror);
      wt = await cache.detached(mirror, runId, repo.name, `refs/heads/${base}`);
      await git([...COMMITTER, "revert", "--no-edit", "-m", "1", row.merge_sha!], wt);
      await git(["push", provider.remoteUrl(repo), `HEAD:refs/heads/${base}`], wt);
      store.update(runId, row.repo, { state: "reverted" });
      reverted++;
    } catch (err) {
      store.update(runId, row.repo, { state: "error", error: String(err).slice(0, 2000) });
      errors++;
    } finally {
      if (mirror && wt) await cache.release(mirror, wt).catch(() => {});
    }
  });
  return { reverted, errors };
}

/** The consolidated diff a dry run produces, so the whole fleet is reviewable in one file. */
export async function writeDiffReport(rows: RepoRow[], path: string, runId: string, elapsedMs: number): Promise<void> {
  const changed = rows.filter((r) => r.diff);
  const lines = [
    `# fleet dry run ${runId}`,
    ``,
    `${changed.length} of ${rows.length} repos would change. Planned in ${fmtDuration(elapsedMs)}.`,
    ``,
  ];
  for (const r of changed) {
    lines.push(`## ${r.repo}`, ``, `${r.summary}`, ``, "```diff", r.diff!.trimEnd(), "```", "");
  }
  const untouched = rows.filter((r) => !r.diff);
  if (untouched.length) {
    lines.push(`## No change (${untouched.length})`, ``, untouched.map((r) => `- ${r.repo}: ${r.summary ?? ""}`).join("\n"));
  }
  await writeFile(path, lines.join("\n"));
}
