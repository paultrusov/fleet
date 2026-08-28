# Benchmarks

Two fleets, because they answer different questions.

The **local fleet** is 200 real git repositories on disk, with bare repos standing in
for remotes and each repo's own `fleet-ci.sh` standing in for CI. It exists to measure
the engine — worktree isolation, parallel transforms, the state machine — at a size
that would take hours to create on github.com.

The **GitHub fleet** is real private repositories with a real GitHub Actions workflow,
real pull requests, real check runs and real merges. It exists to prove the GitHub
provider actually works, end to end, against the API rather than against a stand-in.

Same engine, same transforms, same state machine. Only `src/providers/` differs.

Hardware: Apple Silicon laptop, Node 25, concurrency 16 (local) and 6 (GitHub).

## Local fleet — 200 repos

Transform: `rewrite-import --from @acme/utils --to @acme/core`.

| step | wall clock |
|---|---|
| generate the fleet (`make-fleet.ts`) | 9.5s |
| `fleet plan` — transform + consolidated diff, nothing pushed | 15.4s |
| `fleet run` — transform, commit, push, open 200 PRs | 17.5s |
| `fleet status` — run CI on 200 PRs, merge the green ones | 17.8s |
| **full migration (`run` + `status`)** | **35.3s** |
| `fleet revert` — undo all 190 merges | 10.1s |

Outcome: **190 merged, 10 quarantined, 0 errors.** The 10 are the ~5% of generated
repos whose own contract test pins the old import path, so the codemod turns them red
and they are held for a human instead of being retried.

Throughput: about 340 repos/minute end to end, on 16 workers.

## GitHub fleet — 47 repos, real Actions

Transform: `migrate-api --fn fetchData --to fetchDataV2 --params url,options`.

| step | wall clock |
|---|---|
| `fleet run` — push branches, open 47 pull requests | 27.5s |
| `fleet status --wait` — poll real check runs, merge on green | 3m 08s |
| **full migration** | **3m 36s** |

Outcome: **47 merged, 0 quarantined, 0 errors.**

A separate 8-repo run of `rewrite-import` on the same fleet exercised the failure path:
**7 merged, 1 quarantined** on a genuine red GitHub Actions run, and `fleet revert`
undid all 7 merges in 3.1s, leaving a revert commit on each repo's default branch.

The GitHub numbers are dominated by CI, not by fleet: a GitHub Actions job takes
20-40s to queue and run, and free-tier concurrency caps how many run at once. `fleet`'s
own share is the 27.5s.

## Why the GitHub fleet is 47 repos and not 200

GitHub's secondary rate limit on content creation stops repository creation at roughly
fifty in a burst:

```
403  You have exceeded a secondary rate limit and have been temporarily
     blocked from content creation.
```

Creating 200 would mean spreading it over hours against an anti-abuse control, which is
not a thing to work around. So the scale measurement is the local fleet and the GitHub
measurement is at the size GitHub allows. `fleet` itself handles the limit correctly —
`src/providers/github.ts` backs off and retries on 403/429 rather than failing the repo.

## Reproducing

```bash
node scripts/make-fleet.ts --count 200 --root ./fleet-remotes
node src/cli.ts run    --transform rewrite-import --from @acme/utils --to @acme/core
node src/cli.ts status <runId>
node src/cli.ts revert <runId>
```

```bash
node scripts/make-github-fleet.ts --owner <you> --count 40
node src/cli.ts run --transform migrate-api --fn fetchData --to fetchDataV2 \
  --params url,options --provider github --owner <you> --select fleet-demo --concurrency 6
node src/cli.ts status <runId> --wait --provider github --owner <you>
node scripts/make-github-fleet.ts --owner <you> --count 40 --delete
```
