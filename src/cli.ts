#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { openStore, revertFleet, runFleet, statusFleet, writeDiffReport } from "./engine.ts";
import { TRANSFORMS } from "./transforms/index.ts";
import type { TransformArgs } from "./transforms/types.ts";
import { fmtDuration } from "./util.ts";

const OWN_FLAGS = new Set([
  "transform", "select", "concurrency", "provider", "owner", "root", "resume", "wait", "out", "help",
]);

const USAGE = `fleet -- apply a code change across a fleet of repositories

  fleet plan   --transform <name> [--select <topic|prefix>] [transform args]
  fleet run    --transform <name> [--select <topic|prefix>] [--resume <runId>] [transform args]
  fleet status <runId> [--wait]
  fleet revert <runId>
  fleet report <runId>
  fleet runs
  fleet transforms

Options
  --select <s>        repo topic (github) or name substring (local); default "*"
  --concurrency <n>   repos in flight at once (default from fleet.config.json)
  --provider <p>      local | github
  --owner <o>         github owner, with --provider github
  --root <path>       directory of bare repos, with --provider local
  --out <path>        dry-run report path (default fleet-plan-<runId>.md)

Transforms
${Object.values(TRANSFORMS).map((t) => `  ${t.name.padEnd(16)} ${t.describe}\n${" ".repeat(18)}requires ${t.requiredArgs.map((a) => `--${a}`).join(" ")}`).join("\n")}
`;

/**
 * `--key value` is a string flag, `--key` followed by another flag is a boolean.
 * node:util parseArgs cannot do this: it needs every option declared up front, and
 * transform arguments are only known to the transform.
 */
function parse(argv: string[]): { values: Record<string, string | boolean>; positionals: string[] } {
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      values[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[key] = next;
      i++;
    } else {
      values[key] = true;
    }
  }
  return { values, positionals };
}

function main(): Promise<void> {
  const { values, positionals } = parse(process.argv.slice(2));
  const command = positionals[0];
  if (!command || values.help) {
    console.log(USAGE);
    return Promise.resolve();
  }

  const overrides: Partial<Config> = {};
  if (values.provider) overrides.provider = String(values.provider) as Config["provider"];
  if (values.owner) overrides.githubOwner = String(values.owner);
  if (values.root) overrides.localRoot = String(values.root);
  if (values.concurrency) overrides.concurrency = Number(values.concurrency);
  const cfg = loadConfig(overrides);

  const transformArgs: TransformArgs = {};
  for (const [k, v] of Object.entries(values)) {
    if (!OWN_FLAGS.has(k) && typeof v === "string") transformArgs[k] = v;
  }

  switch (command) {
    case "plan":
    case "run":
      return doRun(cfg, values, transformArgs, command === "plan");
    case "status":
      return doStatus(cfg, positionals[1], Boolean(values.wait));
    case "revert":
      return doRevert(cfg, positionals[1]);
    case "report":
      return doReport(cfg, positionals[1]);
    case "runs":
      return doRuns(cfg);
    case "transforms":
      console.log(USAGE.slice(USAGE.indexOf("Transforms")));
      return Promise.resolve();
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

async function doRun(cfg: Config, values: Record<string, unknown>, args: TransformArgs, dryRun: boolean): Promise<void> {
  const transform = values.transform ? String(values.transform) : "";
  if (!transform) throw new Error("--transform is required");
  const selector = values.select ? String(values.select) : "*";
  let lastPrint = 0;

  const summary = await runFleet({
    cfg, transform, args, selector, dryRun,
    resume: values.resume ? String(values.resume) : undefined,
    onProgress: (done, total, repo, state) => {
      const now = Date.now();
      if (now - lastPrint < 200 && done !== total) return;
      lastPrint = now;
      process.stdout.write(`\r  ${done}/${total}  ${state.padEnd(9)} ${repo.slice(0, 40).padEnd(40)}`);
    },
  });
  process.stdout.write("\n");

  console.log(`\nrun ${summary.runId}`);
  console.log(`  ${summary.total} repos in ${fmtDuration(summary.elapsedMs)}`);
  printCounts(summary.counts);

  if (dryRun) {
    const out = values.out ? String(values.out) : `fleet-plan-${summary.runId}.md`;
    const rows = openStore(cfg).repos(summary.runId);
    await writeDiffReport(rows, out, summary.runId, summary.elapsedMs);
    console.log(`\n  consolidated diff -> ${out}`);
    console.log(`  nothing was pushed. Re-run with \`run\` to open PRs.`);
  } else {
    console.log(`\n  next: fleet status ${summary.runId} --wait`);
  }
}

async function doStatus(cfg: Config, runId: string | undefined, wait: boolean): Promise<void> {
  if (!runId) throw new Error("usage: fleet status <runId> [--wait]");
  const started = Date.now();
  const s = await statusFleet(cfg, runId, { wait });
  console.log(`status ${runId} (${fmtDuration(Date.now() - started)})`);
  console.log(`  merged ${s.merged}  quarantined ${s.quarantined}  still pending ${s.pending}  errors ${s.errors}`);
  printCounts(openStore(cfg).counts(runId));
  const held = openStore(cfg).repos(runId, ["quarantined"]);
  if (held.length) {
    console.log(`\n  quarantined, held for a human:`);
    for (const r of held) console.log(`    ${r.repo}  ${r.pr_url}`);
  }
}

async function doRevert(cfg: Config, runId: string | undefined): Promise<void> {
  if (!runId) throw new Error("usage: fleet revert <runId>");
  const started = Date.now();
  const r = await revertFleet(cfg, runId);
  console.log(`reverted ${r.reverted} repos in ${fmtDuration(Date.now() - started)} (${r.errors} errors)`);
}

function doReport(cfg: Config, runId: string | undefined): Promise<void> {
  if (!runId) throw new Error("usage: fleet report <runId>");
  const store = openStore(cfg);
  const run = store.getRun(runId);
  if (!run) throw new Error(`no such run: ${runId}`);
  console.log(`${runId}  ${run.transform} ${run.args}  provider=${run.provider}  started ${run.started_at}`);
  printCounts(store.counts(runId));
  console.log("");
  for (const r of store.repos(runId)) {
    const pr = r.pr_number ? `#${r.pr_number}` : "";
    console.log(`  ${r.state.padEnd(12)} ${r.repo.padEnd(28)} ${pr.padEnd(6)} ${r.error ?? r.summary ?? ""}`);
  }
  return Promise.resolve();
}

function doRuns(cfg: Config): Promise<void> {
  const store = openStore(cfg);
  for (const run of store.listRuns()) {
    const counts = store.counts(run.id);
    const tag = run.dry_run ? "[dry-run]" : "";
    console.log(`${run.id}  ${run.transform.padEnd(16)} ${tag.padEnd(10)} ${JSON.stringify(counts)}`);
  }
  return Promise.resolve();
}

function printCounts(counts: Record<string, number>): void {
  const order = ["merged", "pr_open", "quarantined", "skipped", "pending", "reverted", "error"];
  const parts = order.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`);
  console.log(`  ${parts.join("   ") || "no repos"}`);
}

main().catch((err) => {
  console.error(`fleet: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
