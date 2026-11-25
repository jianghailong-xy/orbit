# Query plans for the `session.status` retirement (plan §4.5), on a seeded database

Task T5 of [session-status-retirement-plan.md](session-status-retirement-plan.md), measured 2026-11-25 with
PostgreSQL 16 (`postgres:16-alpine`, default settings). To measure again:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-status-query-plans-seed.sql   # empty throwaway only
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v plans=1 -v writes=1 -f scripts/session-status-query-plans.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v without_old=1 -f scripts/session-status-query-plans.sql   # as after D4
```

The seed: 101,358 sessions, 358 of them held; the busy runner has 44,073, 73 held. **It is not a copy of
production**; the rehearsal (T16) measures that. Numbers are shared buffers (hit and read) of one warm execution.
"Word, D1" is the query on the stored word on a database at migration 1612; "Facts, D2" is its translation after
1622–1634; the last number column is the same with the six indexes on `status` dropped, as D4 leaves it. Planner
choices and buffer counts move a little between runs.

## Indexes built

The six candidates of §4.5, all kept (1627–1633), and one more, `session_released_failed_idx` (1634): without it
`?status=FAILED` on the facts read the whole table (6,121 buffers against 643). Its predicate is
`statusWordFilter('FAILED')`'s (T4), so a change there has to change the index.

## Buffers

| §4.5 | Query | Word, D1 | Facts, D2 | Facts, status indexes gone | Index the facts form used (D2) |
|---|---|---|---|---|---|
| 1 | Run now overflow probe | 3 | 3 | 3 | `session_over_capacity_queued_idx` |
| 1 | claim replay | 5 | 4 | 4 | `session_runner_turn_state_idx` |
| 1 | claim with the runner, batch and tree caps | 132 | 148 | 135 | `session_batch_in_flight_idx` `session_owner_id_idx` `session_parent_session_id_idx` `session_pkey` `session_root_in_flight_idx` `session_runner_turn_state_idx` |
| 1 | claim, caps off (candidate and order) | 67 | 71 | 57 | `session_pkey` `session_root_in_flight_idx` `session_runner_turn_state_idx` |
| 2 | batchActiveTurns | 3 | 2 | 2 | `session_batch_in_flight_idx` |
| 2 | runnerActiveTurns | 3 | 2 | 2 | `session_runner_turn_state_idx` |
| 2 | runnerBackgroundHeldSessions | 37 | 37 | 37 | `session_pkey` |
| 2 | treeActiveTurns | 8 | 7 | 7 | `session_parent_session_id_idx` `session_root_in_flight_idx` |
| 3 | dispatch pause: turns still running | 1,177 | 1,359 | 1,359 | `session_owner_held_task_idx` |
| 3 | dispatch resume: inboxes to wake | 1,198 | 1,380 | 1,380 | `session_owner_held_task_idx` |
| 3 | dispatch resume: runners to hint | 11 | 9 | 3 | `session_runner_turn_state_idx` |
| 3 | draining runner: waiting work | 69 | 64 | 64 | `session_runner_held_idx` |
| 3 | held sessions of one runner (step 4.3 case) | 69 | 10 | 9 | `session_runner_held_idx` |
| 3 | managed sleep: ACTIVE_TURN and QUEUED_TURN | 8 | 4 | 4 | `session_runner_turn_state_idx` |
| 3 | managed sleep: BACKGROUND_WORK | 21 | 15 | 15 | `session_runner_held_idx` |
| 3 | runner link: approvals decided | 87 | 65 | 65 | `session_runner_held_idx` |
| 4 | heartbeat ownership fence | 163 | 158 | 158 | `session_pkey` `session_runner_held_idx` |
| 4 | reclaim set | 69 | 64 | 64 | `session_runner_held_idx` |
| 5 | batch cap re-stamp (task list update) | 1,006 | 1,106 | 1,172 | `session_batch_id_status_idx` `session_runner_held_idx` |
| 5 | live runs of a task list (list delete) | 151 | 99 | 99 | `session_owner_held_task_idx` |
| 5 | live runs of tasks (batch stop, delete, reach) | 108 | 100 | 100 | `session_owner_held_task_idx` |
| 5 | reclaimStalledTask: occupied count | 6 | 6 | 6 | `project_event_session_task_provider_idx` |
| 5 | the task carrier, over 50 tasks | 158 | 111 | 111 | `session_scheduled_wakeup_loop_pending_key` `session_task_execution_claim_idx_finished_at` |
| 6 | slot budget per capped list | 20 | 37 | 54 | `session_runner_turn_state_idx` |
| 6 | slot budget per runner | 19 | 36 | 53 | `session_runner_turn_state_idx` |
| 6 | the reaper's sweep | 80 | 262 | 262 | `session_owner_held_task_idx` |
| 7 | listForOrchestration AWAITING_INPUT | 129 | 132 | 132 | `session_owner_held_task_idx` |
| 7 | listForOrchestration CANCELLED | 5,112 | 6,121 | 6,127 | sequential scan |
| 7 | listForOrchestration FAILED | 643 | 615 | 615 | `session_released_failed_idx` |
| 7 | listForOrchestration INTERRUPTED | 4 | 3 | 3 | `session_runner_turn_state_idx` |
| 7 | listForOrchestration PENDING | 18 | 13 | 13 | `session_owner_held_task_idx` `session_runner_turn_state_idx` |
| 7 | listForOrchestration RUNNING | 9 | 16 | 16 | `session_owner_held_task_idx` `session_root_in_flight_idx` |
| 7 | listForOrchestration SUCCEEDED | 5,787 | 6,121 | 6,127 | sequential scan |

`heartbeat ownership fence` and `runnerBackgroundHeldSessions` enter by id; `reclaimStalledTask` and the carrier by
task. Every facts query with an intended index used one, in both states (the script's "did not use" list is empty).

## Where the facts read more than the word, and was not answered with another index

§4.5 says a plan that reads more buffers than today's stops T5 until an index answers it. These read more and were
left, which is a judgment for review, not something the rule allows by itself:

- **The reaper's sweep (80 to 262), the dispatch pause's two reads (+15%)**: the same 358 held rows, entered through
  an index ordered by owner and task, so the same heap pages are visited again and again. The word's status index
  happens to visit them in heap order. The cost grows with held sessions only.
- **Slot budgets (19–20 to 36–37, 53–54 without the old indexes), listForOrchestration RUNNING (9 to 16), the claim
  with caps (132 to 148)**: tens of buffers, of the same kind.
- **The batch cap re-stamp (1,006 to 1,106–1,172)**: it enters by `session_batch_id_status_idx` while that exists and
  by the held index afterwards; no candidate is keyed on `batch_id` for held rows. It runs when a person changes a
  list's cap.
- **`?status=CANCELLED` and `SUCCEEDED` (5,100–5,800 to 6,121)**: a sequential scan. SUCCEEDED is one today too. Most of
  an owner's released rows are one of the two, and CANCELLED is a negation (§6), so no partial index states it.

## Writes (§4.5 item 8)

2,000 updates of `running_bg_jobs` on 50 held sessions, each run in a rolled-back transaction:

| Database | With `session_zz_phase` | Without it | HOT share |
|---|---|---|---|
| D1 (1612) | 969 ms | 991 ms | 0.000 |
| D2 (1634) | 984 ms | 1,001 ms | 0.001 |

The trigger's cost is inside the noise. The HOT share is about zero in both because the running sets are already
named by index predicates and a bulk-loaded page has no room; this does not establish production's share, before or
after. T16 reads it from `pg_stat_user_tables` on the copy.
