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
