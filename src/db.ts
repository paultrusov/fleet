import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Every repo in a run sits in exactly one of these. The state machine is the whole
 * reason a run is resumable: an interrupted run is just a run with rows still in
 * `pending`, and a re-run only picks up rows that are not terminal.
 */
export type RepoState =
  | "pending"      // discovered, not attempted yet
  | "skipped"      // transform made no change, nothing to propose
  | "pr_open"      // change pushed, PR open, CI not green yet
  | "quarantined"  // CI failed; held for a human, never retried blindly
  | "merged"       // CI green, auto-merged
  | "reverted"     // merge undone by `fleet revert`
  | "error";       // the tool itself failed on this repo

export type RepoRow = {
  run_id: string;
  repo: string;
  url: string;
  state: RepoState;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  ci: string | null;
  head_sha: string | null;
  merge_sha: string | null;
  summary: string | null;
  diff: string | null;
  error: string | null;
  updated_at: string;
};

export type RunRow = {
  id: string;
  transform: string;
  args: string;
  selector: string;
  provider: string;
  dry_run: number;
  started_at: string;
  finished_at: string | null;
};

export class RunStore {
  db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, transform TEXT NOT NULL, args TEXT NOT NULL,
        selector TEXT NOT NULL, provider TEXT NOT NULL, dry_run INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS repos (
        run_id TEXT NOT NULL, repo TEXT NOT NULL, url TEXT NOT NULL,
        state TEXT NOT NULL, branch TEXT, pr_number INTEGER, pr_url TEXT,
        ci TEXT, head_sha TEXT, merge_sha TEXT, summary TEXT, diff TEXT, error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, repo)
      );
    `);
  }

  createRun(r: Omit<RunRow, "started_at" | "finished_at">): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, transform, args, selector, provider, dry_run, started_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(r.id, r.transform, r.args, r.selector, r.provider, r.dry_run);
  }

  finishRun(id: string): void {
    this.db.prepare(`UPDATE runs SET finished_at = datetime('now') WHERE id = ?`).run(id);
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  listRuns(): RunRow[] {
    return this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC`).all() as RunRow[];
  }

  /** Idempotent: re-running a run keeps rows that already exist, so state survives. */
  seedRepo(runId: string, repo: string, url: string): void {
    this.db
      .prepare(
        `INSERT INTO repos (run_id, repo, url, state, updated_at)
         VALUES (?, ?, ?, 'pending', datetime('now'))
         ON CONFLICT (run_id, repo) DO NOTHING`,
      )
      .run(runId, repo, url);
  }

  update(runId: string, repo: string, patch: Partial<RepoRow>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null);
    this.db
      .prepare(`UPDATE repos SET ${set}, updated_at = datetime('now') WHERE run_id = ? AND repo = ?`)
      .run(...values, runId, repo);
  }

  repos(runId: string, states?: RepoState[]): RepoRow[] {
    if (!states || states.length === 0) {
      return this.db.prepare(`SELECT * FROM repos WHERE run_id = ? ORDER BY repo`).all(runId) as RepoRow[];
    }
    const marks = states.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM repos WHERE run_id = ? AND state IN (${marks}) ORDER BY repo`)
      .all(runId, ...states) as RepoRow[];
  }

  counts(runId: string): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM repos WHERE run_id = ? GROUP BY state`)
      .all(runId) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
