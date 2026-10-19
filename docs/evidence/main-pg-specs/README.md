# PostgreSQL specs on main: 15 red specs, and a job that ran out of its 45 minutes

Evidence for the task [Fix main's CI PostgreSQL specs](orbit-task:34cw1KXAlw0mmehm9r2Rg). Measured on 2026-10-09 in
two places. GitHub Actions: the `postgres` job of `.github/workflows/ci.yml` (ubuntu-latest, 4 cores, Node 26), which
runs `bash scripts/project-pg-matrix.sh` against its own `postgres:16-alpine`. HPC: runner workstation-gpu, the same
script locally (Node 26.10.0) and `scripts/run-pg-spec.sh` for single specs.

## What failed

The job has not finished inside its `timeout-minutes: 45` since the roster passed ~380 specs. Run 37895053362
(main `19c760ae4`, 2026-10-09 06:43Z) is the last one that completed: 42:19, with 3 specs red. Every later run was
cancelled with the sweep still going — 37927950012 (45:16), 37934858352 (45:20), 37931308418, 37929437128.

The red list on the current main (`ab1ef1657`, run 37934858352's PostgreSQL job, every one REPRODUCED on the
script's own second run) is [reds-before.md](reds-before.md): 15 specs, 45 failing cases. Twelve of them are new
since the 06:43Z run, and they and the four below are two different stories.

**Eleven specs, one cause: migration 0414.** `b4daebcb4` (feat(provider-engine): record each session's engine and run
every path on it, 2026-10-09 10:08Z) added `0414_session_engine`, whose `guard_session_engine_acquisition()` drops a
`PENDING -> RUNNING` write in silence, and refuses a lease write outright, for a session that has a recorded engine
unless the same transaction declares `set_config('orbit.claim_reads_session_engine', '1', true)`. That is the
contract `common/session-scheduling.ts` states — the doors declare it (the runner's lease routes,
`QueueService.trySessionClaim`) — and these specs' fixtures claim a session the way the runner does without it.
A silent drop is what the failures look like: Prisma reports `No record was found for an update` for the `update`
form, and the `updateMany` form claims nothing and the case fails later on an `undefined` turn.

**Four specs, four older contract moves.** Each one is a spec pinned to a shape that changed under it, and the
commit that moved the contract is named with it in [reds-before.md](reds-before.md): `steer-dequeue`'s columns-only
fixture (the inbox predicate reads `Session.engine` now), `runner-project-edit-attribution`'s assertion on the Go
call shape (a merge-check change goes through `updateProjectWithApproval` now), `project-integration-inflight` case
(f) (the landing line carries its own `waitMs` now), and `integration-skip-merge-check` case 6 (since `d2904706e` a
failed landing's item is the coordinator's in an Automatic project, so the owner retry door answers only an item
that is the owner's).

**Why the timeout.** The roster is 393 specs. On run 37895053362's roster of 387 they took 2467 s (41.1 min) of
spec time — median 2 s, but `watch-core-qa-forge` alone is 280 s — on top of ~1.5 min of checkout, `npm ci`,
`prisma generate`, provisioning and tsc. A red makes it worse rather than better: a spec that is not clean is run a
SECOND time before it is reported, and the 15 reds of run 37934858352 cost enough of the remaining budget that the
run was killed at 45:20 having reached 348 of the 393 specs — the last 45 (`watch-*` from `watch-evaluator` on,
every `wiki-*`, `workspace-*`) were never run at all. A timeout is not a verdict.

## Fix

- **The fifteen specs.** The eleven claim writes now declare the engine read in the same transaction, as the lease
  routes do; the four pinned shapes are updated to the contract they now describe (and case (f)'s `waitMs` is
  derived from the row's own two instants rather than written as a literal). No case was skipped, deleted or
  allowlisted — the script's own rule is that a skip is red.
- **The job.** `PCC_PG_SHARD=<index>/<count>` in `scripts/project-pg-matrix.sh` takes a share of the roster by its
  own index modulo the count, over the same `ls build/**/*.pg.spec.js | sort` the whole run uses: three shards
  partition the roster by construction, so there is no list to keep honest and a spec added tomorrow needs no edit.
  `.github/workflows/ci.yml` runs three `PostgreSQL specs <i>/3` jobs, each with its own PostgreSQL and its own
  45-minute budget; measured on the probe run below, each shard got 131 of the 393 specs and the three took
  **21:34 / 14:30 / 13:37** of spec time, inside 23:15 / 15:52 / 15:12 of wall clock. The bound is measured too: the
  131 slowest specs of the 387-spec roster this was sized on total 34.5 minutes, so no index partition of it can
  put the budget at risk, and a red costs only its own second run.
- **The check main requires.** `main`'s branch protection requires a check named exactly `PostgreSQL specs`, and a
  matrix job's check run is named after its matrix values (`PostgreSQL specs 1/3`). The split therefore ends in an
  aggregate job that keeps that name, needs all three shards, and fails when any of them did. Editing branch
  protection instead was the other option and is the account owner's to make, not the workflow's.

## The other two options, and why this one

- **A bigger `timeout-minutes`.** The one run that finished took 42:19 of a 45-minute budget, and the 15-red run was
  killed at 45:20 with 45 specs still unrun: the second run of every red spec eats minutes the roster was already
  using up. A larger budget buys a longer red, not a verdict — and it buys it on the branch this job is least able
  to describe, because the sweep that got further still prints no footer when it is killed. Sharding puts the
  longest shard at 23:15 against the same 45-minute budget, which is what "stable inside the limit" has to mean
  when a red costs a second run of its own.
- **Shortening the build.** There is nothing there to buy: on the runner, `Install dependencies` is 17 s, `Generate
  Prisma Client` 4 s, and the matrix's own `tsc -p tsconfig.test.json` was 13 s on run 37934858352 — the pre-spec
  part of the job is ~1.5 minutes end to end, against 41 minutes of spec time. The time is in the specs, and the
  only way to make a third of it take a third of the time is to run the thirds at once.

## After

See [after.md](after.md): the probe run of the fix on a branch, its per-shard wall clock, and the three local
regressions this task was measured against.
