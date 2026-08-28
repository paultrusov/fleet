# fleet

Apply one code change across a fleet of repositories, safely: propose, verify, roll out, roll back.

The thing you need when a shared library has to move across two hundred services and
nobody has a week to spend on it.

```bash
# see the whole change before anything leaves the machine
node src/cli.ts plan --transform rewrite-import --from @acme/utils --to @acme/core

# open one PR per repo
node src/cli.ts run  --transform rewrite-import --from @acme/utils --to @acme/core

# poll CI, merge the green ones, quarantine the red ones
node src/cli.ts status run-2026-... --wait

# undo every merge from that run
node src/cli.ts revert run-2026-...
```

## What it does

| | |
|---|---|
| **Discovery** | every repo in a GitHub org/user by topic, or a directory of bare repos |
| **Isolation** | one bare mirror per repo, one throwaway git worktree per (run, repo) |
| **Transforms** | typed AST edits via ts-morph, not regex |
| **Dry run** | one consolidated diff for the whole fleet, in a single markdown file |
| **Rollout** | one PR per repo, auto-merged only on green CI |
| **Failure** | red CI is quarantined for a human, never retried blindly |
| **Resume** | run state in SQLite; a killed run picks up where it stopped |
| **Rollback** | `fleet revert <runId>` reverts every merge the run landed |

## Why an AST and not a regex

The `rewrite-import` transform moves `@acme/utils` to `@acme/core`. Here is a file
from the test fleet:

```ts
import { fetchData } from "@acme/utils";
import { formatDate } from "@acme/utils/date";

const ENDPOINT = "https://example.invalid/@acme/utils/v1";
```

`sed s|@acme/utils|@acme/core|g` rewrites three lines. Two of them are imports and one
is a URL that happens to contain the package name, and rewriting it silently points
200 services at an endpoint that does not exist. fleet rewrites exactly two, because
it asks ts-morph for module specifier nodes rather than for text that looks like one.
The same argument covers package names inside comments, README snippets, test
fixtures and string keys.

## Design notes

**Worktrees, not clones.** A clone per run re-downloads the history every time and
gives every run its own object store. A worktree shares the mirror's objects but has
its own working directory, index and HEAD, so two runs touching one repo cannot see
each other's files. The mirror is keyed by repo name *and* remote URL: names are only
unique within one fleet, and reusing a cache entry across two fleets builds the branch
on the wrong history.

**Resume is not a feature, it is a consequence.** Each repo's outcome is written to
SQLite as it happens and a run only ever picks up repos still in `pending`. Killing a
run mid-flight leaves orphaned worktrees that still hold their branch checked out, and
git refuses to fetch into a checked-out branch, so the resume used to fail on exactly
the repos it existed for. Worktrees under the state directory are disposable by
construction, so a run reclaims them before fetching.

**Quarantine, not retry.** A red test on a codemod means the codemod was wrong for
that repo. Retrying produces the same red twice and buries the signal. Failures are
listed with their PR links and left for a human.

**A cap on blast radius.** Nothing is pushed without an explicit `run`; `plan` is the
default way to look at a change. Every PR body carries the run id and the exact
transform invocation, and one command reverts the whole run.

## Transforms

| transform | what it does |
|---|---|
| `rewrite-import` | move imports/exports/dynamic imports from one package to another, subpaths included |
| `migrate-api` | positional args to an options object, plus a rename: `fetchData(url, opts)` → `fetchDataV2({ url, options })` |
| `bump-dep` | bump a dependency in `package.json` and keep `package-lock.json` consistent |

All three are idempotent: a second run reports no change.

Adding one is a file in `src/transforms/` exporting `{ name, describe, requiredArgs, apply(dir, args) }`
and a line in `src/transforms/index.ts`.

## The test fleet

`scripts/make-fleet.ts` generates a fleet of synthetic services: three project shapes,
five dependency versions, some with a lockfile and some without, and 5% whose own
contract test pins the old API so the codemod turns them red and the quarantine path
is actually used. These are generated repos, not production services — see
[BENCHMARKS.md](BENCHMARKS.md) for what was measured against what.

```bash
node scripts/make-fleet.ts --count 200 --root ./fleet-remotes            # local bare repos
node scripts/make-github-fleet.ts --owner <you> --count 200              # real private GitHub repos + Actions
node scripts/make-github-fleet.ts --owner <you> --count 200 --delete     # clean up
```

## Running it

Node 22.6+ (25 recommended: TypeScript runs directly, `node:sqlite` is built in).

```bash
npm install        # one dependency: ts-morph
npm test           # self-test: transforms, resume, quarantine, revert
```

Configuration is `fleet.config.json`, overridable per command with `--provider`,
`--owner`, `--root` and `--concurrency`.
