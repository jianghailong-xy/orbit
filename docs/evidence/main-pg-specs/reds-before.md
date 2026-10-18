# The red list before the fix

The PostgreSQL job of run 37934858352 (main `ab1ef1657`, 2026-10-09 13:09Z), read from the job's own log. That run
was cancelled at 45:20 having reached 348 of the 393 specs, and it prints one line per spec under which is the tail
of the failing child's own TAP output; every spec below is marked `REPRODUCED on a second run`, which is the matrix
script running it again on its own clone of the template before reporting it. Case counts and names are the ones the
second run failed, cross-checked against the same specs run locally with `scripts/run-pg-spec.sh`.

| spec | failing cases | what it said | since |
| --- | --- | --- | --- |
| `session-request.pg.spec` | 2 | `Invalid prisma.session.update() … No record was found for an update` at `deliver()` — the fixture's claim | `b4daebcb4` (0414) |
| `session-message.pg.spec` | 1 | same, at `claimAndPoll()` | `b4daebcb4` |
| `session-reply-steer.pg.spec` | 2 | same, at `deliver()` | `b4daebcb4` |
| `background-wake-steer-retry.pg.spec` | 2 | same, at `deliver()` | `b4daebcb4` |
| `auto-retry-startup-failure.pg.spec` | 2 | `Cannot read properties of null (reading 'turnId')` — the raw-SQL claim in `claimed()` updated 0 rows | `b4daebcb4` |
| `task-run-winner-recovery.pg.spec` | 2 | `Invalid db.session.update() … No record was found for an update` at `moveTo()` | `b4daebcb4` |
| `task-model-routing-account-switch.pg.spec` | 1 | same, at `startEngine()` (the claim and its lease in one write) | `b4daebcb4` |
| `task-dispatch-refusal-visible.pg.spec` | 2 | same, at `refuseAtResolution()` (locally 2 cases: (a), (b)) | `b4daebcb4` |
| `task-source-refusal-visible.pg.spec` | 4 | same, at `runnerResolvesSource()` (locally 4 cases: (a), (b), (c), and the switched-off-coordinator one) | `b4daebcb4` |
| `project-coordinator-end-to-end.pg.spec` | 1 | same, in the T8 fixture's own claim before the runner reports the turn | `b4daebcb4` |
| `project-exception-todos.pg.spec` | 2 | `the retried turn was handed to the runner` — `undefined`, because `retryCoordinator`'s claim is an `updateMany` and claimed nothing | `b4daebcb4` |
| `steer-dequeue.pg.spec` | 2 (of 25) | `column "engine" does not exist` (42703) from the inbox predicate, against its own columns-only fixture | `b4daebcb4` |
| `runner-project-edit-attribution.pg.spec` | 1 | `the project_update tool does not pass its calling session` — the Go call shape moved behind `updateProjectWithApproval` | `9b5f02d9b` |
| `project-integration-inflight.pg.spec` | 1 ((f)) | `deepStrictEqual`: the line's `inFlight` carries `waitMs`, the spec's projection had not been given it | `befc9694c` |
| `integration-skip-merge-check.pg.spec` | 1 | `this failed landing is not assigned to the account owner. The owner retry door only answers an open owner item…` | `d2904706e` |

Three of these (`runner-project-edit-attribution`, `project-integration-inflight`, `integration-skip-merge-check`) are
also in the red list of run 37895053362 (main `19c760ae4`, 06:43Z): they are older than 0414 and were the task's
original three. The other twelve are new since that run, and eleven of them share one cause — the engine-read
declaration 0414 requires of every writer of `PENDING -> RUNNING` or of a new inbox lease.

## Why they read as failures and not as errors worth investigating

The guard's claim branch returns NULL from a BEFORE UPDATE trigger, which cancels the row's update without raising.
Prisma's `update` then sees 0 rows and reports `P2025 … No record was found for an update`; Prisma's `updateMany`
and a raw `UPDATE` see 0 rows and say nothing at all, which is how two of these arrived as an `undefined` turn
rather than as an error. `common/session-scheduling.ts` states the rule the other way round — "any new writer of
those transitions declares it too, or it fails on every session there is" — and `session-engine-foundation.pg.spec`
(`T2 a claim that does not declare reading the engine is skipped for a session that has one`) holds the product's
own doors to it. What was missing was the same sentence in twelve spec fixtures, which is what the fix adds.
