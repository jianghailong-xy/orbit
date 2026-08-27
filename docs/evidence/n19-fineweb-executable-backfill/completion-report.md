# N19 production completion report

Date: 2026-08-27
Target project: `34C0tJjDOprFHYQ38s69w` / raw UUID
`01a02d83-7c58-708c-8d7c-103d15523d70`
Migration: `0187_fineweb_executable_backfill`
Migration SQL SHA-256: `4215b893586d3474804ecd2ed3275c97662f9c1cd7802d3f357ab77601b32211`

## 1. N17 hard gate

N17 task `34EGyHRV7IVhsG10IEJvJ` is DONE after a human PASS. Its immutable evidence revision is
`4Xdd8anZvse3D0kin9KnTQ`, digest
`e853ef0df692c3676ace19d84660c20499882a716dc3d1d854d02bd63f80d8fc`.

The production E2E fixture in that revision is:

```text
task id:              34EI8JSEYE6rwnUt1ShYI
session id:           6KV3R6oU4git6sMRyKgJs1
deployed commit:      3c5c69109d054598f846246dee1bf1228712f390
completionCriterion:  EXECUTABLE
command:              true
expected exit:        0
actual exit:          0
raw output:           <empty, byte length 0>
shell turn:           ANSWERED
derived task status:  DONE
```

The persisted production comment records the exact command, expected and actual exits, empty raw
output, and `推导状态：DONE`. No judgment request or completion-evidence fallback was used. This
proves the migrated declaration has a live execution/exit/status consumer rather than another
silent wait.

## 2. Classes and reviewed command templates

The full shell bodies live in the strict, versioned classifier in
`src/apiserver/prisma/migrations/0187_fineweb_executable_backfill/migration.sql`; the operator
runbook explains each check in `docs/fineweb-executable-backfill.md`. Every class expects exit `0`.

| Class | Rows | Command basis |
| --- | ---: | --- |
| `FINEWEB` | 27,468 | Exact-size Parquet + readable footer/schema + deduplicated manifest fields + status JSON. |
| `WARC` | 27,468 | Existing `warc_inventory.py` must exit 0 and report `齐全，可直接 merge`; manifest/status totals must reconcile. |
| `MERGE` | 27,468 | Published/no-staging paths + status `missing_rate` + read-only four-CF open + deterministic 20-row three-CF/text comparison + nonempty `warc_index`. |
| `VERIFY` (`[校验]`) | 27,468 | Final/no-working Parquet + read-only counts/sizes/SST + 200 readbacks + 20 metadata comparisons + five WARC ranges + guarded reclaim dry-run accounting. |
| Unclassified | 1 | No recognized prefix and no acceptance criteria; left `HUMAN_SIGNOFF`. |

The production classifier inventory returned exactly:

```text
FINEWEB t 27468
MERGE   t 27468
VERIFY  t 27468
WARC    t 27468
NULL    f     1
```

Before preparing the production batch, one row from each class and the only rejected row were
manually compared against the complete acceptance prose, generated dump/shard/size arguments and
command body:

| Public task id | Class | Command SHA-256 | Review |
| --- | --- | --- | --- |
| `34C0yryU7ifyn1ySognH3` | FINEWEB | `50a46a9ef35a9036bb8d0967222e70111bd3afc89b413215426f409ee6c28ae2` | strict title + full prose + `CC-MAIN-2013-20/000_00000` + `2147531358` matched |
| `34C0yv1ItXkRghF0ygdKV` | WARC | `886b0aae5c981c9ca739299abd6ee4b8a59b00089d022ef2cd14640f1907e1a0` | strict title + full prose + inventory arguments matched |
| `34C0yxJEfHiImDzu9KiFU` | MERGE | `a3b8382302034124dddb701443157b8fc8b237f265a456f445e3a5a6d73c55ee` | strict title + full prose + RocksDB/staging/status paths matched |
| `34C0yzH5Sa9gWsVESLTdJ` | VERIFY | `322ff166eda665661e59d44486ff99ea7862906d1c3fa4eb03de17b8fb8d0642` | strict title + full prose + final Parquet/RocksDB/reclaim arguments matched |
| `34C20Kq6I7hiffRx4HWvK` | unclassified | null | `_v+ project0`, null acceptance criteria; rejected without guessing |

The review passed for all five samples before the first production task update.

## 3. Disposable rehearsal

All 187 migrations, including N19, applied to a fresh PostgreSQL 16 tmpfs database (exit 0). A
five-task fixture containing the four production-shaped classes plus one root row produced class
counts `1/1/1/1/unclassified=1`. With batch size 2, forward calls returned `2, 2, 0` rows and a replay
returned 0; all five statuses remained OPEN. Rollback calls returned `2, 2, 0`, after which all five
declarations were again HUMAN_SIGNOFF and all statuses remained OPEN.

