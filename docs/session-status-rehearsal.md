# Rehearsal of deploys D1, the backfill and D2, and the real-stack walk (task T16)

Task T16 of [session-status-retirement-plan.md](session-status-retirement-plan.md) (§7.2 steps 1–4, §7.3 at D1 and D2),
run 2026-11-25 on HPC with the kit in
[scripts/acceptance/session-status-rehearsal/](../scripts/acceptance/session-status-rehearsal/README.md). Nothing
touched production: one isolated stack (loopback only, Compose project `orbit-link-t16`), and no production row was
read. Every number below is from a runner-hosted job, named by its `bgj_` id; the records are in the job outputs and
in the run's records directory, uploaded with the task's evidence.

**What the copy is.** Not a copy of production. Plan §7.1 asks for the newest nightly backup, which holds people's data
and needs the owner's go; that go is with the coordinator. The copy here is production-shaped by construction:
`scripts/session-status-query-plans-seed.sql` (101,358 sessions over 20 runners, the busy one with 44,073 sessions and
73 held, 40,000 tasks, turns, approvals, presence), plus every row shape the legacy-word projector is pinned over
(`WORD_SHAPES`, 57 shapes, 592 rows: production's measured counts where there are any, 318 B3 rows and 13 `completed`
B1 rows, else three copies, and each released shape filed once in Completed and once in Trash). So the census below
counts the kinds the seed holds; **whether production holds a kind §3.4 does not name is not established here**
(T3's production census, or this kit on a restored backup, answers it).

**Code.** D1 is `1b4e3290a0`, where T2 landed (migrations 1611 and 1612; the code still on the word); D2 is the project
tip `2b433572d1` (every reader on the facts, writers writing both). Images `orbit-link-t16-apiserver:d1`
(`sha256:9cc591ab89ee…`) and `:d2` (`sha256:12c96d49fa3f…`), built from a `git archive` of each commit (bgj_8b094181622e).
The runner is `go build` of the tip's `src/runner-go`; its only engine is the landing-measured kit's fake claude.

## Timeline and timings (run 1)

| Step | What ran | Took | Job |
|---|---|---|---|
| Stack | postgres 16, two apiservers at D1 (a fresh database migrated to 1612), web gateway, link gateway, NATS | 45 s | bgj_9dd60bde2c1d |
| Rewind | both apiservers stopped; `scripts/session-turn-state-phase-down.sql` and 1611/1612's `_prisma_migrations` rows removed: the database as production is before D1 (D1's documented rollback, which ran clean) | <1 s | bgj_9dd60bde2c1d |
| Seed | the plans seed (31 s), the shapes (4 s), `VACUUM (ANALYZE)` | 35 s | bgj_9dd60bde2c1d |
| **D1** | the writer loop on; both D1 apiservers started, `prisma migrate deploy` at boot: 1611 **13 ms**, 1612 (two `VALIDATE`s) **62 ms**; healthy after 2 s and 3 s | 5 s | bgj_4b5fc07535f3 |
| Gate, before the backfill | 1622 of T5's history (`1daa60562d`), the post-backfill gate: **refused**, "101887 session rows have a turn_state or phase that is not derived from their status", with its hint, in 413 ms; nothing added | 0.4 s | bgj_4b5fc07535f3 |
| **Backfill** | `scripts/session-turn-state-backfill.sh` under the writer loop and both D1 replicas: **101,755 rows in 204 batches of 500, 65.5 s**; batch 205 wrote 0 | 65.5 s | bgj_4b5fc07535f3 |
| **D2 hand-over** | apiserver-b stopped and started at D2 code while the D1 apiserver served, a walk pass ran (`wh`) and the writer loop wrote: `prisma migrate deploy` applied 13 migrations in **0.40 s** (1601 12 ms, 1621 5, 1622 11, the seven concurrent index builds 1627–1634 30–60 ms each, 1641 12, 1643 7); healthy after 2 s | 8 s | bgj_9417d0e9dae6 |
| Post-backfill gate | T5's history `1daa60562d` 1622–1626, as `prisma migrate deploy` sends them (the later task's files, not yet on the branch): the gate and three `NOT VALID` CHECKs **382 ms**, dropping 1622's NULL-tolerant CHECK 4 ms, `VALIDATE` agrees / released / phase-not-null **43, 40, 41 ms**, `SET NOT NULL` 5 ms. After: every turn_state/phase CHECK validated, `phase` NOT NULL. Both replicas kept writing under the strict CHECK | 0.8 s | bgj_f8f1abe8fb44 |
| Cutover | the D1 apiserver stopped; the D2 one answers as `apiserver` | — | bgj_67e61767ee63 |

`1601_schedule_run_by_owner` rode with D2 because the D1 commit predates the main merge that brought it; it is not a
session migration.

## Lock waits

The writer loop (`writer-loop.cjs`) wrote as D1 code does, every 100 ms, with no lock timeout, timing every statement:
19,336 event-ingestion updates (p50 5 ms, p99 10 ms) and 3,867 word writes, through D1, the backfill, the D2
hand-over, the post-backfill gate and every walk (only 360 of the word writes changed a row: the session guard
triggers skip a claim or revive written that way, which no server sends; each still took its locks). **Two statements took over 100 ms, 1,006 ms and 1,135 ms, both while the plans
script's write measurement ran** (it disables `session_zz_phase` in a rolled-back transaction, which takes the
table's lock, as its header says; rehearsal only). None waited on a migration, the backfill or the hand-over. The lock
sampler (0.2 s) saw exactly those two waits: the writer's `UPDATE`, `RowExclusiveLock` on `session`, behind the plans
script's `pg_temp.ingest('without session_zz_phase')`. In run 1 the sampler ran only through D1 and the backfill;
run 2 below repeats the database steps with it on throughout.

**Run 2** (bgj_17e4908a0b71): the database steps again on a fresh stack in one job, with the sampler at 0.2 s on from
before D1 to after the post-backfill gate, and no plans script or walk beside them. **The sampler saw no backend
waiting on a lock at any point**: not the writer loop, not either apiserver, not the backfill. A positive control on the
same database right after (`sampler-control.sh`, bgj_741190bd633b) planted a 3 s wait behind an `ACCESS EXCLUSIVE`
lock and the sampler recorded it in 13 samples (longest 2,609 ms), so the zero is a reading, not a silent sampler. The
writer loop's longest statement in run 2 was 240 ms, during the backfill, with no lock wait sampled beside it (p50 5 ms,
p99 11 ms over 868 ingest updates). Run 2's timings, against run 1:

| Step | Run 1 | Run 2 |
|---|---|---|
| 1611 / 1612 | 13 / 62 ms | 14 / 79 ms |
| gate before the backfill (refuses) | 413 ms | 408 ms |
| backfill | 101,755 rows, 204 batches, 65.5 s | 101,753 rows, 204 batches, 65.6 s |
| D2's 13 migrations at apiserver-b's boot | 0.40 s (indexes 30–60 ms each) | 0.41 s (indexes 30–64 ms each) |
| post-backfill gate 1622–1626 (wall clock per file) | 430, 84, 83, 85, 40 ms | 418, 78, 68, 82, 46 ms |
| census after D2 | clean, 378 changed, all §3.4 | clean, 378 changed, all §3.4 |

## Census (plan §7.2 step 2)

`census.cjs` reads every row and asks the server's own functions: `legacySessionStatus` (the projector) for the word
the D2 server sends, the unchanged `deriveSessionRunState` / `deriveSessionState` for runState and sessionState from
each word, `deriveSessionPhase` for `phase`; and the stored `turn_state` against the word's. A changed word must be a
§3.4 kind, named from the facts; a held row's word may not change.

| When | Rows | Word changed | Not a §3.4 kind | Held rows changed | phase off | turn_state off | phase NULL | Job |
|---|---|---|---|---|---|---|---|---|
| D1 in, before the backfill | 101,950 | 375 | **0** | **0** | 0 | 91 (not yet filled) | 101,895 | bgj_4b5fc07535f3 |
| after the backfill | 101,950 | 378 | **0** | **0** | **0** | **0** | **0** | bgj_4b5fc07535f3 |
| after D2 and the post-backfill gate | 102,063 | 378 | **0** | **0** | **0** | **0** | **0** | bgj_f8f1abe8fb44 |
| final (D2 alone, after every walk) | 102,111 | 380 | **0** | **0** | **0** | **0** | **0** | bgj_67e61767ee63 |

The 55 rows that had a `phase` before the backfill are the writer loop's: its writes named the execution columns, so
1611's trigger filled them, which is D1's hand-over behaving as §4.1 says. `scripts/session-turn-state-census.sql` was
run beside each (its counts agree).

The final census by kind (380 rows; every other row, 101,731, keeps all three words):

| Kind (§3.4) | status | runState | end reason | Rows |
|---|---|---|---|---|
| C4/C5 SUCCEEDED, no end | SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | none | 325 |
| C1/C2/C3 FAILED with an end reason | FAILED → CANCELLED | FAILED → ENDED | `completed` 20, `ended` 8, `cancelled` 7, `deleted` 5 | 40 |
| C3 FAILED, `task_done` | FAILED → SUCCEEDED | FAILED → SUCCEEDED | `task_done` | 5 |
| C6 cancel with no reason, not honoured | FAILED → CANCELLED | FAILED → ENDED | none | 5 |
| C7 started, ended while queued, `task_done` | CANCELLED → SUCCEEDED | ENDED → SUCCEEDED | `task_done` | 5 |

