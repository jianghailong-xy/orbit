# Project Coordinator 04R4 independent validation

Date: 2026-08-20

## Verdict

**PASS.** I independently validated
`d4392b2831a85c2e3e3f40f80e39d526f4a85965` from a new worktree rooted
exactly at that commit. I found no P0 or P1 blocker in the 0113 guard, the
0114 statement-by-statement deployment window, or the 0115 selective repair.
The only candidate changes produced by this review are this report and two
counterexample tests. Product code, Prisma schema, released migrations, the
authoritative contract, and the PAC were not changed.

## Independent scope and source audit

Before testing I read the project goal, all 12 acceptance criteria and project
instructions; the complete descriptions and comments for original 03/04, 03A,
04R, 03B, 04R2, 03C, 04R3, and 03D; the 04R3 validation and 03D repair reports;
the PAC; the relevant normative sections of the coordinator contract; and the
complete `722f2aaf..d4392b28` diff. I treated 03D's claims only as hypotheses.

The diff contains only:

- new `0113_project_coordinator_identity_source_guard`;
- unchanged historical 0114 plus new
  `0115_project_coordinator_identity_window_repair`;
- 04R3 adversarial tests and the 03D repair report.

The 0114 file and its recorded Prisma checksum both remained:

`5af4ce30951ca5465c2d632e640c22e28e4f90bd66651bd833ee05bc94a117cc`.

## P1-04R3-01 reconstructed through the real executor

The test fixture creates an actual Prisma migrations directory, deploys through
`prisma migrate deploy`, injects a pause inside 0114 after its backfill and
before function replacement, and observes the executor in `pg_stat_activity`.
This is not a transaction model or a hand-applied approximation.

During that window an 0110-shaped writer fails with SQLSTATE `ORB02`. The
failed insert leaves exactly zero Project, project_runtime, and project_member
rows. After 0115 commits, the same write is retryable; relocation A → B
converges to:

| landing | coordinator member | source | identity baseline |
| --- | --- | --- | --- |
| B | B | DERIVED | B |

An additional review-only counterexample kills the detached Prisma executor
process group while 0114 is sleeping. Both temporary guard triggers survive
because 0113 committed earlier. A retry still returns `ORB02` and still leaves
0/0/0 Project/runtime/member rows. This demonstrates durable fail-closed
behavior after a real interrupted deployment, not merely while the executor is
alive.

## 0115 adoption boundary

The review-only four-row matrix independently proves that 0115:

- adopts only `DERIVED + no baseline + coordinator member == landing`;
- does not demote an `EXPLICIT` choice even when it equals the landing;
- does not adopt a DERIVED/no-baseline row whose member differs from landing;
- leaves an already-promoted, byte-indistinguishable historical window row
  `EXPLICIT` with a null baseline, preserving the documented manual-recovery
  boundary.

After relocation, the adopted row reaches B/B/DERIVED/B, the explicit equal
choice remains B/A/EXPLICIT/null, and the ambiguous old-writer C choice is
promoted by the permanent 0114 predicate to B/C/EXPLICIT/null. There is no
silent downgrade of legitimate EXPLICIT state.

For an already-applied 0114 database, Prisma recognized the lexically earlier
0113 guard and later 0115 as pending and applied both without rewriting 0114's
history. After 0115, the two temporary migration guards are absent and exactly
one permanent `project_coordinator_identity_window_repair` trigger remains;
the temporary guard function is absent.

## Positive database matrix

The eight canonical PostgreSQL files plus the two new counterexamples passed:

```text
node --test --test-concurrency=1
  build/projects/coordinator-identity-migration.pg.spec.js
  build/projects/coordinator-identity-service.pg.spec.js
  build/projects/coordinator-companions.pg.spec.js
  build/projects/coordinator-service-linearization.pg.spec.js
  build/projects/coordinator-final-row.pg.spec.js
  build/projects/coordinator-04r-adversarial.pg.spec.js
  build/projects/coordinator-identity-provenance.pg.spec.js
  build/projects/coordinator-04r3-adversarial.pg.spec.js

tests 75; pass 75; fail 0; skipped 0
```

The final exact 04R3 file was also rerun alone: 12/12 passed. Together these
cover the steady provenance matrix, DERIVED A → B, EXPLICIT C absorption,
explicit clear/reselect, old-binary relocation, session-only rotation,
duplicate and out-of-order events, both concurrency orderings, soft-delete and
swap failure races, 0110 writers, unique/FK/tenant constraints, the guarded
automation default, and the original 04/04R/04R2 defect gates.

## Reverse causal controls

The controls fail in the required direction:

