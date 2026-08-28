#!/usr/bin/env node
/**
 * Self-test. Generates a throwaway fleet and asserts the behaviours the tool claims:
 * idempotent typed transforms, string literals left alone, CI gating, quarantine,
 * resume after a kill, and revert.
 *
 *   node scripts/test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.ts";
import { openStore, revertFleet, runFleet, statusFleet } from "../src/engine.ts";
import { git } from "../src/util.ts";
import { repoBroken } from "./templates.ts";

const run = promisify(execFile);
const COUNT = 24; // includes index 7, the repo whose contract test pins the old API
const BROKEN = Array.from({ length: COUNT }, (_, i) => i).filter(repoBroken).length;
const GREEN = COUNT - BROKEN;

const root = await mkdtemp(join(tmpdir(), "fleet-test-remotes-"));
const state = await mkdtemp(join(tmpdir(), "fleet-test-state-"));
const cfg = { ...loadConfig(), provider: "local" as const, localRoot: root, stateDir: state, concurrency: 8 };

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

await run("node", ["scripts/make-fleet.ts", "--count", String(COUNT), "--root", root]);

// --- dry run changes nothing on the remotes -------------------------------------
const plan = await runFleet({ cfg, transform: "rewrite-import", args: { from: "@acme/utils", to: "@acme/core" }, selector: "*", dryRun: true });
const planRows = openStore(cfg).repos(plan.runId);
check("plan produces a diff for every repo", () => assert.equal(planRows.filter((r) => r.diff).length, COUNT));
check("plan opens no PRs", () => assert.equal(openStore(cfg).counts(plan.runId).pr_open ?? 0, 0));

// --- the real run ---------------------------------------------------------------
const first = await runFleet({ cfg, transform: "rewrite-import", args: { from: "@acme/utils", to: "@acme/core" }, selector: "*", dryRun: false });
check("run opens one PR per repo", () => assert.equal(first.counts.pr_open, COUNT));

const status = await statusFleet(cfg, first.runId);
check("CI gates the merge: green merges", () => assert.equal(status.merged, GREEN));
check("CI gates the merge: red is quarantined", () => assert.equal(status.quarantined, BROKEN));
check("nothing errored", () => assert.equal(status.errors, 0));

const head = await git(["show", "main:src/index.ts"], join(root, "svc-000-flat.git"));
check("imports were rewritten", () => assert.match(head, /from "@acme\/core"/));
check("a string literal containing the package name was not", () =>
  assert.match(head, /https:\/\/example\.invalid\/@acme\/utils\/v1/));

// --- idempotency ------------------------------------------------------------------
const second = await runFleet({ cfg, transform: "rewrite-import", args: { from: "@acme/utils", to: "@acme/core" }, selector: "*", dryRun: false });
check("re-running skips repos already migrated", () => assert.equal(second.counts.skipped, GREEN));

// --- resume: drop half the run back to pending, as a kill would leave it -----------
const store = openStore(cfg);
const victims = store.repos(second.runId, ["skipped"]).slice(0, 5);
for (const v of victims) store.update(second.runId, v.repo, { state: "pending" });
const resumed = await runFleet({ cfg, transform: "bump-dep", args: { pkg: "lodash", to: "^4.17.21" }, selector: "*", dryRun: false, resume: second.runId });
check("resume touches only the unfinished repos", () => assert.equal(resumed.counts.pr_open, 5 + BROKEN));

// --- revert -------------------------------------------------------------------------
const reverted = await revertFleet(cfg, first.runId);
check("revert undoes every merge from the run", () => assert.equal(reverted.reverted, GREEN));
const after = await git(["show", "main:src/index.ts"], join(root, "svc-000-flat.git"));
check("source is back to the pre-migration import", () => assert.match(after, /from "@acme\/utils"/));

await rm(root, { recursive: true, force: true });
await rm(state, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