sessionState follows as §3.4 says: COMPLETED → DORMANT for C4/C5, FAILED → CANCELLED / DORMANT / COMPLETED for the
FAILED kinds by end reason and filing, DELETED unchanged in Trash. C1 grew by five during the run, each written by
a real reaper: three seeded "held ending" rows released by the D1 reaper before the backfill, and the two walk passes'
S8r runs (below). The per-line table is `census-final.json` (`markdown`).

## Query plans (plan §4.5)

`scripts/session-status-query-plans.sql` (`plans=1 writes=1`) on the copy, after the backfill at D1 (bgj_4b5fc07535f3)
and after D2 and the post-backfill gate (bgj_f8f1abe8fb44). Shared buffers of one warm execution, for the busy runner:

| § | query | word, D1 | facts, D1 | word, D2 | facts, D2 | facts use the intended index (D2) |
|---|---|---|---|---|---|---|
| 1 | Run now overflow probe | 3 | 4680 | 3 | 3 | yes |
| 1 | claim replay | 2 | 5270 | 2 | 1 | yes |
| 1 | claim with the runner, batch and tree caps | 141 | 22037 | 145 | 155 | yes |
| 1 | claim, caps off (candidate and order) | 70 | 5797 | 72 | 73 | yes |
| 2 | batchActiveTurns | 2 | 2613 | 2 | 1 | yes |
| 2 | runnerActiveTurns | 2 | 5270 | 2 | 1 | yes |
| 2 | runnerBackgroundHeldSessions | 38 | 38 | 38 | 38 | yes |
| 2 | treeActiveTurns | 2 | 158 | 2 | 1 | yes |
| 3 | dispatch pause: turns still running | 1220 | 3128 | 1082 | 1189 | yes |
| 3 | dispatch resume: inboxes to wake | 1461 | 3920 | 1201 | 1309 | yes |
| 3 | dispatch resume: runners to hint | 48 | 6275 | 47 | 84 | yes |
| 3 | draining runner: waiting work | 82 | 5269 | 46 | 38 | yes |
| 3 | held sessions of one runner (step 4.3 case) | 82 | 5270 | 46 | 13 | yes |
| 3 | managed sleep: ACTIVE_TURN and QUEUED_TURN | 7 | 11842 | 5 | 3 | yes |
| 3 | managed sleep: BACKGROUND_WORK | 22 | 5584 | 46 | 38 | yes |
| 3 | runner link: approvals decided | 281 | 281 | 47 | 38 | yes |
| 4 | heartbeat ownership fence | 163 | 156 | 163 | 155 | yes |
| 4 | reclaim set | 82 | 5269 | 45 | 38 | yes |
| 5 | batch cap re-stamp (task list update) | 447 | 3304 | 347 | 517 | no index intended |
| 5 | live runs of a task list (list delete) | 200 | 5110 | 105 | 35 | yes |
| 5 | live runs of tasks (batch stop, delete, reach) | 108 | 218 | 109 | 50 | yes |
| 5 | reclaimStalledTask: occupied count | 8 | 8 | 6 | 6 | yes |
| 5 | the task carrier, over 50 tasks | 186 | 108 | 245 | 104 | yes |
| 6 | slot budget per capped list | 161 | 5760 | 126 | 108 | yes |
| 6 | slot budget per runner | 55 | 6284 | 65 | 85 | yes |
| 6 | the reaper's sweep | 161 | 6278 | 166 | 253 | yes |
| 7 | listForOrchestration AWAITING_INPUT | 114 | 6358 | 48 | 72 | yes |
| 7 | listForOrchestration CANCELLED | 5672 | 6358 | 5568 | 6743 | no index intended |
| 7 | listForOrchestration FAILED | 709 | 6358 | 656 | 631 | yes |
| 7 | listForOrchestration INTERRUPTED | 5 | 6284 | 5 | 9 | yes |
| 7 | listForOrchestration PENDING | 50 | 6284 | 36 | 50 | yes |
| 7 | listForOrchestration RUNNING | 15 | 6284 | 3 | 1 | yes |
| 7 | listForOrchestration SUCCEEDED | 6358 | 6358 | 6743 | 6743 | no index intended |