| Control | Result | Causal signal |
| --- | --- | --- |
| `COORDINATOR_PG_REVERSE_0114=1`, final 04R3 suite | 12 tests: 4 pass, 8 fail | old 0113 logic rewrites EXPLICIT WHO and fails to advance the DERIVED baseline |
| `COORDINATOR_PG_REVERSE_0114=1`, provenance + final-row | 27 tests: 17 pass, 10 fail | provenance/absorption regression |
| `COORDINATOR_PG_REVERSE_0113=1`, final-row | 16 tests: 6 pass, 10 fail | final-row reconciliation regression |

The real-executor interruption and compatibility tests remain green under the
0114 reverse flag because they deploy migration files in independent schemas;
the eight semantic matrix failures are therefore specific to replacing the
serving function, not generic fixture breakage.

## Empty database and real 0110 snapshot

An empty `pcc04r4_verify` database deployed 130 migrations through 0115.

The read-only source dump was:

`/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump`

Its SHA-256 was identical before and after restoration:

`f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8`

It was restored only into `pcc04r4_snapshot` in the task-owned container and
then rolled forward from 124 migrations (maximum
`0110_task_run_at`) to 130/0115.

| Measure | Before | After |
| --- | ---: | ---: |
| projects | 3 | 3 |
| tasks | 56,246 | 56,246 |
| sessions | 3,608 | 3,608 |
| workspaces | 18 | 18 |
| project_runtime | absent | 3 |
| project_member | absent | 3 |
| temporary guard triggers | n/a | 0 |
| permanent repair trigger | n/a | 1 |

All three projects received MANUAL/automation=false defaults, generation zero,
one DERIVED coordinator member matching the landing, and both session and
identity baselines. Separate committed transactions then reproduced:

```text
derived_probe|B|B|DERIVED|B
explicit_probe|A|C|EXPLICIT|null
```

This covers the real 0110 snapshot forward path without mutating the dump.

## Contract, API, runner, and schema evidence

- authoritative coordinator contract: 58/58 passed;
- Base62/public-ID/API coverage: 162/162 passed;
- targeted runner-go suite: `ok orbit 0.146s`;
- full non-database suite: 1,835 tests, 1,690 pass, 1 fail, 144 skipped;
- `prisma validate`: passed;
- Prisma schema-to-database diff: no coordinator, project_member, or
  project_runtime drift;
- test TypeScript compile: exactly 29 pre-existing runner-api TS2554 errors and
  no error in the changed review test.

The sole non-database failure is the pre-existing
`reorderRunners runsAsRoot select` expectation: actual includes
`runsAsRoot: true` while the expectation omits it. Both runner service and its
spec are byte-identical across `722f2aaf..d4392b28`, so this is not introduced
by the candidate.

The database suites also cover mixed-version and forward-schema rollback,
closed enum/default/non-FK baseline shape, Base62/API boundaries, unique/FK and
tenant isolation, old-binary relocation and session rotation, and guarded-auto
behavior.

## Isolation and preserved execution failures

All database work used only:

```text
container: pcc04r4-pg-34ae0ntf-20260820
image: postgres:16-alpine
host endpoint: 127.0.0.1:32787
role: pcc04r4_admin
databases: pcc04r4_verify, pcc04r4_snapshot
system_identifier: 7675961906822283299
PostgreSQL: 16.14
```

No connection, exec, migration, or test targeted shared
`orbit-postgres/orbit`. Historical 04/04R/04R2/04R3 sessions were read only;
no session lifecycle command was issued.

After collecting the evidence, I removed the exact task container, its tmpfs
databases, two failed-fixture Prisma directories, and the review worktree's
dependency/build overlay. Final `docker ps -a --filter name=pcc04r4`,
`docker volume ls --filter name=pcc04r4`, and the task-prefix `/tmp` scan were
all empty.

Real execution mistakes/failures were retained and explained rather than
erased:

1. The first 73-test attempt preceded the empty deploy and failed three fixture
   cleanups because `public.project` did not yet exist. Deploying the empty
   database and rerunning yielded the canonical green result.
2. The first interruption-test implementation terminated only a backend. Its
   uncaught connection termination failed that test and temporarily left the
   next Prisma advisory lock waiting (10 pass, 2 fail). Stopping the detached
   executor process group made interruption deterministic; no product change
   was made.
3. The first public-only dump restore stopped because `gin_trgm_ops` was
   absent. Recreating only the task snapshot database with `pg_trgm` in
   `public` allowed the same dump to restore successfully.
4. An early probe placed several psql statements in one transaction, so a
   mid-command SELECT observed pre-deferred-trigger state. Repeating it as
   separate committed transactions produced the final states shown above.

These are harness/procedure corrections with their original failures
preserved; none is a candidate P0/P1.

## Conclusion

The 0113 guard closes the real Prisma executor's cross-statement window,
remains persistently fail-closed if 0114 is interrupted, and leaves no partial
Project or companion state. 0115 safely adopts only provable derivations,
protects legitimate EXPLICIT choices, exposes the irreducible historical
manual-recovery boundary, removes the temporary guards, and leaves one
permanent repair trigger. The candidate satisfies this independent 04R4 gate.
