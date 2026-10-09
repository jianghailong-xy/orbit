# After the fix

## The probe run: every pg spec, inside the limit, all green

The fix is commit `98f6e1766`, pushed to `probe/pg-specs-shards` and run with the dispatch CI — the same
`.github/workflows/ci.yml` this commit changes:

    git push origin 98f6e1766:refs/heads/probe/pg-specs-shards
    gh workflow run ci.yml -R jianghailong-xy/orbit --ref probe/pg-specs-shards

Run [37942654032](https://github.com/jianghailong-xy/orbit/actions/runs/37942654032), four jobs named
`PostgreSQL specs`:

| job | wall clock | its own summary |
| --- | --- | --- |
| PostgreSQL specs 1/3 | 23m15s (14:14:11–14:37:26Z) | `shard 1/3: 131 of 393 specs` · `tests=1880 pass=1880 fail=0 skipped=0 spec-level-red=0 not-reproduced=0` |
| PostgreSQL specs 2/3 | 15m52s | `shard 2/3: 131 of 393 specs` · `tests=1838 pass=1838 fail=0 skipped=0 spec-level-red=0 not-reproduced=0` |
| PostgreSQL specs 3/3 | 15m12s | `shard 3/3: 131 of 393 specs` · `tests=1176 pass=1176 fail=0 skipped=0 spec-level-red=0 not-reproduced=0` |
| PostgreSQL specs (the required check) | 4s | `needs.postgres-shards.result = success` |

All four concluded `success`; the run's own conclusion is `failure` for the JavaScript job alone, whose "Test web"
red is the pre-existing UTC/landing-row one (task 34cp3FjQRKF6ch5PGvhCa,
[docs/evidence/main-web-tests-utc](../main-web-tests-utc/README.md)) and outside this task's scope.

4894 assertions, 0 failed, 0 skipped, and `not-reproduced=0` — not one spec needed the script's second run, so the
sweep the footer describes is the whole roster and none of it was excused. The pre-spec part of each job (checkout,
`npm ci`, `prisma generate`, provisioning, `tsc`, roster) is ~1.6 minutes; the longest shard's 21:34 of spec time is
the roster's own order, and the bound for any index partition of the 387-spec roster it was sized on is 34.5 minutes.

Reading the shard line is the coverage check: `131 of 393` three times is 393, and the roster is
`ls build/**/*.pg.spec.js | sort` taken in each shard, so the three shares are disjoint and complete by
construction. A shard that covered nothing, or an index outside `1..3`, exits non-zero instead of printing the
zeroes of a clean run (`scripts/project-pg-matrix.sh`).

## What was re-run locally, and what it showed

- **The fifteen red specs**, with `scripts/run-pg-spec.sh` (one throwaway PostgreSQL, one clone per spec): every
  case passes. `task-run-winner-recovery` reports one SKIP there — `a real server restart does not change which
  Session a press answers with` — which is `run-pg-spec.sh`'s own doing: its cluster lives on tmpfs and it
  deliberately supplies no `COORDINATOR_PG_RESTART_COMMAND`, so that case skips and the script (rightly) calls a
  skip red. The matrix supplies the command, and the case runs there: the same spec is 31 tests, 0 skipped in the
  probe run above.
- **The 45 specs the timed-out sweep never reached** (`watch-*` from `watch-evaluator` on, every `wiki-*`,
  `workspace-position-backfill`): 44 clean. The 45th, `wiki-model-queue`, failed once on
  `the interrupted call to have streamed its first chunk within 10 s` at host load 10.5–12.3/24 cpus, and then
  passed **2 of 2** on a re-run; it is also green in run 37895053362 (main `19c760ae4`). Host-shaped, and the
  matrix's own second run is what would have said so there.

## The tree that actually lands, and the one spec that would not stay green

Main gained a pg spec and a service change while this task ran (`task-comment-run.pg.spec`, migration 0416), so the
branch was merged with `origin/main` and the probe repeated on the merge — run
[37946019165](https://github.com/jianghailong-xy/orbit/actions/runs/37946019165) at `5ff76b38a`. Shards 1/3 and 3/3
came back green in 16:48 and 16:26. Shard 2/3 came back red on ONE spec, and reproduced it on its own second run:

    claim-recovery-e2e.pg.spec.js   tests=3 pass=1 fail=2   rc=1; REPRODUCED on a second run (rc=1)
      error: 'timed out waiting for the turn to be settled by the completion that followed it'

That spec is an end-to-end of the Go runner: it compiles `go test -c -tags claimrecoveryfault` INSIDE the test and
spawns that binary per scenario, and the wait it blew is one of five `eventually()` polls. The same wait is what
failed first in run 37945865192, where the script's own second run was CLEAN and its footer called the first
`NOT REPRODUCED … a timeout or a connection, not a failed assertion (host load 1.65 when it ran)`. Weighed against
that: the whole file takes 37 s on an idle 24-core host (2 runs, both green), the shard that reproduced it took
25:36 for the same 131 specs another shard ran in 15:52, and what the wait waits for is a spawned process's
completion. The 90-second fuse was therefore measuring the runner machine as much as the code, so this commit
raises it to 180 s — still a hang detector, and still inside the matrix's 600 s per-spec budget for a red first run
plus its second. The flake itself is not this task's to fix: the supervision path it exercises is `src/runner-go`,
which the task excludes, and it is not new — the spec is green in most runs, including run 37942654032.