- After D2, **every facts query with an intended index used it** (the script's "did not use" list is empty).
- Before D2 the facts forms read the whole runner (4,680–22,037 buffers): the reason the readers may not move before
  the indexes are in. They ship in the same deploy (1627–1634 run before the readers serve).
- **Twelve facts queries read more buffers than their word form** after D2, and §4.5 says such a plan stops T5 until an
  index answers it. They are the ones T5 left as "a judgment for review" (docs/session-status-query-plans.md), within
  the same ratios: the reaper's sweep (166 → 253), the dispatch pause's two reads (+10%), the claim with caps
  (145 → 155), slot budget per runner (65 → 85), the batch cap re-stamp (347 → 517), `?status=CANCELLED`
  (5,568 → 6,743, a sequential scan as SUCCEEDED's is today), and three T5 did not list, of tens of buffers:
  dispatch resume's runners to hint (47 → 84), claim with caps off (72 → 73), and `listForOrchestration`
  PENDING / INTERRUPTED / AWAITING_INPUT (36 → 50, 5 → 9, 48 → 72). Still a judgment for review, not something the
  rule allows by itself.
- Writes (§4.5 item 8): 2,000 updates of the running sets with and without `session_zz_phase`: 1,000 against 972 ms at
  D1, 1,094 against 1,133 ms at D2, inside the noise as T5 found. HOT share of those runs about 0 on both (0.007, 0.000;
  bulk-loaded pages). The table's own counter since the seed, mostly the backfill, read 0.893 at D1 and 0.814 at D2;
  neither establishes production's share.

## The walk (plan §7.3)

`walk.mjs`: one pass is S1, S3–S10, S11, S12 against the real stack, driven through the owner's API and read back
from the database; `compare.mjs` compares a pass with the first one, every observation (words, `turn_state`, `phase`,
the runner page's slot count, refusals, payload words, the runner's reclaim lines) but times. Passes:

| Pass | Code serving | API through | Result | Job |
|---|---|---|---|---|
| `w1` | D1 on both replicas | the D1 apiserver | the baseline, all scenarios pass | bgj_2ddb4c277d25 |
| `w1r` | D1 on both | D1 | **0 differences** from w1: the walk is deterministic | bgj_38039b8b5258 |
| `wh` | D1, while apiserver-b was replaced by D2 code and migrated | D1 | **0 differences** | bgj_9417d0e9dae6 |
| `w2` | D1 and D2 side by side; runner calls round-robin over both; strict CHECKs validated | the D2 apiserver | **0 differences** | bgj_f8f1abe8fb44 |
| recheck of w1 | — | D2 | all 23 of w1's sessions read through D2: payloads **equal** to what D1 served | bgj_6594d54dc402 |
| `w3b` | D2 alone (after the cutover) | D2 | **0 differences** | bgj_67e61767ee63 |

What each scenario showed, the same in every pass:

- **S1 slots** (`max_concurrent` 2, three turns that hold): two RUNNING/`IN_FLIGHT`, one PENDING/`QUEUED`, the runner
  page counts 2; one finishes, the queued one is claimed (`IN_FLIGHT`), still 2; all parked, 0.
- **S3 Run now** past a full runner (burst 1): the first Run now starts its turn (three running, the page counts 3),
  the second is refused `409 RUN_NOW_REFUSED`: the overflow bound.
- **S4 background job** (a real `bg_run` through the session's MCP): parked with the job, `phase` RUNNING, no slot (0);
  a message while the only slot is taken waits PENDING/`QUEUED` with `phase` RUNNING, then is claimed and takes the
  slot.
- **S5 sub-agent** (`running_subagents` written by statement): `phase` RUNNING, the page still counts 0.
- **S6 runner restart** with sessions RUNNING, PENDING, AWAITING_INPUT and one ABANDONED (writer #1's statement, word
  only at D1, both at D2): the same reclaim lines (all four reclaimed; the running and the queued one start an
  interactive run; the running one's engine recycled, resumable), the abandoned one stays INTERRUPTED/`ABANDONED`.
- **S7 turn-complete**: with a follow-up queued the session stays RUNNING into its second turn (the slot kept); a
  single turn parks; a failed turn on the old protocol releases FAILED.
- **S8 ends**: parked, running and queued ends all release CANCELLED with `ended` (Ended/DORMANT).
- **S9 task run**: the execution claim, a second Run refused `409 TASK_ALREADY_RUNNING`, batch stop releases CANCELLED
  with `cancelled`, the task deletes.
- **S10 dispatch pause**: nothing claimed while paused (PENDING, `waitingOn` HOLD); claimed when it lifts.
- **S11 `?status=`** (`GET /sessions/compact`, what `orbit session list --status` reads): the same sessions under each
  word.
- **S12 payloads**: `status`, `runStatus`, `runState`, `sessionState`, `phase`, `released`, `lastTurnOutcome`,
  `waitingOn`, `endReason` of every walked session equal pass for pass.

**S8r, an end the runner does not honour** (§3.4 C1; its own pass, as it waits out the two-minute cancel grace): a task
run stopped by batch stop while its runner is down, released by the reaper FAILED with `cancelled`, "cancel not
honored". At D1 (`w1-s8r`, bgj_6594d54dc402) its payload reads FAILED / FAILED / FAILED (status, runState,
sessionState); the same row read through D2 reads **CANCELLED / ENDED / CANCELLED**, and an S8r run at D2 alone
(`w3-s8r2`, bgj_91b47d13e743) reads the same, with the stored row (FAILED, `cancelled`, last outcome CANCELLED, "cancel not honored") and every other observation equal to D1's. (A first S8r pass at D2, `w3-s8r`, killed the runner before it had taken the turn, so the stop answered the undelivered turn at once; the scenario now waits for delivery, and `w3-s8r2` is that pass.) That is §3.4's C1 row exactly, the change the owner
accepted (ruling `353V98YS1zSj3ugrGpclE`); no other walked row's word changed.

## What this does not establish

1. **Production's rows.** The census counts the seed's kinds and the fixture's shapes. A kind production holds and
   §3.4 does not name would stop D2, and only a census of production's rows (T3, read-only) or this kit on a restored
   backup (the owner's go) can find it.
2. **Production's timings.** 102,000 rows on HPC's disk; production had 12,201 sessions (2026-11-22) on its own host,
   so its D1, backfill and index builds should be shorter, and its lock waits depend on its own traffic.
3. **Not walked:** S2 (a batch cap and a spawn tree at its ceiling: their queries are measured above and held by T7's
   PG specs, but no batch or tree was driven), S7 on release v1 (`ORBIT_SESSION_RELEASE_V1=on`), S5's Merge hold,
   S11's `session_create --wait` and an import. S5's sub-agent and S6's out-of-memory stop are the statements their
   writers send, not a real sub-agent or managed runner.
4. **Deployed runners.** The runner is the tip's. What an older runner reads is the same payload words (S12, the
   recheck) and the same claims, but no older runner binary was walked.
5. **The web.** The stack served an earlier web image (the walk reads no page); the web was not walked.
6. **The post-backfill gate** is T5's history (`1daa60562d` 1622–1626), the shape the later task restates, not that
   task's own files.

## The census on a restored production backup (task T16b, 2026-11-26): stopped

On the owner's go of 2026-11-26 ("restore on orbit-prod, census and plans only"), SubAgent run
`353zqwTnsHMxAXr5JI1Ge` on orbit-prod restored the newest base backup plus WAL into a throwaway PostgreSQL 16, then ran
the census. **It stopped there: the census found a changed word outside §3.4's kinds.** The backfill, the later
censuses and the plans did not run. Only the counts below left the host (the sanitized bundle is
`1g8tT3nOeoAWe5ycyzGHAS`).

**The copy.** The newest base backup is `20261125T063344Z` (base.tar.gz 18.8 GB). 404 WAL segments (3.7 GB) were copied
out of the archive by `cp`, and the base was streamed in by `cat`, so the archive was never mounted. It was restored onto
a Compose volume of the project `t16b-restore`, in a container with `network_mode: none` (mounts: that volume, and the WAL
copy read-only) and `archive_mode=off`. Extraction took 803 s and redo 228 s. The copy was promoted on timeline 3; its
last transaction was at 2026-11-26 00:44:36Z. It holds **13,156 sessions**. The census ran in the D2 apiserver image,
built from a `git archive` of `232b6252b1`, sharing the copy's empty network namespace.

**Production was already at D2.** Production was redeployed to `eef31bea27` at 00:35:47Z, during the restore. That
deploy applied every D1 and D2 session migration to the live database, so the copy already had them all:

| Migration | ms on production (`_prisma_migrations`) |
|---|---|
| 1601 / 1611 / 1612 | 23 / 135 / 105 |
| 1621 / 1622 | 17 / 86 |
| 1627 / 1628 / 1629 / 1631 / 1632 / 1633 / 1634 (concurrent index builds) | 437 / 895 / 111 / 187 / 164 / 832 / 212 |
| 1641 / 1643 | 43 / 19 |

The backfill has not run there. `phase` is NULL on 13,148 of 13,156 rows and is nullable. `session_turn_state_agrees_unless_null_chk`
and `session_turn_state_released_chk` are not validated. So nothing was applied to the copy, and its census is the
"before the backfill" one.

**The census, before the backfill** (census.cjs exit 1, 2,086 ms; `scripts/session-turn-state-census.sql` beside it):

| rows | word changed | not a §3.4 kind | held rows changed | phase off | turn_state off | phase NULL |
|---|---|---|---|---|---|---|
| 13,156 | 335 | **4** | 0 | 0 | 3 (INTERRUPTED rows with no turn_state) | 13,148 |

The SQL census agrees: turn_state_disagrees 3, phase_null 13,148, phase_disagrees 13,148 (its own count includes the
NULLs), parked_rows 0, released_with_turn 0.

| stored → sent | runState | sessionState | end reason | outcome | kind | filed | §3.4 kind | rows |
|---|---|---|---|---|---|---|---|---|
| SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | COMPLETED → DORMANT | | | CONVERSATION | open | C4/C5 | 291 |
| SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | COMPLETED | | | CONVERSATION | completed | C4/C5 | 27 |
| FAILED → CANCELLED | FAILED → ENDED | FAILED → COMPLETED | `completed` | FAILED | CONVERSATION | completed | C1/C2/C3 | 13 |
| **SUCCEEDED → CANCELLED** | SUCCEEDED → ENDED | COMPLETED | **`completed`** | | CONVERSATION | completed | **not in §3.4** | **4** |

- C4's 318 is the 2026-11-21 count, and C3's 13 `completed` rows are the fixture note's.
- **The four unlisted rows** are SUCCEEDED with end reason `completed` and no last outcome, filed in Completed, not
  imported, not trashed. Their word would read CANCELLED and their runState ENDED. Their sessionState stays COMPLETED,
  because they are filed. §3.4's C4/C5 is SUCCEEDED with no end reason, so this kind is not on the list. The plan says it
  stops D2 until the owner rules on it.
- The other 41 lines (12,821 rows) keep all three words. By stored word: SUCCEEDED 7,543, CANCELLED 3,532, FAILED 991,
  AWAITING_INPUT 751, INTERRUPTED 3, RUNNING 1. Kinds: CONVERSATION and LANDING.

**What was not touched.** No command connected to the live database or mounted the archive. `orbit-postgres` and
`orbit-pgbackup` kept the same container Id, StartedAt and restart count (0) before and after. The newest base backup's
files kept their sizes and mtimes. `wal/` grew 1,040 → 1,047 segments on its own.

**Teardown.** `docker compose -p t16b-restore down -v` removed the container and the volume, and the image and the scratch
dir were removed too. `docker ps -a` and `docker volume ls` filtered on the project's label list nothing, and
`grep t16b` finds no container, volume or image.

**Not run, and why.** These were all skipped under the stop rule: the backfill, the post-backfill and after-D2 censuses,
the plans of §4.5 (word against facts) at D1 and at D2, and the write measurement. No migration was applied to the copy,
because production's deploy had already applied them. bg_run was not available on orbit-prod (`BG_TRANSPORT_UNAVAILABLE`),
so the steps ran as host processes, with no `bgj_` ids. A 4.7 GB docker build cache from the image build is still on
orbit-prod.

## The census, backfill and plans on a restored production backup (task T16c, 2026-11-26): clean

This reruns T16b after the owner accepted its four rows as kind C8 (ruling 2026-11-26), which
`census.cjs` lists from `905dfecfb0`. SubAgent run `3541VByT9o6uZgJGt7z5s` did the work on orbit-prod. Two earlier runs,
`3540wZTtjBSsGtSA5uBuu` and `3541F7IAkvYWnBh5JgYFN`, ended mid-restore and left only a part-extracted volume, which this
run threw away. Only counts and redacted plans left the host. The full plans, with every id replaced, are the attachment
`3541wVU98llbNsYzrqrk0` (`t16c-plans-redacted.txt`).

**The copy.** Base backup `20261125T063344Z`, plus 418 WAL segments (`…B600000066` to `…B800000007`). The base was
streamed in by `cat` and the WAL copied by `cp`, so the archive was never mounted. It was restored onto a volume of the
Compose project `t16c-restore`, in `postgres:16` with `network_mode: none` and `archive_mode=off`. `primary_conninfo` was
deleted with `sed` without being printed, and `pg_hba.conf` was set to trust only. Extraction took 542 s and redo 215 s;
the copy was promoted on timeline 3, last commit 2026-11-26 01:36:07Z. It holds **13,161 sessions**.

- Migration head: `1643_schedule_run_idle_seen_at`, 700 rows. One is unfinished and rolled back:
  `1202_turn_outcome_backfill`, production's own history.
- `phase` is nullable. `session_turn_state_agrees_unless_null_chk` and `session_turn_state_released_chk` are
  `NOT VALID`; the other 24 CHECKs are validated.
- Nothing was applied to the copy before the first census.

**The projector.** The census ran in the deployed apiserver image `41d995c8…`, tagged `e28aae1d68`, in a container
sharing the copy's empty network namespace. That is production's image as of the run, not one built for it.
`eef31bea27..e28aae1d68` holds only two drive-sync commits, with no migration and no projector change.

**The censuses** (`census.cjs`, with `scripts/session-turn-state-census.sql` beside it, whose counts agree):

| When | Rows | Word changed | Not a §3.4 kind | Held rows changed | phase off | turn_state off | phase NULL | exit |
|---|---|---|---|---|---|---|---|---|
| before the backfill | 13,161 | 335 | **0** | **0** | 0 | 3 (not yet filled) | 13,143 | 1 (turn_state only) |
| after the backfill | 13,161 | 335 | **0** | **0** | **0** | **0** | **0** | **0** |

After the backfill the SQL census reads turn_state_disagrees 0, phase_disagrees 0, phase_null 0, parked_rows 0 and
released_with_turn 0. In both runs runState changed on 335 rows and sessionState on 304.

The §3.4 kinds found (the same before and after):

| stored → sent | runState | sessionState | end reason | outcome | filed | §3.4 kind | rows |
|---|---|---|---|---|---|---|---|
| SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | COMPLETED → DORMANT | | | open | C4/C5 | 291 |
| SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | COMPLETED | | | completed | C4/C5 | 27 |
| FAILED → CANCELLED | FAILED → ENDED | FAILED → COMPLETED | `completed` | FAILED | completed | C1/C2/C3 | 13 |
| SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | COMPLETED | `completed` | | completed | C8 | 4 |

- **No kind outside §3.4, and no disagreement.** C8's four rows are T16b's four.
- The other 38 lines (12,826 rows) keep all three words.
- By stored word after the backfill: SUCCEEDED 7,867, CANCELLED 3,536, FAILED 1,004, AWAITING_INPUT 748,
  INTERRUPTED 3 (now `ABANDONED`), RUNNING 3.

**The backfill** (`scripts/session-turn-state-backfill.sh`, on the copy only): **13,143 rows in 27 batches, 35.7 s**;
batch 28 wrote 0. No batch failed, so none hit its 2 s lock timeout. The lock sampler (`sample-locks.sh`, 0.2 s) recorded
**no lock waits**. The copy had no other writer, so this measures the backfill's own cost, not contention with production's
writers.

**The plans** (`scripts/session-status-query-plans.sql`, `plans=1`, after the backfill at D2). Run as written, the script
aborted: no held session has a batch, so `quote_literal(NULL)` made the statement NULL. The plans below come from a copy
with that one target coalesced to the nil uuid. That fix is now in the script (`f7ef402803`). The target is the busy
runner: 5,028 of the 13,161 sessions, 181 of the 754 held. Shared buffers of one warm run:

| § | query | word | facts | facts use the intended index |
|---|---|---|---|---|
| 1 | Run now overflow probe | 2 | 2 | yes |
| 1 | claim replay | 2 | 1 | yes |
| 1 | claim with the runner, batch and tree caps | 7 | 5 | yes |
| 1 | claim, caps off (candidate and order) | 2 | 1 | yes |
| 2 | batchActiveTurns | 2 | 1 | yes |
| 2 | runnerActiveTurns | 2 | 1 | yes |
| 2 | runnerBackgroundHeldSessions | 0 | 0 | yes |
| 2 | treeActiveTurns | 2 | 1 | yes |
| 3 | dispatch pause: turns still running | 2,143 | 259 | **no** (see below) |
| 3 | dispatch resume: inboxes to wake | 2,170 | 490 | **no** (see below) |
| 3 | dispatch resume: runners to hint | 2 | 1 | yes |
| 3 | draining runner: waiting work | 177 | 170 | yes |
| 3 | held sessions of one runner (step 4.3 case) | 180 | 112 | yes |
| 3 | managed sleep: ACTIVE_TURN and QUEUED_TURN | 4 | 2 | yes |
| 3 | managed sleep: BACKGROUND_WORK | 180 | 171 | yes |
| 3 | runner link: approvals decided | 180 | 171 | yes |
| 4 | heartbeat ownership fence | 126 | 119 | yes |
| 4 | reclaim set | 177 | 170 | yes |
| 5 | batch cap re-stamp (task list update) | 2 | 2 | no index intended |
| 5 | live runs of a task list (list delete) | 509 | 175 | yes |
| 5 | live runs of tasks (batch stop, delete, reach) | 110 | 50 | yes |
| 5 | reclaimStalledTask: occupied count | 4 | 4 | yes |
| 5 | the task carrier, over 50 tasks | 213 | 207 | yes |
| 6 | slot budget per capped list | 12 | 10 | yes |
| 6 | slot budget per runner | 29 | 27 | yes |
| 6 | the reaper's sweep | 633 | **649** | yes |
| 7 | listForOrchestration AWAITING_INPUT | 558 | 558 | yes |
| 7 | listForOrchestration CANCELLED | 2,123 | **4,233** (sequential scan) | no index intended |
| 7 | listForOrchestration FAILED | 884 | 801 | yes |
| 7 | listForOrchestration INTERRUPTED | 5 | 4 | yes |
| 7 | listForOrchestration PENDING | 2 | 1 | yes |
| 7 | listForOrchestration RUNNING | 4 | 4 | yes |
| 7 | listForOrchestration SUCCEEDED | 4,233 | 4,233 (sequential scan, both) | no index intended |

- **Two facts queries did not use their intended index:** the dispatch pause's and resume's held-turn reads. On real
  data the planner starts from `conversation_turn_session_id_status_idx` (5 turns in flight) and joins `session` by
  `session_pkey`. That reads 8× and 4× fewer buffers than the word form. It is a cheaper plan than the intended one, not a
  slower one, but the script's "expected: none" list is not empty.
- **Two facts queries read more buffers than their word form:** the reaper's sweep (633 → 649, +2.5%) and
  `?status=CANCELLED` (2,123 → 4,233, a sequential scan like SUCCEEDED's in both forms). Both are among the cases T16's
  copy left as "a judgment for review"; §4.5 asks for that judgment.
- Every other facts query used its intended index and read no more than its word form.

**What was not touched.** No command connected to the live database or mounted the archive. `orbit-postgres` and
`orbit-pgbackup` showed the same container Id, StartedAt and restart count (0) before and after. The base backup's four
files kept their sizes and mtimes.

**Teardown.** `docker compose -p t16c-restore down -v` removed the container and the volume. The pulled `postgres:16`
image and `/var/tmp/t16c-restore` were removed too. `docker ps -a` and `docker volume ls` filtered on the project's label
list nothing; the deployed apiserver image was kept. No credential was printed: the SubAgent counted the matching lines
of `postgresql.auto.conf` (1 before the `sed`, 0 after) and never read the file.

**Not run.** The plans' write and HOT measurement (`writes=1`) and the `without_old` end state were not asked for. The
plans script ran with one target patched, as above. The deployed projector was `e28aae1d68`, not the `eef31bea27` in the
brief: production was redeployed between the brief and the run. bg_run is unavailable on orbit-prod, so these steps have
SubAgent run ids, not `bgj_` ids.

## Production backfill (task T3, 2026-11-26): 0 disagreements

The owner's go was ruling `3540LMFjltauEGgoxMdkP` ("Go, after the real-backup census (T16b) comes back clean"); T16c
above is that clean census. SubAgent run `35425E8L2jF0nOQaM9nOL` ran it on orbit-prod in `/root/orbit`. Its report is
the attachment `3542AFOHOU262xJgbC5GZ` (`t3-report.md`): counts only.

**What ran.** Production had been redeployed since the brief: the checkout and the images were `e28aae1d68`, not
`eef31bea27`. The backfill and SQL census scripts were the ones this branch holds (same blobs). `census.cjs` (which
lists C8) and `sample-locks.sh` came from `905dfecfb0`; the census ran by `docker compose exec` in the running
apiserver. The only intended write was `scripts/session-turn-state-backfill.sh`.

| | before | after |
|---|---|---|
| sessions (SQL census) | 13,167 | 13,167 |
| held rows | 756 (of 13,166, counted a moment earlier) | 757 |
| held with `turn_state` NULL | 753 (AWAITING_INPUT 750, INTERRUPTED 3) | 751, all AWAITING_INPUT (the word gives none) |
| `turn_state_disagrees` | 3 | **0** |
| `phase_disagrees` | 13,141 | **0** |
| `phase_null` | 13,141 | **0** |
| `parked_rows` / `released_with_turn` | 0 / 0 | **0 / 0** |
| projector census: unlisted, held changed, phase off, turn_state off | 0, 0, 0, 3 (exit 1) | **0, 0, 0, 0 (exit 0)** |

**The §3.4 kinds** (projector census, the same before and after; 335 changed words, 304 changed `sessionState`):

| §3.4 kind | rows |
|---|---|
| C1, C2, C3 (`completed`): FAILED with an end reason, counted together | 13 |
| C3 (`task_done`) | 0 |
| C4, C5: SUCCEEDED with no end, counted together | 318 |
| C6 | 0 |
| C7 | 0 |
| C8 | 4 |
| a kind not in §3.4 | **0** |

The other 12,832 rows keep their word. After the backfill by (word, `turn_state`, `phase`): SUCCEEDED/–/IDLE 7,871;
CANCELLED/–/IDLE 3,536; FAILED/–/IDLE 1,003; AWAITING_INPUT/–/IDLE 747; AWAITING_INPUT/–/RUNNING 4;
INTERRUPTED/ABANDONED/IDLE 3; RUNNING/IN_FLIGHT/RUNNING 3.

**Batches and timing.** 02:01:16.773Z to 02:02:10.405Z, 53.6 s, exit 0: 26 batches of 500, one of 141, then one of 0;
**13,141 rows**, no failed batch.

**Lock waits** (`pg_stat_activity`, sampled every 0.2 s; the watchdog would have killed the backfill above 5 s and did
not). Two samples had a waiter. The times are since the waiter's statement began, so they bound the wait from above:

| at | waiter | ms | blocked by |
|---|---|---|---|
| 02:01:26.831Z | autovacuum `VACUUM ANALYZE public.session` (a page lock of `session_search_trgm`) | 1,032 | a backfill UPDATE |
| 02:02:01.830Z | the app's `recap_claimed_at` UPDATE of a session (a transaction lock) | 195 | a backend in COMMIT |

**After.** `https://orbitd.io/api/health` answered `{"status":"ok"}`; `docker compose ps` showed the same containers as
before, all up and healthy. No container was started, stopped, recreated or pulled. One sampler backend outlived its
killed client and was ended with `pg_terminate_backend`. The scratch directory was removed.

**Not established.** C1/C2/C3 and C4/C5 are not split: the facts the census reads give one line for each group. Held
rows moved during the run (live traffic), so before and after counts are two snapshots. The SubAgent saw 73 untracked
files in `/root/orbit` that it did not create and did not examine. bg_run is unavailable there, so the production steps
have the SubAgent run id, not `bgj_` ids.

## Rehearsal of D2 to D3 alone, the rollback and forward again (task T17a, 2026-11-26)

The owner ruled on 2026-11-26 (ask_owner `354KUz2RJ4fvFN7KLwVzQ`): "Rehearse T14 alone, then ask to ship". This run
rehearses deploy D3 (plan §4.1) by itself, on the HPC seeded copy, with a rollback to D2 and a second move forward. Nothing
touched production. The stack was isolated: loopback only, the Compose project `orbit-link-t17a`, and state under
`/mnt/tmp/t17a`. Every number below comes from a runner-hosted job, named by its `bgj_` id. The records and the
T17a variant of the kit are the attachment `354MQXRKsqmwISfIWRbc3` (`t17a-records.tgz`). The kit variant is not on the
branch: this task commits only this file.

**Releases.** D2 is `5a08c866c4`, origin/main at the time and the main commit the T14 branch merged. It holds 1651–1669
and no 1671. Production's deployed commit was not read; the task allows origin/main in its place. D3 is the project head `041d0d7f7a`, which carries T14 and `1671_session_status_from_facts`. The images
`orbit-link-t17a-apiserver:d2` (`sha256:08fd2803…`) and `:d3` (`sha256:5555fa32…`) were built from a `git archive` of
each commit under the HPC heavy-work lock (bgj_4ae9534d55aa). `src/runner-go` and `src/link-gateway` are the same at both
commits. The runner is a `go build` of the head (bgj_c7294f9db694), and its only engine is the fake claude.

**The copy.** A fresh database was migrated by D2 code. With both apiservers stopped, the plans seed and the 57 projector
shapes went in (bgj_45b52e8b139c), so the session triggers filled `turn_state` and `phase` as D2's writers leave them.
The T16 shapes hold no C8 row, so four were added as T16b found them on the restored production backup: stored SUCCEEDED,
`completed`, no outcome, CONVERSATION, filed in Completed (`seed-c8.sql`, copies of seeded rows). That gave 101,954
sessions with every §3.4 kind. C2 and C5 have no fact of their own, so the census counts them with C1/C3 and C4.

**Topology and load.** Two apiserver slots ran on one database, `apiserver` (A) and `apiserver-b` (B). The link gateway
sent the runners' calls to both in turn. Each release change was the upgrade skill's hand-over, done one slot at a time:
B's container was replaced by the new image, which runs `prisma migrate deploy` as it starts, while A's old release
served. A walk then went through B with both releases up. Then A was replaced. Two kinds of load ran throughout:
- **Real API and runner traffic** (`load.mjs`): a second runner (`max_concurrent` 3) and the owner's API, round robin over
  whichever slots were up. Every 1.5 s it made a new session (a claim, a turn completion, a park). It also sent
  follow-ups, ended running and parked sessions (releases), and ran task runs that were batch-stopped (cancels).
  Heartbeats and event reports came from both runners.
- **Statement-level writer loop** (`writer-loop.cjs`, as T16's but writing as the serving release does): event-ingestion
  updates every 100 ms. Its cycle wrote the word and `turn_state` together under D2, and `turn_state` alone under D3.
  No lock timeout was set.
- **Lock sampler** (`sample-locks.sh`, every 0.2 s), from before the first D2 start to the end.

### Timeline and timings

| Step | What ran | Took | Job |
|---|---|---|---|
| Census at D2, before any server | clean (below) | 1.0 s | bgj_3f44c50f85df |
| D2 start | both slots at D2 (no migration pending); the writer loop, the sampler and the load on | 1.9 s, 1.7 s to healthy | bgj_3f44c50f85df |
| **D2 → D3** | B replaced by D3 while A (D2) served: **1671 applied at B's boot in 21 ms** (`_prisma_migrations` 15:17:34.882–.903). B was healthy 3.4 s after start. Walk `h1-mix` ran through B with A at D2. Then A replaced (no migration pending), healthy after 2.1 s | B 5.1 s stop + 3.4 s start; A 4.6 s + 2.1 s | bgj_561dab912f8f |
| **Rollback D3 → D2** | B replaced by the D2 image on the same database. D2's `migrate deploy` said "705 migrations found … No pending migrations to apply": no error and no drift complaint about the 1671 row it does not know. Walk `h2-mix` through B (D2) with A at D3. Then A replaced by D2. **1671's down script was not run**: plan §4.1 and 1671's header say a rollback to D2 code is free | B 6.4 s + 5.7 s; A 5.3 s + 3.4 s | bgj_31b9dcfdb757 |
| **Forward D2 → D3** | the same hand-over again: "706 migrations found … No pending migrations to apply". Walk `h3-mix` through B (D3) with A at D2 | B 4.5 s + 2.2 s; A 4.7 s + 2.9 s | bgj_42a58aaaa66e |
| Load off, summaries, teardown | `docker compose … down`, then no `t17a` container left | — | bgj_2c9da308fab8 |

Each "stop" above includes the old apiserver's graceful exit (`docker stop -t 30`). The web gateway answered 200 after each
replacement of A.

### Lock waits

Lock samples are grouped by window below. "Waiters" counts distinct backends seen waiting, and each wait is the waiter's
statement time when sampled, so it is an upper bound. The full list is in `locks.jsonl`, and the summary is in
bgj_2c9da308fab8.

| Window | Waiters | Longest waits |
|---|---|---|
| D2 alone (15:09:44–15:17:27) | 2 | 204 ms, an app `UPDATE session` behind an app `UPDATE conversation_turn` (row lock) |
| **D2 → D3 hand-over, 1671 included (15:17:27–15:19:11)** | **0** | none: 1671's `DO` block (its `DROP`/`CREATE TRIGGER` take `ACCESS EXCLUSIVE`/`SHARE ROW EXCLUSIVE` on `session`) never showed up as a holder or a waiter |
| D3 alone (15:19:11–15:34:45) | 36 | **22.9 s and 10.3 s: the runner claim (`WITH caller AS …`) waiting for `AccessShareLock` on `pg_toast.pg_toast_25704`, the TOAST table of `runner_presence`, behind an autovacuum truncating it**; the rest ≤ 3.7 s, row locks between app statements |
| Rollback D3 → D2 (15:34:45–15:36:54) | 1 | 723 ms, an app read behind an app `UPDATE session` (row lock) |
| D2 alone after the rollback (15:36:54–15:42:54) | 11 | **18.0 s: the same claim behind the same autovacuum truncation of `runner_presence`'s TOAST**; the rest ≤ 1.5 s |
| Forward D2 → D3 (15:42:54–15:44:42) | 5 | ≤ 55 ms, row locks between app statements |
| D3 alone again (15:44:42–15:47:15) | 1 | 13 ms, an advisory lock of the claim |

- **The long claim waits are not D3's.** They hit D3 and D2 alike, and T14 does not touch `runner_presence`. PostgreSQL
  logged each one as "canceling autovacuum task … while truncating relation pg_toast.pg_toast_25704", which is the usual
  cancel when an autovacuum's truncation blocks a waiter. That cancel came 10–23 s late because the host was starved of I/O
  then: load average 30–58, and its checkpoints took 206–270 s to write 1,900–3,000 buffers. It delays claims on a busy
  host. It is not a change in who gets claimed; the walk's claims, slots and refusals stayed equal.
- **The writer loop.** It wrote 10,160 + 9,300 ingest updates across both runs, with 0 errors. Its p50 was 4 ms in both.
  Its p99 was 64 ms in run 1 (to 15:26:54) and 258 ms in run 2, with a 3.8 s maximum during the I/O stall.
- **The writer's word cycle ran in only two windows, and neither was a hand-over.** It changed rows from 15:09:44 to about
  15:14 (D2: 313 rows) and from 15:27 to about 15:33 (D3 alone, turn_state only: 491 rows, 0 errors). Each reaper released
  the cycled sessions, which sat RUNNING on seeded runners whose turns no runner takes. The first run had no refill. The
  refill added in run 2 used up the parked seeded sessions by 15:33. After those times its writes matched no row. So
  during the three hand-overs the statement-level word cycle wrote nothing. The real D2 and D3 code wrote the whole time
  (the load, below).
- **The load.** 3,158 owner calls: 1,463 answered by D2 and 1,656 by D3, with **0 HTTP errors**. 39 calls reached a
  container while it was being replaced (connection refused) and were sent again to the other slot. The runners' own
  claims, turn completions and reports went through the link gateway to both slots. The latency p99 reached seconds in the
  windows when I/O was starved.

### Censuses

`census.cjs` was run as T16 ran it, once in each release's image, so each release's projector gave the words it sends; the
kit's copy also passes `retry_at` to `deriveSessionPhase` (migration 1667). `facts-word.sql` compares every row's stored
word with the facts' word: the body of 1671's eight-argument `session_legacy_status`, written out, so it runs at either
release. In it, "touched" means the row's newest version was written after xid 49713, the start of the first D3 hand-over.

| When | Projector | Rows | Word changed | Not a §3.4 kind | Held changed | phase off | turn_state off | Stored ≠ facts | of them held | Touched since D3 | touched and ≠ | Job |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D2, before any server (C8 added) | D2 | 101,954 | 379 | **0** | **0** | **0** | **0** | 379 | **0** | — | — | bgj_3f44c50f85df |
| after D2 → D3 | D3 | 102,490 | 383 | **0** | **0** | **0** | **0** | 383 | **0** | 346 | **0** | bgj_561dab912f8f |
| after D2 → D3 | D2 | 102,492 | 383 | **0** | **0** | **0** | **0** | 383 | **0** | 347 | **0** | bgj_561dab912f8f |
| after the rollback | D2 | 103,248 | 383 | **0** | **0** | **0** | **0** | 383 | **0** | 1,194 | **0** | bgj_31b9dcfdb757 |
| after the rollback | D3 | 103,252 | 383 | **0** | **0** | **0** | **0** | 383 | **0** | 1,196 | **0** | bgj_31b9dcfdb757 |
| after forward again | D3 | 103,608 | 383 | **0** | **0** | **0** | **0** | 383 | **0** | 1,569 | **0** | bgj_42a58aaaa66e |
| after forward again | D2 | 103,609 | 383 | **0** | **0** | **0** | **0** | 383 | **0** | 1,571 | **0** | bgj_42a58aaaa66e |

The 383 changed words by kind were the same in every census from D3 on: C4/C5 325, C1/C2/C3 39, C3 (`task_done`) 5,
C6 5, C7 5, C8 4. The jump from 379 to 383 came from four C1 rows that D2's reaper released before the first hand-over,
the `wd2-s8r` run among them. **Both projectors give every row the same words** in each census: the same counts, line for
line.

**The stored word against the facts' word.** Every row written since D3 came in stores the facts' word: 1,569 rows,
D2's own writes after the rollback included. D2 writes both spellings, and 1671's trigger, which stays through the
rollback, overwrites the word with the facts'. The only rows whose stored word differs are the **383 released rows of
the §3.4 kinds that no write has touched since D3**. These are exactly the census's changed words: no held row, and no
row written since. 1671 writes no row by design (its header: "No row is written"), so these rows keep the word D2
stored. Nothing at D3 reads that column, and D2 after a rollback reads the projector, so no payload shows it. **So
"stored word equals the facts' word on every row" holds for every row written since D3, not for these 383.** For it to
hold on every row, those rows would have to be written once (any statement naming one of the trigger's columns). D4
drops the column anyway. The coordinator decides whether that matters.

### The walk (plan §7.3) on each release

These are T16's `walk.mjs` scenarios: S1, S3–S10, S11, S12 and, in its own pass, S8r. They were driven through the
owner's API and read back from the database. Every pass is compared with the D2 baseline `wd2` by T16's `compare.mjs`,
on every observation but time.

| Pass | Releases serving | API through | Against `wd2` | Job |
|---|---|---|---|---|
| `wd2` | D2, D2 | A | the baseline, every scenario passes | bgj_7a6fc4f4d37c |
| `wd2r` | D2, D2 | B | **0 differences** (the walk repeats under this load) | bgj_38a819855db8 |
| `h1-mix` | A D2, B D3 just migrated | B (D3) | **0 differences** | bgj_561dab912f8f |
| `wd3` | D3, D3 | A | 2 differences, both in S7's word trace (below) | bgj_1d6fd344aaea |
| `wd3r` | D3, D3 | A | 1 difference, in S7's word trace | bgj_b8e542ead6eb |
| `wd3r2` | D3, D3 | A | **0 differences** | bgj_b8e542ead6eb |
| `h2-mix` | A D3, B D2 (the rollback) | B (D2) | **0 differences** | bgj_31b9dcfdb757 |
| `wrb` | D2, D2 after the rollback | A | 1 difference, in S10's word trace after the pause lifts | bgj_9f1f9428b4ff |
| `h3-mix` | A D2, B D3 (forward) | B (D3) | 2 differences, both in S7's word trace | bgj_42a58aaaa66e |
| `wf` | D3, D3 after forward | A | **0 differences** | bgj_42a58aaaa66e |
| recheck of `wd2`'s 23 sessions | D3 | A | payloads **equal** to what D2 served | bgj_1d6fd344aaea |
| recheck of `wd2`, `wrb` | D3 after forward | A | payloads **equal** | bgj_42a58aaaa66e |

- **Claims, runner slots and dispatch were the same as D2's in every pass.** The S1 slot counts were 2 full, 2 after one
  finishes and 0 parked. S3: the first Run now started and the second was refused `409 RUN_NOW_REFUSED`. In S4 a session
  parked with a background job holds no slot, and its message waited QUEUED, then was claimed. S5's sub-agent took no slot.
  S6's reclaim and takeover lines after a runner restart were the same, with the ABANDONED session left ABANDONED (written
  at D3 as D3's writer would write it, `turn_state` alone). In S9 the execution claim held, a second Run was refused
  `409 TASK_ALREADY_RUNNING`, and batch stop released CANCELLED. In S10 nothing was claimed while paused: PENDING,
  `waitingOn` HOLD after 10 s, and each pass's prompt was claimed 10.3–48.8 s after its session was made (bgj_2c9da308fab8).
  S11's `?status=` filters gave the same rows. S12's payload words were equal.
- **The trace differences are sampling, not behaviour.** S7 and S10 record the word every 200 ms through `docker exec`
  until the session parks. The passes that differ ran while the host was at load 25–58 (`wd3r` took 252 s against about
  90). There a sample took longer than the turn, so the trace missed a passing RUNNING or the last park. The rows are the
  same in every pass: S7's single turn was answered, its two follow-up turns were answered in order, and each session
  parked IDLE (bgj_5b3d5c61a2eb). S10's turn was answered after the pause lifted (bgj_feb49796ee2f). `wd3r2` and `wf`, run
  at normal load, equal the baseline in full.
- **S8r, an end the runner does not honour** (§3.4 C1), was run once at each release: `wd2-s8r` (bgj_7a6fc4f4d37c),
  `wd3-s8r` (bgj_1d6fd344aaea), and `wrb-s8r` after the rollback (bgj_9f1f9428b4ff). All three serve the same payload,
  CANCELLED / ENDED / CANCELLED (status, runState, sessionState), `cancelled`, last outcome CANCELLED, "cancel not
  honored". They still read the same through D2 at the end (bgj_9f1f9428b4ff). The only difference is the stored word.
  At D2 before D3, D2's reaper stored FAILED. At D3, and at D2 after the rollback, 1671's trigger stored the facts'
  CANCELLED: the reaper at D2 still writes FAILED, and the trigger overwrites it.
- **The legacy words that deployed apps and runners get are unchanged.** The rechecks gave equal payloads, the S12
  payloads matched pass for pass, and the censuses gave the same words through either release's projector. The golden
  `session-payloads-legacy.golden.json` spec was not run here; the census through the projector stands in for it, as the
  task allows.

### What this does not establish

1. **Production's rows and timings.** The copy is the seed and the fixture shapes (C8 added by hand), not a backup.
   1671 took 21 ms here on 102,000 rows on a host under heavy load. Production's time depends on its own traffic, because
   1671 must take its locks between production's statements. The `DO` block's 2 s × 45 tries were never needed here.
2. **The writer loop's word cycle during the hand-overs.** It wrote no row in any of the three hand-overs (above). D2's
   statement shape under 1671's trigger was covered only by real D2 code, in the rollback window and the mixed walks: its
   rows all store the facts' word.
3. **The stored word on the 383 untouched §3.4 rows** (above): unchanged at D3 by design.
4. **Not run:** the plans of §4.5 at D3, D4 (T15), 1671's down script (not needed for the rollback), S2 (batch cap and
   spawn tree), S7 on release v1, S5's Merge hold, S11's `session_create --wait` and imports, the web, and any older
   runner binary. The runner was the head's, which is the same as D2's.
5. **A quiet host.** Load average 25–58 for most of the run, from other work. It shows in the claim delays and in the
   trace samples, not in any outcome.

## Rehearsal of D3 to D4, the rollback and forward again (task T17, 2026-11-27)

This run rehearses deploy D4 (plan §4.1; task T15, migration `1711_session_status_drop`), which drops `session.status`
and `run_status`. It ran on the HPC seeded copy, with a rollback to D3.1 and a second move forward. Nothing touched
production. The stack was isolated: loopback only, the Compose project `orbit-link-t17`, state under `/mnt/tmp/t17`.
The whole run, image builds included, held the HPC heavy-work lock (bgj_318eeffffb3b). Every number below comes from a
runner-hosted job, named by its `bgj_` id. The kit is on the branch (`scripts/acceptance/session-status-rehearsal/`,
commit e736688333, README "D3 to D4"). The records are the attachment `354bXlbo2lvokjEQPjoZO` (`t17-records.tgz`).

**Releases.** All four images were built from a `git archive` of each commit (bgj_318eeffffb3b):

| Side | Commit | What it is | Last migration | Run now gate reads `s.status` |
|---|---|---|---|---|
| d2 | `5a08c866c4` | D2, used only to write the copy | 1669 | yes |
| d3 | `feeb45cf16` | D3, live on production until D3.1 | 1671 | yes |
| d31 | `7474f16158` | D3.1, live on production since 2026-11-27T00:35Z | 1671 | no |
| d4 | `483049739d` | the project head: D3.1 + T15 | 1711 | no |

The last two columns were read from each image (its migrations folder and `dist/sessions/queued-gate.js`;
bgj_4c8d70fbe37b). `src/runner-go` and `src/link-gateway` are the same at D3, D3.1 and D4 (an empty diff, the same job). The runners are a `go build` of the head, and their only engine is the fake claude.

**The copy (step 1).** A fresh database was migrated by D2 code (1669). With both apiservers stopped, the plans seed
(33 s), the 57 projector shapes (592 rows) and the four C8 rows (`seed-c8.sql`) went in, as D2's writers leave them.
The D2-era seed scripts write the word, and at D3 nothing derives `turn_state` from it any more (1671 dropped 1611's
trigger), so they cannot seed a D3 database directly. Both slots were then replaced by D3.1, whose first boot applied
1670 and **1671 (17 ms)**. That left 101,954 sessions with every §3.4 kind, at D3.1, as production is now
(bgj_2ee5136975df).

**Topology and load.** Two apiserver slots ran on one database, `apiserver` (A) and `apiserver-b` (B), and the link
gateway forwarded the runners' calls to both. Each release change was the upgrade skill's hand-over without a gap
(SKILL.md "Without a gap"). `apiserver-next`, from the new release, started beside both serving slots and answered to
`apiserver` too. It applied the migrations as it booted, while the old release served. A, then B, was stopped
(graceful, exit 0 each time, 4.2–4.5 s; the D3 replica 5.6 s) and started again from the new release. Then `-next` stopped. Three kinds of
load ran from step 1 to the end:
- **API and runner load** (`load.mjs`). A second runner (`max_concurrent` 3) claimed through the link gateway. The
  owner's calls went straight to each serving container in turn, every 1.5 s: a new session (a claim, a turn, a park),
  the session lists, follow-ups, ends (releases), the runner list, and task runs that were batch-stopped (cancels). The
  lists were `GET /sessions`, `/sessions/compact`, `?status=AWAITING_INPUT`, `/sessions/listing` and the Completed view,
  each with the Run now gate's read. Every answer was recorded with the release that gave it.
- **Statement-level writer loop** (`writer-loop.cjs`, `WRITER_CODE=d3 WRITER_CYCLE=parked`). Event-ingestion updates ran
  every 100 ms, and the cycle moved `turn_state` between parked and queued. No lock timeout was set. In T16 and T17a the
  reaper released the cycled rows that were left RUNNING, so this cycle never leaves one RUNNING. It changed rows in
  every window below.
- **Lock sampler** (`sample-locks.sh`, every 0.2 s). Its positive control saw the planted 2.8 s wait
  (bgj_2e5a8b729c55).

### Timeline and timings

| Step | What ran | Took | Job |
|---|---|---|---|
| 1. Copy at D3.1 | D2 seed, then both slots to D3.1: 1671 applied at A's boot, B "No pending migrations" | 1671: 17 ms | bgj_2ee5136975df |
| Load on, baseline walks | writer loop, sampler, load; walks `wd31`, `wd31-s8r` (A), `wd31r` (B) | — | bgj_2e5a8b729c55, bgj_19f94c34bf15 |
| **2. D3.1 → D4** | `-next` (D4) started beside A and B (D3.1): **1711 applied at its boot in 69 ms** (`_prisma_migrations` 01:41:42.686–.755). It was healthy 3.9 s after start. Walks `h1-mix` through A (D3.1) and `h1-mix-d4` through `-next` (D4) ran, both after 1711. Then A, then B replaced by D4 (no migration pending), and `-next` stopped | overlap 01:41:45.6–01:45:18.0 (3 min 32 s) | bgj_19f94c34bf15 |
| 3. D4 alone | walks `wd4`, `wd4-s8r` (A); rechecks of `wd31` and `h1-mix` through B; census | — | bgj_f1079d575978 |
| **4. Rollback** | `scripts/session-status-drop-down.sql` while both D4 slots served under load: **the `DO` statement took 15,031 ms**, then 1711's `_prisma_migrations` row was deleted (4 ms). Then `-next` (D3.1) beside the D4 slots ("707 migrations found … No pending migrations"), A and B to D3.1, and `-next` stopped. Walks `wrb`, `wrb-s8r` (A). Then a D3 replica (`feeb45cf16`, answering as `apiserver-b`, so the link gateway sent it runner calls too) ran beside the D3.1 slots: walk `wfeeb` through it, and a recheck of `wd4` | down script 15.0 s; hand-over 01:50:16.7–01:50:38.4 | bgj_2da9550313f7 |
| **5. Forward to D4 again** | `-next` (D4) beside A and B (D3.1): **1711 applied again in 248 ms** (01:56:14.966–15.214), healthy 4.0 s after start. Walk `h2-mix` through A (D3.1) after it. Then A and B to D4, and `-next` stopped. Walk `wf` (A) | overlap 01:56:17.6–01:57:55.1 | bgj_3cf00e58cf21 |
| Load off, records | load, writer and sampler stopped; `windows.mjs` over the windows below | — | bgj_2c9898ca1a05 |
| Teardown | `rehearse.sh down`, then the one slot container `down` left (the kit's `down` now removes it) and the network | — | bgj_7af502ba53d4, bgj_856c97844476 |

### HTTP errors on either release (the hand-overs)

From `load-calls.jsonl`, by the release that answered (bgj_2c9898ca1a05). Status 0 means no connection: a call sent to
a container while it stopped, which the load sent again to the next target.

| Window | Release: calls (session lists) | 5xx | Other HTTP errors | No connection |
|---|---|---|---|---|
| D3.1 alone (01:36:10–01:41:41) | D3.1: 1,235 (788) | **0** | 0 | 0 |
| 1711 at `-next`'s boot (01:41:41.7–45.6) | D3.1: 13 (9) | **0** | 0 | 0 |
| **D3.1 beside D4, column gone (01:41:42.8–01:45:18.0)** | **D3.1: 533 (344)**; D4: 278 (174) | **0** | 0 | D3.1: 16, all while A or B was stopping |
| D4 alone (01:45:18–01:49:57) | D4: 1,055 (676) | **0** | 0 | 6, while `-next` stopped |
| Down script (01:49:57.1–01:50:12.3) | none answered inside it: the calls waited (below) | — | — | — |
| Rollback hand-over (01:50:12–01:50:31) | D3.1: 25 (18); D4: 61 (37) | **0** | 0 | D4: 16, while A or B was stopping |
| D3.1 after the rollback (01:50:31–01:54:30) | D3.1: 924 (590) | **0** | 0 | 6, while `-next` stopped |
| D3.1 beside D3 (01:54:30–01:56:05) | D3.1: 255 (164); D3: 121 (81) | **0** | D3: 20 × 404 on `/sessions/listing` | D3: 8, while it stopped |
| **D3.1 beside D4 after the second 1711 (01:56:15.2–01:57:55.1)** | **D3.1: 254 (156)**; D4: 136 (90) | **0** | 0 | D3.1: 14, while A or B was stopping |
| D4 alone again (01:57:55–02:01:17) | D4: 490 (314) | **0** | 0 | 8, while `-next` stopped |
| **The whole run** | D3.1: 3,233 (2,065); D4: 2,020 (1,291); D3: 122 (81) | **0** | the 20 × 404 above | 75 |

- **D3.1 needs no column.** It answered 787 calls after 1711 had dropped the column (500 of them session lists, each
  with the Run now gate's read), across both forward hand-overs, with no 5xx and no other HTTP error. The walk
  `h1-mix` through D3.1 then equalled the baseline in full (below).
- **The 404s are not the schema's.** `GET /sessions/listing` was added by `2fe3659bdf`, after `feeb45cf16`. D3 has no
  such route, so `listing` matched `GET /sessions/:id`, which answered "session not found". Every other D3 call
  answered 2xx.
- One D3 call ended in a 10 s connect timeout at 01:56:14. It had been sent as that container stopped.
- Answers by release and status over the whole run: D3.1 2,346 × 200, 860 × 201, 36 × no connection; D4 1,438 × 200,
  552 × 201, 30 × no connection; D3 58 × 200, 35 × 201, 20 × 404, 9 × no connection (bgj_4c8d70fbe37b).

### Lock waits

"Waiters" counts distinct backends seen waiting, and each wait is the waiter's statement time when sampled, so it is an
upper bound (bgj_2c9898ca1a05).

| Window | Waiters | Longest waits |
|---|---|---|
| D3.1 alone | 1 | 124 ms, an app read behind an app `UPDATE session` (row lock) |
| **1711 at `-next`'s boot (69 ms)** | **0** | none. No writer-loop statement took over 100 ms in it (bgj_4c8d70fbe37b). 1711 is shorter than one sampler period, so the writer's times are the better measure here |
| D3.1 beside D4 | 2 | 132 ms and 36 ms, the claim's advisory lock behind a claim (`QUEUED to IN_FLIGHT`) |
| D4 alone | 3 | ≤ 38 ms, the same advisory lock, and row locks |
| **Down script (15.0 s)** | **21** | **14.8 s**: app reads (`SELECT … FROM session`, a project open-item read joining it), the writer loop's `UPDATE session` (14,976 ms) and an app `INSERT INTO session` (13.7 s), each waiting for its lock on `session` behind the down script's `DO` block. That block holds ACCESS EXCLUSIVE while it rewrites every row and builds the six indexes |
| Rollback hand-over, D3.1 after it, D3.1 beside D3 | 0 | none |
| **Second 1711 at `-next`'s boot (248 ms)** | **1** | 18 ms, the writer loop's `UPDATE session` behind the migration. Its longest statement there was 156 ms (bgj_4c8d70fbe37b) |
| D3.1 beside D4 after the second 1711 | 2 | 146 ms, the claim's advisory lock |
| D4 alone again | 6 | ≤ 302 ms: row locks, the claim's advisory lock, and 107 ms of a runner claim behind an autovacuum of `runner_presence`'s TOAST (as in T17a) |

- **1711 takes its locks without a queue.** On 102,000 rows it ran in 69 ms the first time and 248 ms the second. It
  held up one writer statement for at most 156 ms. Its `DO` block's 2 s × 45 tries were never needed.
- **The down script stops writers for its whole run.** Every statement on `session` waited until it committed: 15.0 s
  here on 102,549 rows. The API calls that waited answered once it committed (the slowest a `POST /sessions` of
  13.9 s), and none failed. The script's header says "seconds on a table of 100,000 rows". Here that meant 15 s, on a
  host at load average 26–48 with I/O pressure. On production that is a 15 s or longer stop of every session write and
  read while a rollback runs, so it belongs in the rollback's plan.
- **The writer loop.** It ran 13,933 ingest updates (7,117 rows changed), 0 errors, p50 3 ms, p99 24 ms; its maximum,
  14,976 ms, is the down script. The parked cycle ran 2,786 statements (1,290 rows changed), 0 errors, maximum 427 ms.
  It changed rows in every window, both 1711 boots included: 8 rows in each 4 s boot window, 168 and 76 in the
  overlaps. The share of cycle statements that changed a row fell from about 70% to about 40% after the first walks,
  so some of the ten cycled sessions stopped matching (released or claimed). That was not measured further.
- **Slow calls not explained by a lock.** Two `POST /sessions` on D4 alone took 15.8 s (01:58:52) and 12.3 s
  (02:00:32), with no lock wait sampled (bgj_4c8d70fbe37b lists the slowest calls). The host was busy with other work
  toward the end of the run: the 5-minute averages read just after it were load 34 and I/O pressure "full" 18.8%
  (bgj_4c8d70fbe37b). A direct read at 02:01:48, outside a job, showed load 48, and the copy's postgres log showed a
  checkpoint that took 270 s to write 2,934 buffers.

### Censuses

`census.cjs` ran in two releases' images in one exported snapshot (`rehearse.sh census-pair`), so both projectors
counted the very rows. `census-same` then compared every (word, runState, sessionState, end reason, outcome, kind,
import, filing) line between them. Where the column exists, the census compares the stored word with the projector's.
Where it does not, it reports the projector's words and checks `phase` against `deriveSessionPhase`.

| When | Column | Rows | Word changed (§3.4 kinds) | Not a §3.4 kind | Held changed | phase off / NULL | Projectors, line for line | Job |
|---|---|---|---|---|---|---|---|---|
| D2, after the seed | yes | 101,954 | 379 | **0** | **0** | **0** / **0** | (D2 only) | bgj_2ee5136975df |
| D3.1, after 1671 (step 1) | yes | 101,954 | 379 | **0** | **0** | **0** / **0** | D3.1 = D4: **0 of 69 lines differ** | bgj_2ee5136975df |
| after 1711, D3.1 beside D4 | **no** | 102,351 | — | — | — | **0** / **0** | D4 = D3.1: **0 of 67 differ** | bgj_19f94c34bf15 |
| D4 alone (step 3) | no | 102,540 | — | — | — | **0** / **0** | D4 = D3.1: **0 of 67 differ** | bgj_f1079d575978 |
| after the down script, D4 serving | yes, restored | 102,549 | **0** | **0** | **0** | **0** / **0** | D4 = D3.1: **0 of 69 differ** | bgj_2da9550313f7 |
| D3.1 after the rollback | yes | 102,725 | **0** | **0** | **0** | **0** / **0** | D3.1 = D3: **0 of 69 differ** | bgj_2da9550313f7 |
| after forward again (step 5) | no | 102,891 | — | — | — | **0** / **0** | D4 = D3.1: **0 of 68 differ** | bgj_3cf00e58cf21 |

- **The 379 at D3.1** are the released rows of the §3.4 kinds that no write had touched since D2: C4/C5 325, C1/C2/C3 35,
  C3 (`task_done`) 5, C6 5, C7 5, C8 4. 1671 writes no row, so they kept D2's word, as T17a found (383 there).
- **The down script stores the facts' word.** After it, every row's stored word was the projector's (0 changed, 0 NULL,
  `session_aa_status_from_facts` back). The 379 rows came back with the facts' word, as its header says: D2's own words
  are gone with D4.
- The projectors of D3, D3.1 and D4 gave every row the same words in every census, with and without the column.

### The walk (plan §7.3) on each release

These are the kit's `walk.mjs` scenarios: S1, S3–S10, S11, S12 and, in its own pass, S8r. They were driven through the
owner's API at the replica named, and read back from the database through the projector's SQL (`--code d3|d4`). Every
pass was compared with the D3.1 baseline `wd31` by `compare.mjs`, on every observation but time.

| Pass | Releases serving | API through | Against `wd31` | Job |
|---|---|---|---|---|
| `wd31` | D3.1, D3.1 | A | the baseline: every scenario passes | bgj_2e5a8b729c55 |
| `wd31r` | D3.1, D3.1 | B | 1 difference, in S7's word trace | bgj_19f94c34bf15 |
| `h1-mix` | A, B D3.1; `-next` D4, after 1711 | A (D3.1) | **0 differences** | bgj_19f94c34bf15 |
| `h1-mix-d4` | the same | `-next` (D4) | 1 difference, in S10's word trace | bgj_19f94c34bf15 |
| `wd4` | D4, D4 | A | **0 differences** | bgj_f1079d575978 |
| recheck of `wd31`, `h1-mix` | D4 | B | payloads **equal** to what D3.1 served | bgj_f1079d575978 |
| `wrb` | D3.1, D3.1 after the down script | A | **0 differences** | bgj_2da9550313f7 |
| `wfeeb` | A, B D3.1; D3 `feeb45cf16` as `apiserver-b` | D3 | **0 differences** | bgj_2da9550313f7 |
| recheck of `wd4` | D3 | D3 | payloads **equal** to what D4 served | bgj_2da9550313f7 |
| `h2-mix` | A, B D3.1; `-next` D4, after the second 1711 | A (D3.1) | 1 difference, in S10's word trace | bgj_3cf00e58cf21 |
| `wf` | D4, D4 after forward again | A | 1 difference, in S7's word trace | bgj_3cf00e58cf21 |
| `wd4-s8r`, `wrb-s8r` against `wd31-s8r` | D4; D3.1 after the rollback | A | **equal** | bgj_f1079d575978, bgj_2da9550313f7 |

- **Claims, runner slots and dispatch were the same as D3.1's in every pass.** S1's slot counts, S3's first Run now
  started and the second refused, S4's parked session with a background job holding no slot, S5's sub-agent taking none,
  S6's reclaim and takeover after a runner restart, S8's ends, S9's execution claim with a second Run refused and batch
  stop releasing CANCELLED, S10's pause, and S11's `?status=` filters were equal in every pass, through D3.1, D4 and D3,
  before and after 1711. They were equal too while D3.1 and D4 served the same database. In S10 nothing was claimed while
  paused, in every pass: after 10 s the session was PENDING / QUEUED with no open turn (bgj_4c8d70fbe37b). By a direct
  query before teardown (not a `bg_run` job), each pass's prompt was claimed 10.16–10.57 s after its session was made,
  and answered 0.27–0.99 s later.
- **The trace differences are sampling, not behaviour.** S7 and S10 record the word every 200 ms through `docker exec`
  until the session parks. `wd31r` (D3.1 against D3.1) and `wf` missed S7's last park sample. `h1-mix-d4` and `h2-mix`
  sampled S10's PENDING before the claim, which the other passes did not catch. Every other observation of those
  scenarios (rows, slots, payloads, refusals) was equal.
- **S8r, an end the runner does not honour** (§3.4 C1), served the same payload at D3.1, at D4 and at D3.1 after the
  rollback.
- **The legacy wire words are unchanged.** S12's payloads were equal pass for pass. The rechecks gave equal payloads:
  D3.1's sessions read through D4, and D4's sessions through D3. The censuses gave every row the same words through
  three releases' projectors. The golden `session-payloads-legacy.golden.json` spec was not run here; the census
  through the projector stands in for it.

### What this does not establish

1. **Production's rows and timings.** The copy is the plans seed and the projector shapes (C8 added by hand), not a
   backup. 1711 took 69 ms and 248 ms on 102,000 rows on a shared host. On production it takes its locks between
   production's statements. The down script's 15 s is this host's, under load average 26–48. Production's rollback time
   was not measured.
2. **The web gateway's hand-over.** The owner's calls went straight to each container, and the runners' calls through
   the link gateway's names. The web gateway was not pointed at `-next` as the upgrade skill's nginx handover does. The
   web, the native apps and any older runner binary were not run.
3. **Clients.** The criterion speaks of server and client code. This run shows the server side only: D3.1 and D4 serve
   a database without the column, and D3 and D3.1 serve it again after the down script. It shows nothing of the clients'
   own code, beyond the legacy wire words they read being unchanged.
4. **Not run:** the §4.5 plans at D4, S2 (batch cap and spawn tree), S5's Merge hold, S11's `session_create --wait` and
   imports, the golden legacy-payload spec, D2 code after a rollback past D3 (the from-facts down script), and a
   stop-then-start deploy.
5. **The writer loop's cycled sessions.** Its share of statements that changed a row fell from about 70% to about 40%.
   It changed rows in every window, but which of its ten sessions stopped matching was not traced.
6. **Three readings outside a `bg_run` job**, all taken before teardown: S10's claim and answer times, the load average
   of 48 at 02:01:48, and the 270 s checkpoint in the copy's postgres log. Neither the stack nor its database is left
   to read them again.
