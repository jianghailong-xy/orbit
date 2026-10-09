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
