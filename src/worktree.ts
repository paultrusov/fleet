import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./util.ts";

/**
 * One bare mirror per repo, kept between runs, plus a throwaway git worktree per
 * (run, repo).
 *
 * Why worktrees and not a clone per run: a clone per run re-downloads the whole
 * history every time and gives every concurrent run its own copy of the object
 * store. A worktree shares the mirror's objects but gets its own working directory,
 * index and HEAD, so two runs touching the same repo cannot see each other's files
 * or fight over the index. It is also the failure story: if a run dies mid-flight,
 * the worktrees are garbage in a known directory and `git worktree prune` cleans
 * them, while the mirror (the expensive part) is untouched.
 */
export class RepoCache {
  cacheDir: string;
  workDir: string;

  constructor(stateDir: string) {
    this.cacheDir = join(stateDir, "cache");
    this.workDir = join(stateDir, "work");
  }

  /**
   * Where a repo's mirror lives. Keyed by name AND remote, because repo names are
   * only unique within one fleet: running against a local fleet and a GitHub fleet
   * that share service names would otherwise reuse one cache entry for two different
   * repositories, and the branch gets built on the wrong history.
   */
  mirrorPath(name: string, url: string): string {
    const key = createHash("sha1").update(url.replace(/\/\/[^@/]+@/, "//")).digest("hex").slice(0, 8);
    return join(this.cacheDir, `${name}-${key}.git`);
  }

  /** Clone the repo bare on first sight, otherwise just fetch. Returns the mirror path. */
  async mirror(name: string, url: string): Promise<string> {
    const path = this.mirrorPath(name, url);
    if (existsSync(path)) {
      await this.reclaim(path);
      await git(["remote", "update", "--prune"], path);
    } else {
      await mkdir(this.cacheDir, { recursive: true });
      await git(["clone", "--mirror", url, path]);
    }
    return path;
  }

  /**
   * Drop worktrees left behind by a run that died.
   *
   * This is not housekeeping, it is a correctness fix. A worktree still holds its
   * branch checked out, and git refuses to fetch into a checked-out branch, so a
   * resumed run failed on exactly the repos that were in flight when the previous
   * run was killed -- the ones resume exists for. Every worktree under workDir is
   * disposable by construction: it is recreated from the mirror on demand.
   */
  private async reclaim(mirrorPath: string): Promise<void> {
    let listing: string;
    try {
      listing = await git(["worktree", "list", "--porcelain"], mirrorPath);
    } catch {
      return;
    }
    const paths = listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((p) => p.startsWith(this.workDir));
    if (paths.length === 0) return;
    for (const p of paths) {
      await rm(p, { recursive: true, force: true });
    }
    await git(["worktree", "prune"], mirrorPath).catch(() => {});
  }

  async defaultBranch(mirrorPath: string): Promise<string> {
    try {
      const ref = await git(["symbolic-ref", "--short", "HEAD"], mirrorPath);
      return ref.trim();
    } catch {
      return "main";
    }
  }

  /** A working directory for this repo in this run, with `branch` created off `baseRef`. */
  async worktree(mirrorPath: string, runId: string, name: string, branch: string, baseRef: string): Promise<string> {
    const path = join(this.workDir, runId, name);
    await rm(path, { recursive: true, force: true });
    await mkdir(join(this.workDir, runId), { recursive: true });
    await git(["worktree", "add", "--force", "-B", branch, path, baseRef], mirrorPath);
    return path;
  }

  /** Detached checkout of an existing ref, used by CI and by merge/revert. */
  async detached(mirrorPath: string, runId: string, name: string, ref: string): Promise<string> {
    const path = join(this.workDir, runId, `${name}.tmp-${process.pid}-${Date.now()}`);
    await mkdir(join(this.workDir, runId), { recursive: true });
    await git(["worktree", "add", "--force", "--detach", path, ref], mirrorPath);
    return path;
  }

  async release(mirrorPath: string, path: string): Promise<void> {
    try {
      await git(["worktree", "remove", "--force", path], mirrorPath);
    } catch {
      await rm(path, { recursive: true, force: true });
      await git(["worktree", "prune"], mirrorPath).catch(() => {});
    }
  }
}