The four emitted Bash programs passed `bash -n`; each embedded Python program passed
`python3 -m py_compile` (exit 0).

## 4. Production execution

Schema deployment command and result:

```text
docker cp src/apiserver/prisma/migrations/0187_fineweb_executable_backfill \
  orbit-apiserver:/app/src/apiserver/prisma/migrations/
docker exec orbit-apiserver npm run prisma:deploy -w @orbit/apiserver
exit: 0
raw tail: Applying migration `0187_fineweb_executable_backfill`
          All migrations have been successfully applied.
```

The schema deployment changed no task. The explicit prepare call was:

```sql
SELECT n19_fineweb_executable_prepare(
  '01a02d83-7c58-708c-8d7c-103d15523d70',
  'n19-production-20260827-v1',
  250
);
```

Receipt/batch id: `4d9b150c-2218-41e1-9a8e-104b5ee7e30e`. It froze source 109,873,
candidate 109,872, unclassified 1, the four 27,468 class counts, upper bound
`01a03c52-6444-72a7-9a29-24f814d3a097`, and pre-status `{"OPEN":109873}`.

Each forward call was its own transaction:

```sql
SELECT * FROM n19_fineweb_executable_backfill_step(
  '4d9b150c-2218-41e1-9a8e-104b5ee7e30e'
);
```

Results:

```text
rows:                       109872
committed update batches:   440 (439 x 250, final 122)
zero-row sealing call:      1
sum DB-reported batch time: 161983 ms
min / mean / max batch:     221 / 368.14 / 888 ms
bulk-loop wall time:        248771 ms
receipt prepare-to-finish:  327712 ms
exit:                       0
```

Replaying the finished step returned `rows_migrated=0`, `total_migrated=109872`, `finished=true`.
Replaying prepare with the same key returned the same batch id.

The complete 441-call output is in [production-batches.raw.txt](production-batches.raw.txt), SHA-256
`5248a1ff65e4ebf96523c60f0496955152b545d6efa0dfff0c63bf4218fb88d3`.

## 5. Post-migration validation

Before and after state counts:

| Scope | Before | After |
| --- | --- | --- |
| Target statuses | OPEN 109,873 | OPEN 109,873 |
| Target DONE | 0 | 0 |
| Global DONE | 884 | 884 |
| Target criterion | HUMAN_SIGNOFF 109,873 | EXECUTABLE 109,872; HUMAN_SIGNOFF 1 |

The batch receipt independently persisted identical `pre_status_counts` and `post_status_counts`:
`{"OPEN":109873}`.

A full 109,872-row recomputation joined each stored task to the strict classifier and its ledger
row. Raw output:

```text
audited_rows=109872
non_open=0
non_executable=0
wrong_exit=0
command_mismatch=0
class_mismatch=0
ledger_digest_mismatch=0
```

The post-write class sample query returned all four reviewed tasks as OPEN/EXECUTABLE, expected
exit 0, `command_exact_match=true`, with the same command hashes listed above. Its SQL and raw
output, the status counts, receipt, class counts, unclassified row, replay output and full-audit
output are in [production-validation.raw.txt](production-validation.raw.txt), SHA-256
`93d7548c12671e4991a0f722c36a7ef4412fe0cd581608d8fb85ddd11e8a7f13`.

The complete unclassified list contains exactly one row:

```text
34C20Kq6I7hiffRx4HWvK | _v+ project0 | OPEN | HUMAN_SIGNOFF | command NULL | exit NULL
reason: no recognized title prefix and acceptance_criteria is NULL
```

## 6. Rollback

The production rollback is deliberately not executed after successful validation. To roll back,
call the following in separate transactions until `finished=true`:

```sql
SELECT * FROM n19_fineweb_executable_rollback_step(
  '4d9b150c-2218-41e1-9a8e-104b5ee7e30e'
);
```

Each call restores at most 250 exact prior declarations. It refuses a row if status or installed
declaration has changed since migration (`N19_ROLLBACK_DRIFT`) and never writes status. The
disposable rehearsal proved complete forward rollback and replay.

## 7. Tests versus opening baseline

Command:

```text
env PATH=/opt/node26/bin:/usr/bin:/bin /opt/node26/bin/npm test -w @orbit/apiserver
```

Opening baseline: exit 1, tests 2,770, pass 2,591, fail 2, skipped 177.
Final: exit 1, tests 2,771, pass 2,592, fail 2, skipped 177, duration 64,903.497739 ms.

The same two pre-existing tests failed in both runs:

1. `build/common/public-id-coverage.spec.js` — UUID fields not yet classified.
2. `build/projects/project-acceptance.spec.js` — `evidenceRunId` not classified.

The added N19 static migration test passed. Therefore N19 introduced zero new apiserver failures.
