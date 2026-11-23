# Session three-state redesign: read-site inventory

Appendix to [session-three-state-design.md](session-three-state-design.md). Read at commit
`a1282659a4`. Paths are relative to `src/`; `../` is the repository root. Test files are out of
scope and counted only in the design document. The codes are defined in §6.1 of the design
document. Line numbers are every line in the file that matched the session-state vocabulary
plus the sites the readers added by hand; comment lines are included.

Plan step 4.3 (raw SQL in TypeScript files) moved every raw statement that spelled the held or the released
set onto the release column through `sessionHeldSql` / `sessionReleasedSql` in `apiserver/src/common/session-release.ts`
(and `sessionHeldIndexedSql`, which states the held statuses beside it where `session_assigned_runner_id_status_idx` is
the access path: runner link hints, drain waiting, managed runner sleep). Left on purpose: `queue/` (the claim, slot counts
and dispatch-pause's `heldSql`, which step 4.5 removes), `common/session-tree-sql.ts` (slot counts and the
background-held set), `sessions/task-work-carrier.ts` (activity and the parked status, no terminal value), the
claimed-and-held set in `runner-api/runner-link-hints.ts`, `watches/watch-evaluator.service.ts` (reads the status for
the projector), and the work readers' reads of `FAILED` or `SUCCEEDED` as against the other terminal values
(step 4.6: the verified run in `tasks/verification-dependency.ts`, the routing report). The coordinator's "FAILED
with a retry armed" in `projects/project-open-item.ts` reads the release module's failure question (`releaseWasFailureSql`,
removal step R4).

## A. Database objects live at HEAD

Confirmed against the catalog of a Postgres 16 database with every migration applied (plan
step 0.4, 2026-11-19, at `ae4d62ebd0`): `../scripts/session-status-db-objects.sql` lists the
same 16 objects and nothing else. No CHECK constraint, view or generated column reads the
status or `end_reason`; the only partial index that does is the claim index. The triggers
`session_request_asker_stopped` (function in 0352:63) and
`task_owner_confirmation_review_reviewer_ended` read the status in their WHEN clauses only;
their functions do not. Line numbers stay at `a1282659a4`.

Plan step 4.4 (migrations 1421 to 1425) moved the six guards, the revive exemption of the three
acquisition guards and the three ended-triggers onto `finished_at`, and added `finished_at` to
the column lists of the five triggers that decide from it. What still names the status there: the
acquisition and claim guards' `PENDING` to `RUNNING` (activity, `SAME`); the ended-triggers'
`INTERRUPTED` and `AWAITING_INPUT` branches (held statuses read as turn and retry facts); and
`session_request_recipient_ended`'s `NEW."status"::text`, which writes `close_reason` as
`STATUS[:end_reason]` unchanged, for display. Where an ended-trigger told a FAILED release apart, it
read `release_cause` against the failure causes until removal step R4 (design §12.6) restated the three
clauses, in 1425 itself (not deployed), on the release module's failure question
(`releaseWasFailureSql('NEW')`: `finished_at`, `end_reason`, `last_turn_outcome`, and the status bridge
until R7, whose migration 1442 re-creates them without it in deploy 3), with `last_turn_outcome` added to their
column lists. The unique index is step 4.5's.

Plan step 4.5, release A (migration 1426) built `session_task_execution_claim_idx_finished_at` on
`session(task_id) WHERE task_id IS NOT NULL AND deleted_at IS NULL AND finished_at IS NULL` beside
0130's index, which stays until release B. No statement has stated the claim in `ON CONFLICT ... WHERE`
since `2133b988ed`: the claim is stated by the index name the P2002 classifiers match
(`tasks/task-supersession.ts`, `tasks/tasks.service.ts`; both names now), and by the readers whose access
path is the index (`sessions/task-work-carrier.ts` `sessionCarriesTaskSql`, the holder reads in
`sessions/sessions.service.ts` and `tasks/tasks.service.ts`), which state `finished_at IS NULL` since.
`queue/dispatch-pause.service.ts` reads `sessionHeldIndexedSql`, and `heldSql` is gone. Proven in
`apiserver/src/sessions/session-claim-index.pg.spec.ts`; the production pre-check is
`../scripts/session-claim-index-precheck.sql`.

Plan step 4.5, release B (migration 1444) drops 0130's `session_task_execution_claim_idx` CONCURRENTLY, and
1426's index is the claim from then on. No product code changes with it. The sites that still name the old
index are below, with what each does after the drop:
- `tasks/task-supersession.ts` `LEGACY_EXECUTION_CLAIM_INDEX` and `namesExecutionClaimIndex`. The classifiers
  of `isExecutionClaimConflict` (`sessions/sessions.service.ts` resume) and `isTaskRunClaimConflict`
  (`tasks/tasks.service.ts`) match either name by substring. The new name begins with the old one, so they
  match it as before. The old name is never reported again.
- Comments only, describing the claim by the old name:
  - `projects/live-session-status.ts`, `sessions/sessions.service.ts`, `tasks/tasks.service.ts`;
  - web `lib/taskRunHandoff.ts`, macOS `App/TaskRunHandoff.swift`.
- Specs:
  - `tasks/project-budget-idle-session` matches a refusal by substring, which the new name still meets.
  - `tasks/task-run-winner-recovery.pg.spec` pins the index name a real server reports, which is 1426's since
    1444. The unit fixtures it holds to that pin (`tasks/task-run-winner-recovery.spec`,
    `sessions/resume-lost-execution-claim`) carry the new name too.
- `../scripts/session-claim-index-precheck.sql`, the pre-check for deploy 2, reads the old index by
  `::regclass` and errors once it is gone. Its successor is `../scripts/session-claim-index-drop-precheck.sql`.
- Release A's spec puts 0130's index back before it re-runs 1426.

The rehearsal before and after the drop is `apiserver/src/sessions/session-claim-index-release-b.pg.spec.ts`.

| Object defined in | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `apiserver/prisma/migrations/0035_add_parked_run_status/migration.sql` | 7 | R | WIRE | RENAME | Enum type run_status: PENDING, RUNNING, SUCCEEDED, FAILED, CANCELLED, AWAITING_INPUT, INTERRUPTED, PARKED (dead label). Only session.status uses it; default PENDING. Labels cannot be dropped. |
| `apiserver/prisma/migrations/0130_task_supersession_dispatch_guard/migration.sql` | 610 | R | REL | MOVE | Partial UNIQUE index session_task_execution_claim_idx on session(task_id) WHERE not deleted and status IN (PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED): one live run per task; terminal status frees the claim. |
| `apiserver/prisma/migrations/0130_task_supersession_dispatch_guard/migration.sql` | 110, 225, 241 | R | REL | MOVE | Function session_superseded_task_guard plus INSERT and UPDATE OF status triggers on session: a row entering PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED on a retired task is refused; live-to-live moves skip. |
| `apiserver/prisma/migrations/0130_task_supersession_dispatch_guard/migration.sql` | 270, 321, 344 | R | REL | MOVE | Function task_supersession_live_session_guard, trigger on task: refuses retiring a task while a work session in PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED exists on it or on its check. |
| `apiserver/prisma/migrations/0130_task_supersession_dispatch_guard/migration.sql` | 646 | R | REL | MOVE | Function session_project_capacity_serialize (triggers in 0122:228,231): locks the project row when a session enters or leaves PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED; serializes capacity counts. |
| `apiserver/prisma/migrations/0134_task_aggregate_parent_dispatch_guard/migration.sql` | 209, 351 | R | REL | MOVE | Function session_admission_lock_order (triggers 0130:779, 0134:351): takes task locks in order when a session enters or leaves PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED; checks aggregate-parent admission. |
| `apiserver/prisma/migrations/0134_task_aggregate_parent_dispatch_guard/migration.sql` | 420, 668, 793 | R | REL | MOVE | Function task_aggregate_parent_shape_guard, trigger on task: refuses giving subtasks to a parent with a work session whose status::text is in PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED. |
| `apiserver/prisma/migrations/0350_session_request/migration.sql` | 152, 168 | R | REL, TURN, RETRY, CAUSE, LIFE | MOVE | Trigger session_request_recipient_ended WHEN status SUCCEEDED, CANCELLED, FAILED without retry, or INTERRUPTED with end_reason: closes open requests; its function stores status::text and end_reason in close_reason. |
| `apiserver/prisma/migrations/0366_session_retry_claim_lease/migration.sql` | 53 | R | REL, TURN, RETRY, CAUSE, LIFE | MOVE | Trigger session_request_asker_stopped WHEN SUCCEEDED, CANCELLED, FAILED without retry, INTERRUPTED with end_reason, or AWAITING_INPUT after a retry was given up: releases held replies as comments. |
| `apiserver/prisma/migrations/0414_session_engine/migration.sql` | 276, 305 | R | ACT, REL | MOVE | Function guard_session_engine_acquisition, trigger on session: skips PENDING to RUNNING and refuses lease writes from old replicas; exempts a revive, OLD in SUCCEEDED, FAILED, CANCELLED and NEW PENDING. |
| `apiserver/prisma/migrations/0414_session_engine/migration.sql` | 152 | R | ACT | SAME | Function guard_opencode_runner_claim (trigger 0080:119, UPDATE OF status): drops a PENDING to RUNNING claim by a runner that has not declared opencode support. |
| `apiserver/prisma/migrations/0414_session_engine/migration.sql` | 165 | R | ACT | SAME | Function guard_antigravity_runner_claim (trigger 0367:263, UPDATE OF status): drops a PENDING to RUNNING claim by a runner without antigravity support. |
| `apiserver/prisma/migrations/0415_provider_slug_alias/migration.sql` | 76 | R | ACT, REL | MOVE | Function guard_dsh_runner_acquisition (trigger 0377:88): gates PENDING to RUNNING and lease takeover on runner dsh support; same SUCCEEDED, FAILED, CANCELLED to PENDING revive exemption. |
| `apiserver/prisma/migrations/0426_cursor_engine/migration.sql` | 284, 323 | R | ACT, REL | MOVE | Function guard_cursor_runner_acquisition, trigger on session: gates PENDING to RUNNING and lease takeover on runner cursor capability; same SUCCEEDED, FAILED, CANCELLED to PENDING revive exemption. |
| `apiserver/prisma/migrations/0507_confirmation_review_waits_for_pickup/migration.sql` | 5 | R | REL, TURN, CAUSE, LIFE | MOVE | Trigger task_owner_confirmation_review_reviewer_ended WHEN SUCCEEDED, CANCELLED, or FAILED/INTERRUPTED with end_reason: stamps reviewer_ended_at on an unanswered confirmation review. |
| `apiserver/prisma/migrations/0610_project_handoff_move_out/migration.sql` | 44 | R | REL | MOVE | Function task_claimed_project_move_guard (trigger 0122:404 on task): moving a task to another project needs an approved handoff while a session in PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED holds it. |
| `apiserver/prisma/schema.prisma` | 16, 2057, 2088, 2090, 2098, 2529, 2533, 2536, 2538-2539 | R | WIRE | MOVE | Enum RunStatus (7 values, PARKED omitted), Session.status default PENDING, cancelRequestedAt, finishedAt, endReason, five plain indexes with status as a key column (session_status_idx and the assigned_runner_id, batch_id, root_session_id and owner_id/task_id ones). Cannot express the partial unique index. |

## B. apiserver: sessions, realtime, queue, runners, managed-runners

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `apiserver/src/managed-runners/docker-backend.it.ts` | 382, 391, 397, 399 | RW | ACT, RETRY | MOVE | Integration harness: inserts an AWAITING_INPUT session by raw SQL, polls for leaving PENDING/RUNNING, clears retry_at by raw SQL. |
| `apiserver/src/managed-runners/managed-runner-work.ts` | 56-57, 61, 69 | R | ACT, REL, ENDING, RETRY | MOVE | Raw SQL deciding whether a managed runner may sleep or must wake: running turn, queued turn, open session with background work, due retry. |
| `apiserver/src/queue/dispatch-pause.service.ts` | 37, 109, 120 | R | ACT, REL | RENAME | Raw SQL: in-flight and held turns of open-status sessions, and runners with PENDING sessions to hint when dispatch resumes. |
| `apiserver/src/queue/queue.service.ts` | 241, 367, 456, 469, 518, 530, 686, 734, 771, 773, 1214 | RW | ACT, ENDING, RETRY | MOVE | The claim: raw SQL PENDING to RUNNING, RUNNING slot counts and replay, RUNNING back to PENDING; holds PENDING rows; must skip a quota hold. |
| `apiserver/src/realtime/realtime.service.ts` | 15-18, 23-27, 29, 39, 234-236, 238-241, 243, 245-249, 252-254, 257-260, 374, 1001-1002, 1231-1233, 1235, 1243-1247, 1563-1565, 1567, 1569-1575, 1577-1585, 1589-1593, 1673, 1683, 1687, 1690, 1729-1733, 1737, 1755-1760, 1820, 1848, 1870-1871, 1956-1957, 1988-1990, 2083-2084, 2098, 2127, 2130-2131, 2139 | R | WIRE, REL, TURN, ENDING, CAUSE, LIFE, RETRY | MOVE, COMPAT | Builds session summary and legacy session.ended payloads; final STATUS drives push; merge/commit drains pick lease owner or terminal; cancel drain reads finishedAt. |
| `apiserver/src/realtime/lost-runner-work.ts` | 70, 97, 108-109, 112 | RW | ACT, REL, WORK | SAME | Added in plan step 1.7, after this inventory: under the session's row lock, settles an open session that holds no slot (`sessionHoldsSlot`) but is executing (`isSessionExecuting`) on a lost runner; clears its running-work sets and leaves the status. |
| `apiserver/src/realtime/reaper.service.ts` | 2, 6-7, 9, 197, 199, 204, 264, 424, 438-439, 486, 488, 494-495, 501, 506-507, 517, 519, 530, 533, 535, 561, 609, 618, 634, 644, 648, 660, 669, 824, 830, 850-851, 854, 881-882, 887, 890, 895-897, 956, 1018, 1021, 1026, 1029, 1031, 1041-1042, 1047, 1050-1052, 1075, 1078, 1080 | RW | REL, TURN, WORK, ENDING, CAUSE, RETRY, LIFE | MOVE | Sweeps non-terminal sessions; force-finalizes to FAILED/CANCELLED/SUCCEEDED, arms retry, reclaims task, drains turns; ends parked sessions of terminal tasks. |
| `apiserver/src/runners/attention-fix.ts` | 79, 86 | R | REL, LIFE | MOVE | Not in area list. Dedup of machine fix sessions: a non-terminal, unfiled session holds the warning; a terminal one frees a new press. |
| `apiserver/src/runners/claude-account-swap.ts` | 306 | R | REL | MOVE | Added in plan step 4.2; arrived from main on 2026-11-20 (acb7448a49), after this inventory. A done Set-as-default swap reloads and hints the sessions on either account that are not ended; reads the release column since 4.2. |
| `apiserver/src/runners/runner-background-holders.ts` | 78-79 | R | ACT, REL | MOVE | Not in area list. Runner running-session count: RUNNING sessions plus open-status sessions its heartbeat names as holding background jobs. |
| `apiserver/src/runners/runner-executing-sets.ts` | 105, 173 | R | REL | MOVE | Added in plan step 4.2; written in plan step 1.6, after this inventory. Raw SQL: the beat's executing sets replace the inferred ones only on open sessions, the OPEN statuses spliced as text. Reads the release column since plan step 4.3. |
| `apiserver/src/runners/runners.service.ts` | 33, 77, 324, 577, 601, 1541, 1547 | R | REL, ACT, WIRE | MOVE, COMPAT | Lists RUNNING turns on draining runners; abandoned checkouts only for terminal sessions; passes raw session status to clients. |
| `apiserver/src/sessions/abandoned-approvals.ts` | 72, 406, 419 | R | ACT | SAME | Counts live approval cards through isSessionGenerating; the two listed lines are comments naming AWAITING_INPUT. |
| `apiserver/src/sessions/auto-retry.service.ts` | 12, 36, 359, 364-365, 441, 444, 446, 453, 456, 459-460, 504-505, 508, 511, 640, 656-657, 814, 818, 839, 1014, 1019, 1200, 1203-1205, 1674, 1687, 1700, 1759, 1774, 1810, 1884, 1926, 1932, 1986, 1991, 2002, 2023, 2027, 2030, 2038, 2045, 2050 | RW | RETRY, TURN, REL, ENDING, LIFE, WORK | MOVE | Retry sweep: selects FAILED or idle rows with retryAt, compare-and-sets on the parked status, resumes them, publishes final FAILED when giving up. Plan step 4.6: the parked FAILED branch of every sweep, claim release and announcement reads the failure cause (failedReleaseFilter, isFailedRelease); compare-and-sets keep the status as read. Removal step R4 (2026-11-21): each of those reads the release module's failure question (releaseWasFailureFilter, releaseWasFailure: the turn outcome and the end reason, design §12.3); the three sweeps keep their indexes. |
| `apiserver/src/sessions/dto.ts` | 232 | R | RETRY, WIRE | COMPAT | Not in area list. SessionArmRetryDto carries retryAt from deployed clients to arm an auto-retry. |
| `apiserver/src/sessions/open-list-version.ts` | 84, 86 | R | ACT | SAME | Not in area list. Raw SQL list version hash: other owners RUNNING sessions on runners this owner has PENDING sessions queued on. |
| `apiserver/src/sessions/running-work.ts` | 21 | W | REL | MOVE | Constant spread into every write that takes a session out of the open statuses, clearing its running-work sets; no status read itself. |
| `apiserver/src/sessions/session-move.ts` | 9, 21, 55, 61, 72, 121, 123, 125, 128, 143, 145 | R | REL, ACT, ENDING, RETRY, LIFE | MOVE | Move verdict: ended sessions move freely, open ones must be idle and not ending; refuses while FAILED or idle with retryAt armed. Plan step 4.6: the retry-armed refusal reads a failure release by its cause. Removal step R4: the armed-retry refusal reads releaseWasFailure. |
| `apiserver/src/sessions/session-reach.ts` | 246 | R | REL | MOVE | Not in area list. Finds a task work runs still occupying it (TASK_OCCUPYING statuses) before another session may settle the task. |
| `apiserver/src/sessions/session-recovery.ts` | 172-173, 186 | R | WIRE, REL | COMPAT | Refusal code table and messages for resume blocks (SESSION_NOT_TERMINAL, SESSION_ENDING) sent to clients and agents with resumeBlockedReason. |
| `apiserver/src/sessions/session-request.service.ts` | 229, 234, 298, 335, 347-348, 380, 428, 433-434 | R | REL, ENDING, RETRY, LIFE | MOVE | Reply hand-back: asker ended or ending gets a task comment, live gets a turn; waits when asker awaits auto-retry. Plan step 4.6: the asker reads carry release_cause for awaitsAutoRetry. Removal step R4: the asker reads carry the failure facts (RELEASE_FAILURE_SELECT) for awaitsAutoRetry. |
| `apiserver/src/sessions/session-request.ts` | 4, 467, 476, 878, 901, 1041, 1043, 1051-1052, 1054, 1121, 1129 | R | REL, RETRY, ENDING, LIFE, WIRE | MOVE | Wake-source and awaitsAutoRetry predicates (FAILED or idle plus retryAt); lost-delivery test on terminal status; stores derived SessionState as a request closeReason. Plan step 4.6: awaitsAutoRetry reads a failure release by its cause. |
| `apiserver/src/sessions/session-state.ts` | 6-7, 9-14, 21, 35, 56, 60, 62, 64-67, 69, 71, 73, 75, 77, 80-83, 85-87, 91, 100, 104-108, 120-123, 131, 137-138 | R | REL, ENDING, LIFE, WIRE | MOVE, COMPAT | Derives capabilities (canSend, canResume, resumeBlockedReason) from terminal status, cancelRequestedAt, runner; adds runStatus and derived states to every payload. |
| `apiserver/src/sessions/session-stream.ts` | 13 | R | NONE | SAME | SSE keepalive helper; the listed line is a comment mentioning AWAITING_INPUT. |
| `apiserver/src/sessions/sessions.controller.ts` | 27, 323, 328-329, 764 | R | WIRE, RETRY | COMPAT | Validates the compact list ?status= filter against RunStatus values; routes resume, auto-retry arm/cancel, complete/archive/restore with no decision. |
| `apiserver/src/sessions/sessions.service.ts` | 28, 92-93, 105-107, 114-115, 422, 424, 850, 1717, 1896, 2128, 2270, 2308, 2679-2685, 2743, 2747, 2753, 2869-2872, 3176-3179, 3193, 3213, 3239, 3288, 3325, 3399, 3410, 3675, 3751, 3777, 3791, 3804, 3841, 3850, 3859, 3861, 3886, 4271, 4280, 4346, 4384-4385, 4587, 4648, 4670-4671, 4755, 4767, 4936, 5093, 5125, 5134, 5142-5144, 5203-5204, 5206, 5208, 5225, 5247, 5258, 5374-5375, 5436, 5445, 5447, 5455-5458, 5867-5870, 6302, 6340-6343, 6348-6352, 6384-6385, 6392, 6414, 6860, 6872, 7033, 7126, 7335, 7339, 7387-7388, 7579, 7589, 7606, 7613, 7617, 7816, 7893, 7935, 7953, 8224, 8231, 8343, 8447, 8457, 8464, 8467, 8543, 8616, 9003, 9005, 9038, 9048, 9116, 9296, 9348, 9361, 9364, 9395, 9397-9398, 9426-9428, 9544, 9548, 9554-9555, 9560, 9576, 9600, 9608-9612, 9639-9642, 9673, 9677, 9681, 9695-9698, 9725, 9731-9733, 9737, 9760-9761, 9783-9786, 9873, 10185, 10320, 10326, 10338, 10346, 10349, 10534, 10568-10569, 10572, 10577, 10582, 10589, 10606-10609, 10611, 10616, 10772-10773, 10776, 10816-10818, 10820, 10823-10824, 10942, 10948-10949, 11073, 11094, 11100, 11106, 11129, 11142-11143, 11182, 11194, 11574, 11812, 11918, 11978, 12009, 12100, 12108-12109, 12121, 12131-12132, 12394, 12470 | RW | ACT, TURN, WORK, REL, ENDING, CAUSE, LIFE, RETRY, SHOW, WIRE | MOVE, COMPAT | Creates PENDING; send, steer, interrupt, commit, merge gates on LIVE/TERMINAL; end writes CANCELLED; resume revives terminal to PENDING; list SQL and payloads. Plan step 4.6: merge repair, arm-retry and the move subject read a failure release by its cause; mergeAfterOwnTurn drops any release that is not for finished work (isWorkFinishedRelease). Plan step 4.8: SessionsService.TERMINAL deleted; landingOnlyDetail calls landingContainerStatus. Removal step R4: merge repair and arm-retry read releaseWasFailure and its filter, mergeAfterOwnTurn releaseFinishedTheWork, and the move subject carries the failure facts. |
| `apiserver/src/sessions/task-work-carrier.ts` | 1, 18, 20, 24, 47, 76, 94-95, 128-129, 174-175, 185, 205, 250 | R | ACT, REL, RETRY, LIFE | MOVE | Raw SQL for whether a session carries its task: PENDING, RUNNING, or AWAITING_INPUT with a wake source (retry_at included); feeds task running/queued overlays. |

## C. apiserver: runner-api, schedules, watches, providers and the rest

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `apiserver/src/common/blocker-signal-exit-inventory.ts` | 115 | R | ACT | RENAME | Prose resolve rule for AWAITING_USER_INPUT blocker: "the referenced session leaves AWAITING_INPUT". Text only. |
| `apiserver/src/common/db-write-inventory.ts` | 292, 1257, 1279, 2876, 2881, 3098, 3177, 3187, 3191, 3655, 4096-4097, 4102 | R | WIRE | RENAME | Prose registry of DB writes; finalize, turn-complete, import-result and restRegionGatedRun entries describe final-status decisions and must be rewritten with the code. |
| `apiserver/src/common/runner-drain-waiting.ts` | 20-22, 30-31 | R | ACT, REL, ENDING | RENAME | Raw SQL counting PENDING sessions and queued messages on a draining runner, scoped to the four open statuses and no end requested. |
| `apiserver/src/common/session-generating.ts` | 1, 8, 18, 21-22, 27-28 | R | ACT | RENAME | isSessionGenerating and its Prisma filter: RUNNING, or AWAITING_INPUT with engineTurnActive. Mirrored in web and OrbitKit. |
| `apiserver/src/common/session-inbox-fence.ts` | 130 | R | REL | MOVE | Raw SQL retires the session inbox lease generation only when status is SUCCEEDED/FAILED/CANCELLED. |
| `apiserver/src/common/session-scheduling.ts` | 1, 8, 11-15, 20, 28, 89, 102-104, 109-110, 114-115 | R | ACT, REL, TURN | MOVE | Defines OPEN_SESSION_STATUSES (not released), UNSETTLED (owes an answer), ACTIVE_TURN, and the enqueue/complete transitions; INTERRUPTED treated as idle. |
| `apiserver/src/common/session-tree-sql.ts` | 35, 39, 72, 89, 103 | R | ACT, REL | RENAME | Raw SQL slot counting: RUNNING per runner/tree/batch, PENDING+RUNNING children, and background-held sessions as PENDING/AWAITING_INPUT/INTERRUPTED. |
| `apiserver/src/common/session-working.ts` | 136, 146, 151, 167 | R | ACT, REL | MOVE | Added in plan step 4.2; written in plan step 1.1, after this inventory. Executing, will-wake and holds-slot as a predicate, a Prisma filter and a SQL fragment; "open" is the held status set in all three, kept equal. The Prisma form is pinned by sessions/workspace-session-counts.spec.ts. Plan step 4.3 moved the SQL fragment onto the release column (with the held statuses beside it as the index path); the predicate and the Prisma filters still read the open statuses. |
| `apiserver/src/feishu/feishu-group.service.ts` | 230 | R | ACT | SAME | Raw SQL counts a group running work as sessions PENDING or RUNNING and not deleted, for the concurrency cap. |
| `apiserver/src/github/github-workspace.service.ts` | 266 | R | ACT | SAME | Republishes PENDING sessions of a workspace when its clone state moves. |
| `apiserver/src/help/help-ask-marker.ts` | 2, 52-54 | R | TURN, ACT | MOVE | helpAskOutcome: FAILED reads failed, PENDING/RUNNING/generating reads working, everything else answered. Plan step 4.6: failed reads the failure cause (isFailedRelease). Removal step R4: failed reads releaseWasFailure. |
| `apiserver/src/help/help-ask.ts` | 174 | R | WORK | MOVE | Added in plan step 4.6: the Ask list selects release_cause for helpAskOutcome. Removal step R4: selects finished_at, end_reason and last_turn_outcome instead. |
| `apiserver/src/help/help-ask-reads.ts` | 12, 157-158 | R | WIRE, TURN, LIFE | MOVE | Help context for the model: passes raw status, paused = INTERRUPTED, completed = completedAt, plus the error text. |
| `apiserver/src/link-previews/link-previews.service.ts` | 2, 4, 157-160, 162, 265-266, 274-275, 298 | R | WIRE, WORK, SHOW | MOVE, COMPAT | Session and task link cards: passes runState/sessionState/lifecycleState/endReason/retryAt; raw SQL reads a task newest session status and finished_at as lastRun. |
| `apiserver/src/owner-requests/owner-request-endings.ts` | 35, 39 | R | NONE | SAME | endReason here is the secret grant own end reason, not the session. |
| `apiserver/src/owner-requests/owner-secrets.service.ts` | 67, 69, 111, 315, 320, 339, 358, 372, 445, 544, 554, 638, 662 | R | LIFE | SAME | Grant liveness SQL reads session deleted_at/completed_at/archived_at and runner assignment only; listed endReason lines are the grant own column. |
| `apiserver/src/providers/account-move-capability.ts` | 9, 63 | R | ACT | SAME | cursorConversationStarted passes status to isSessionGenerating; no terminal value read. |
| `apiserver/src/providers/active-sessions.ts` | 2, 43-44, 46 | R | ACT, RETRY, TURN | MOVE | Counts sessions per account: PENDING/RUNNING, any with retryAt armed, and AWAITING_INPUT/INTERRUPTED active within a window; terminal ones excluded unless retrying. |
| `apiserver/src/providers/anthropic-gateway.service.ts` | 138, 147, 150-151 | R | REL, ENDING, CAUSE, LIFE | MOVE | Gateway token serves only while status is open, not completed, no end requested and endReason null. |
| `apiserver/src/providers/pool-gateway.service.ts` | 348 | R | REL, LIFE | MOVE | Pool gateway token serves only while session status is open and not completed. |
| `apiserver/src/providers/pool-login-gateway.service.ts` | 419, 429, 446-447 | R | REL, ENDING, CAUSE, LIFE | MOVE | Pool login token serves while session is open and unfiled (or a kept SubAgent runs); Claude path also needs no cancel and no endReason. |
| `apiserver/src/providers/pool-pause.ts` | 19 | R | ACT | SAME | A pause spares turns in flight on a RUNNING, unfiled session. |
| `apiserver/src/providers/providers.service.ts` | 1354 | R | ACT | SAME | Running-now members: sessions matching the generating filter. |
| `apiserver/src/providers/shared-pools.service.ts` | 625 | R | ACT | SAME | Keys running now: sessions matching the generating filter. |
| `apiserver/src/push/push.service.ts` | 14, 301, 305, 569-570, 1631, 1639, 1645, 1659 | R | ACT, ENDING, LIFE, TURN, WORK, RETRY | MOVE | Approval pushes gate on RUNNING, unfiled, no end requested; notifySessionSettled reads status and retryAt for the settle alert. Plan step 4.8: notifySessionSettled selects finished_at and release_cause for settleAlert instead of status. Removal step R4: RELEASE_FACTS_SELECT carries finished_at, end_reason, last_turn_outcome, kind and status. |
| `apiserver/src/push/settle-alert.ts` | 1, 5, 53, 57, 62, 65 | R | WORK, TURN, RETRY, LIFE, SHOW | MOVE | Decides the finished/failed push: SUCCEEDED rings Finished, unfiled FAILED rings failed, CANCELLED silent, retryAt armed suppresses. Plan step 4.8 (D2 decided 2026-11-21): Finished reads a release that finished the work (isWorkFinishedRelease), failed a failure cause; no terminal value. Removal step R4: both questions read the turn outcome and the end reason; an end not honoured is no failure (W7). |
| `apiserver/src/runner-api/background-job-wake.ts` | 3-6, 186, 191-193 | R | REL, CAUSE, LIFE, TURN | MOVE | sessionHasEnded: lifecycle not open or run state ENDED/SUCCEEDED/FAILED; the never-revive gate about fifteen machine-wake callers share. |
| `apiserver/src/runner-api/integration-job-relay.ts` | 284, 540, 606, 706, 795, 895, 942, 977, 998, 1039, 1156, 1163, 1398-1399, 1405, 1822, 1826, 1841, 1993, 2159, 3265 | R | REL, WIRE | MOVE | Listed cancel_requested_at lines are the integration job own. Session read is finishedAt of a task work sessions, passed to landing identity. |
| `apiserver/src/runner-api/link-heartbeat.ts` | 439, 508, 801 | R | REL | MOVE | Raw SQL: leases held and the heartbeat worktree snapshot write are both gated on OPEN statuses interpolated as text. |
| `apiserver/src/runner-api/runner-api.controller.ts` | 41, 57, 119, 147, 166, 661, 1069-1070, 1075, 1093, 1099, 1102-1103, 1470, 1473, 2515, 2546, 4030, 4033, 4047, 4050, 4168, 4232, 4311, 4348, 4459-4460, 4465, 4626, 4655, 4773, 4841, 4871, 4891, 4897, 4937, 5010, 5033, 5046, 5455, 5480, 5585, 5648, 5672, 5693, 5769-5770, 5783, 5789-5790, 5915, 6670, 6853, 6951, 7067, 7144-7145, 7167, 7189, 7222, 7224, 7233, 7251, 7257, 7334, 7397, 7401, 7439, 7510, 7572, 7607, 7697, 7749, 7751-7752, 7814-7815, 7818, 7823, 7831-7832, 7871, 7932, 7943, 7958, 8047, 8053, 8092, 8238, 8295, 8309, 8317, 8322, 8609, 8697, 8844, 9004, 9007, 9198, 9591, 9594, 9600, 9703, 9716-9719, 9724-9725, 9732-9733, 9745, 9750-9751, 9776-9777, 9815, 9822, 9824, 9830, 9873, 9947, 9951, 9954, 9968, 10012-10013, 10088, 10115, 10117, 10155, 10185, 10191, 10209, 10215, 10234, 10289, 10338, 10451, 10498, 10745, 10767, 10781, 10854, 11143, 11167, 11487, 11516, 11535 | RW | ACT, TURN, WORK, REL, ENDING, CAUSE, LIFE, RETRY, WIRE | MOVE | Turn-complete parks or fails the session, finalize writes the terminal status, retry arming, task reclaim, OPEN/LIVE/TERMINAL gates on every runner route, wire status. Plan step 4.6: finalize logs a runner-reported success with no end requested (reportsSuccessWithNoEnd), released engine_exited. |
| `apiserver/src/runner-api/runner-link-hints.ts` | 93, 103, 112, 114, 119 | R | ACT, REL | MOVE | Raw SQL hints: inbox sessions among RUNNING/AWAITING_INPUT/INTERRUPTED, claim hint on PENDING, decided approvals on open generating sessions. |
| `apiserver/src/runner-api/runner-link-welcome.ts` | 8, 25, 45, 83, 103 | R | REL | MOVE | Raw SQL leaseHeld = open status, CONVERSATION kind and this process as inbox lease owner. RunnerLinkSessionState name is a false positive. |
| `apiserver/src/runner-api/runner-orchestration-authorizer.ts` | 142-143 | R | REL, ENDING, LIFE | MOVE | Orchestration credential valid only for a session in OPEN statuses, not deleted, no end requested, on this runner. |
| `apiserver/src/runner-api/runner-sessions.controller.ts` | 17, 310, 423 | R | WIRE | MOVE, COMPAT | Agent session list accepts ?status= validated against RunStatus values and passes it through; comment mentions AWAITING_INPUT. |
| `apiserver/src/runner-api/runner-subagents.controller.ts` | 31, 35, 91, 243, 279, 336, 400, 431, 611, 637, 650, 653, 875, 908 | R | REL | MOVE | Refuses a new SubAgent run when the parent session is SUCCEEDED/FAILED/CANCELLED. Listed status lines are SubagentRunStatus, not session. |
| `apiserver/src/runner-api/scheduled-wakeup.ts` | 4-7, 301, 305-306, 315, 319-322, 324, 326 | R | REL, TURN, RETRY, ENDING, CAUSE, LIFE | MOVE | tickStanding: ENDED vs FAILED vs FAILED_RECOVERING (retryAt or recent claim) vs LIVE; reads FAILED before cancelRequestedAt on purpose. Removal step R4: tickStanding revives a release by a failure (releaseWasFailure); an end that was asked for and not honoured is ended (W7). |
| `apiserver/src/runner-api/scheduled-wakeup.worker.ts` | 11, 116, 120, 271, 306, 362, 408, 410, 438, 464, 499, 514 | R | TURN, RETRY, REL, ACT | MOVE | Decides each due tick by tickStanding: ends loop, misses, or revives a FAILED session through sessions.resume; silence alert reads RUNNING. Removal step R4: recoveringByRetry and the refused revive read releaseWasFailure and its filter. |
| `apiserver/src/runner-api/subagent-remote.ts` | 13, 603-604 | R | REL, ENDING | MOVE | Raw SQL PARENT_GONE: remote SubAgent run is told to stop when parent session is terminal or has an end requested. |
| `apiserver/src/runner-api/subagent-run.ts` | 12, 365 | R | NONE | SAME | SubagentRunStatus only; nothing about the session status. |
| `apiserver/src/runner-api/subagent-wake.ts` | 144 | R | REL | MOVE | Refuses to file a SubAgent wake turn when sessionHasEnded; other status literals are the subagent run own. |
| `apiserver/src/runner-api/wake-turn-withdraw.ts` | 196 | R | REL, TURN, RETRY | MOVE | Settles a drained wakeup turn by tickStanding of the session row just written. |
| `apiserver/src/schedules/schedule-runs.service.ts` | 49, 200, 204, 206-207, 447, 598, 615, 620-621, 661, 685-686, 691, 781, 1584-1585 | R | WORK, TURN, REL, RETRY, ENDING, LIFE, ACT | MOVE | Reconciles a ScheduleRun from its session: FAILED means crash or quota, SUCCEEDED/CANCELLED ended, idle means no report; stray-session dedup; landing and filing gates. Plan step 4.6: FAILED reads the failure cause, ended reads the release column, landRun lands only a held idle run or finished work (isWorkFinishedRelease). INTERRUPTED (held, legacy) and the activity set stay. Removal step R4: LIVE_SESSION and reconcileRun read releaseWasFailure and its filter, landRun releaseFinishedTheWork; an end not honoured reads as a stop (W7). |
| `apiserver/src/session-guests/session-guests.service.ts` | 6, 22, 244, 260, 276, 281, 321, 330, 336-337, 554, 556 | RW | ACT, REL, ENDING, LIFE, WIRE | MOVE | Removing a guest drops queued turns and writes PENDING back to AWAITING_INPUT; hasEnded (terminal or ending) decides send versus resume; list passes sessionState. |
| `apiserver/src/share-links/public-task.ts` | 2, 4, 27, 33, 71, 140, 231, 233, 235 | R | WIRE, SHOW, REL | MOVE, COMPAT | Public task page run: state is SessionRunState, endedAt is finishedAt unless QUEUED/RUNNING. |
| `apiserver/src/share-links/share-links.service.ts` | 13, 100, 123, 625, 629-630 | R | WIRE, LIFE | MOVE, COMPAT | Share root summary returns raw session status and lifecycleState. |
| `apiserver/src/watches/watch-delivery.service.ts` | 16-17, 19-20, 82, 195, 199, 752-753, 756, 759-760 | R | REL, ENDING, CAUSE, LIFE, TURN | MOVE | observerRefusal: a watch wake is dead-lettered when the observer is trashed, completed, ending, or run state SUCCEEDED/FAILED/ENDED. |
| `apiserver/src/watches/watch-evaluator.service.ts` | 721-722 | R | WIRE | MOVE | Raw SQL reads status, end_reason and filing timestamps of watched sessions into the predicate facts. |
| `apiserver/src/watches/watch-predicate.ts` | 8-9, 22-25, 128, 155-158, 160-162, 268, 272, 274, 276, 422-424 | R | ACT, TURN, WORK, REL, CAUSE, LIFE, WIRE | MOVE, COMPAT | Watch leaves SESSION_TURN_SETTLED (not PENDING/RUNNING) and SESSION_RUN_TERMINAL (SUCCEEDED/FAILED/ENDED); snapshots store status, endReason, runState, lifecycleState. Plan step 4.8: SESSION_RUN_TERMINAL reads runIsOver (finished_at, or INTERRUPTED with an end recorded); same rows under session_release_fact_chk. |
| `apiserver/src/watches/watch-redaction.ts` | 85-87 | R | WIRE | MOVE, COMPAT | Redacted snapshot view copies status, endReason, runState, lifecycleState words through to the reader. |
| `apiserver/src/watches/watches.service.ts` | 14, 22, 425, 450, 455-456, 711, 764-765 | R | WIRE, SHOW, ACT | MOVE, COMPAT | Target view shows derived run state with running/queued flags; builds the predicate fact from raw status and endReason. |
| `apiserver/src/wiki/wiki-chat-cards.ts` | 173 | R | REL | MOVE | A draft card counts as held by an open chat when the chat is not trashed and in OPEN statuses. |
| `apiserver/src/wiki/wiki-chat.ts` | 2, 174, 217, 231, 273-274 | R | ACT, REL, WIRE, SHOW | MOVE | Chat list: open = OPEN statuses, working = PENDING or generating, raw status returned on the chat row. |
| `apiserver/src/wiki/wiki-dossier.ts` | 1939 | R | SHOW | RENAME | Writes the raw status word into the session dossier header a model reads. |
| `apiserver/src/wiki/wiki-maintenance.ts` | 257, 335 | R | ACT | RENAME | Raw SQL: a session is settled material for the wiki when status is anything but PENDING/RUNNING (five values listed as text). Plan step 4.8 (D2): no change; it reads activity only and treats every settled session alike. |
| `apiserver/src/wiki/wiki.service.ts` | 3073, 3082, 5302, 6109 | R | ACT, REL, LIFE | MOVE | ENDED_SESSION (terminal status, completed or deleted) decides whose pending proposals a maintenance run may adopt; generatingFor uses the generating filter. |
| `apiserver/src/workspaces/main-checkout.service.ts` | 517, 664 | R | REL | MOVE | Main-checkout result notice is queued only to a RUNNING/AWAITING_INPUT/INTERRUPTED session on a capable runner; listed finishedAt lines are the request own. |

## D. apiserver: projects, tasks, task-lists

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `apiserver/src/projects/attempt-ended-unsettled.producer.ts` | 5, 64-67, 72, 91, 103, 135-136, 209, 223, 234, 259, 291, 461 | R | WORK, RETRY, WIRE | MOVE | Terminal status with no retry armed means the task attempt ended; triggers coordinator wake or human signal. Raw SQL reconcile scan. Plan step 4.6: reads only released (no terminal value told apart); sessionStatus is passed through as a detail. Raw SQL left for 4.3. Plan step 4.8: "ended" and the signal's sentence read finished_at (isReleased), not RELEASED_SESSION_STATUSES. |
| `apiserver/src/projects/completion-evidence.producer.ts` | 265, 267 | R | RETRY, TURN | SAME | Asks conversationIsPaused of the coordinator session; helper only. |
| `apiserver/src/projects/coordinator-convergence.ts` | 253, 257, 269 | R | NONE | SAME | False positive: CoordinatorSpendReason type, nothing about session status. |
| `apiserver/src/projects/coordinator-delivery.service.ts` | 385, 387, 497, 501-502, 514, 647, 649, 652 | R | REL, ENDING, TURN, RETRY, LIFE | MOVE | Refuses delivery to a terminal or ending coordinator session; paused (FAILED or retryAt) holds the wake; ended one is not revived. Plan step 4.8: the standing conversation's end reads isReleased, not SessionsService.TERMINAL. |
| `apiserver/src/projects/coordinator-evidence-queue.service.ts` | 2, 76-79, 105, 110 | R | ACT, TURN, CAUSE, RETRY, ENDING, LIFE | MOVE | Tick picks idle coordinators: AWAITING_INPUT or INTERRUPTED, no endReason, no retry, not ending or filed. Filter would admit former terminal rows. |
| `apiserver/src/projects/coordinator-evidence-queue.ts` | 68, 71, 82-84 | R | RETRY, TURN, REL | MOVE | Defines conversationIsPaused: down (FAILED, nobody ended it) or retryAt armed; holds deliveries for the coordinator. |
| `apiserver/src/projects/coordinator-fact-queue.service.ts` | 44 | R | ACT, REL, CAUSE, RETRY, ENDING, LIFE | MOVE | Added in plan step 4.2; arrived from main on 2026-11-20 (acb7448a49). The leader tick re-offers owed facts to idle coordinators: AWAITING_INPUT or INTERRUPTED, no end reason, no retry, not ending or filed. Reads held (the release column) and not queued or running since 4.2. |
| `apiserver/src/projects/coordinator-handoff.service.ts` | 12, 194, 205-206, 231, 243 | R | TURN, LIFE | MOVE | Handoff note turn outcome: non-SUCCEEDED turn end or session FAILED fails the handoff as TURN_STOPPED or TURN_FAILED. Removal step R4: the two read releaseWasFailure; an end not honoured is TURN_STOPPED (W7). |
| `apiserver/src/projects/coordinator-handoff.service.ts` | 268, 271, 274 | R | REL, TURN, LIFE | MOVE | Added in plan step 4.2; arrived from main on 2026-11-21 (6905964d65), after this inventory. The sweep fails a WRITING handoff whose revived conversation ended again before answering (TURN_FAILED when FAILED, else TURN_STOPPED), and one answered whose session is FAILED. "Ended" reads the release column since 4.2, and the two FAILED reads the failure cause since 4.6. afterTurn still reads the runner's turn-complete status word (old protocol, plan phase 6). Removal step R4: the two read releaseWasFailure; an end not honoured is TURN_STOPPED (W7). |
| `apiserver/src/projects/coordinator-wake.ts` | 362-363, 375 | R | WIRE | SAME | Passes optional sessionStatus string into the stored wake fact detail, diagnosis only; no decision here. |
| `apiserver/src/projects/criteria-decision-reply.ts` | 238, 275-276 | R | REL, ENDING, LIFE | MOVE | Sends the decision reply as a turn only when the asking session is not terminal, ending or trashed. Plan step 4.8: reads isReleased, not SessionsService.TERMINAL. |
| `apiserver/src/projects/criterion-check-ended.ts` | 47 | R | RETRY, REL | MOVE | A parked check run has ended only with no wake source; takes retryAt as an armed-retry wake source. |
| `apiserver/src/projects/criterion-move.ts` | 1, 43, 69-73, 277, 337 | R | REL | MOVE | Refuses a criterion move while a serving task has a session in the four live statuses; mirrors DB trigger 0389. |
| `apiserver/src/projects/evidence-undecided.ts` | 247, 252 | R | ENDING, REL, RETRY | SAME | Raw SQL clock reads coordinator cancel_requested_at and splices projectCoordinatorCanTake; own text needs no change. |
| `apiserver/src/projects/landing-observation-result.ts` | 324, 328 | R | REL | MOVE | A landing observation counts the task settled only when every work session has finishedAt set. |
| `apiserver/src/projects/landing-session.ts` | 6, 191, 256-258, 373 | W | WORK, ACT, LIFE | RENAME | Inserts landing container session AWAITING_INPUT; writes SUCCEEDED or CANCELLED from landing settledAs. project_landing already holds that outcome. Plan step 4.8: one landingContainerStatus for both writers and the LANDING detail. |
| `apiserver/src/projects/live-session-status.ts` | 4, 8-12, 16, 25 | R | REL | MOVE | Defines the four-status live set and its SQL literal list spliced into raw gates; same set as the claim unique index. |
| `apiserver/src/projects/open-item-escalation.service.ts` | 224-226, 249-251, 283 | R | REL, TURN, CAUSE, ENDING, LIFE | MOVE | Raw SQL escalation clock: live fix run or live coordinator (INTERRUPTED only without end_reason) stops the timer; reads finished_at as progress. |
| `apiserver/src/projects/pending-addressees.ts` | 1, 168, 179-180, 293, 295 | R | ACT, REL, TURN, RETRY, ENDING, LIFE | MOVE | Names who a task waits on: coordinator busy unless AWAITING_INPUT or INTERRUPTED, paused coordinator, work runs not ended. |
| `apiserver/src/projects/project-criterion-landing.ts` | 289, 731-732, 1074 | R | REL | MOVE | jobSawTheFinishedBranch compares landing job start to session finishedAt to decide nothing-to-land. |
| `apiserver/src/projects/project-done-request.ts` | 5, 222, 232, 235 | R | ACT | SAME | Lists project tasks with a PENDING or RUNNING session as queued or running for the done check. |
| `apiserver/src/projects/project-fuse.ts` | 4, 39 | R | NONE | SAME | False positive: CoordinatorSpendReason import only. |
| `apiserver/src/projects/project-integration-job.ts` | 534, 555, 711, 715, 718-719, 741, 767, 1302, 1718 | R | REL | MOVE | Listed lines are the integration job own cancelRequestedAt. Session read is finishedAt: landing waits until every work session finished. |
| `apiserver/src/projects/project-integration-line.ts` | 569, 666, 771, 924, 942, 964, 1412, 1462, 1493-1494 | R | REL | MOVE | Listed lines are job fields. Raw SQL workHeld: a work session with finished_at NULL holds the landing queue. |
| `apiserver/src/projects/project-integration-skip-check.ts` | 246, 278 | R | NONE | SAME | False positive: cancelRequestedAt of an integration job, not a session. |
| `apiserver/src/projects/project-list-rollup.ts` | 119, 241, 268 | R | ACT | SAME | Splices sessionCarriesTaskSql for running counts; spells no status itself. |
| `apiserver/src/projects/project-looks-finished.ts` | 202, 224 | R | REL | SAME | Reads sessionHasEnded of a delivery session; helper only. |
| `apiserver/src/projects/project-open-item.service.ts` | 929, 931, 948-949, 1730, 2535, 2935, 3339, 3370, 3441, 3545, 4035 | R | REL, TURN, CAUSE, ENDING, LIFE | MOVE | Open-item delivery and hand-to-owner decided by ended, down or over conversation; raw SQL closes TASK_FAILED items when a live run exists. |
| `apiserver/src/projects/project-open-item.ts` | 13-16, 788-790, 794, 799, 803, 813-818, 880, 883-886, 891-892, 977-978, 1047 | R | REL, TURN, CAUSE, RETRY, ENDING, LIFE | MOVE | Defines sessionHasEnded, conversationIsDown, conversationIsOver and raw SQL projectCoordinatorCanTake (live, or FAILED with retry_at). Removal step R4: conversationIsDown reads releaseWasFailure, projectCoordinatorCanTake releaseWasFailureSql. |
| `apiserver/src/projects/project-orphan-sweep.service.ts` | 141, 145, 149 | R | REL, RETRY | SAME | Skips projects whose coordinator is over or paused; helpers only. |
| `apiserver/src/projects/project-promotion.service.ts` | 610, 621 | R | NONE | SAME | False positive: integration job state, cancelRequestedAt and finishedAt; runner capabilities. |
| `apiserver/src/projects/project-ready-to-run.ts` | 30, 89, 118, 223-225, 234, 236, 280-281, 288, 300, 312, 333, 358, 371, 379-380, 391-392, 403, 410, 419, 431, 436 | R | ACT, SHOW | SAME | Raw SQL Run queue: carried session PENDING reads QUEUED, anything else RUNNING; RUNNING sorts first. |
| `apiserver/src/projects/project-started.ts` | 373, 378 | R | REL | SAME | Does not tell an ended coordinator the project started; sessionHasEnded helper only. |
| `apiserver/src/projects/project-task-integration.ts` | 399, 450, 455 | R | REL | MOVE | Listed lines are job fields. Raw SQL: work session with finished_at NULL makes a queued landing WAITING_TASK_WORK. |
| `apiserver/src/projects/project-task-work-state.ts` | 72, 75-76, 118 | R | ACT | SAME | Work-state CASE splices the carrier predicate (taskCarriedSql); its own literals are task statuses. |
| `apiserver/src/projects/project-tasks-settled.producer.ts` | 165 | R | ACT, REL, CAUSE, RETRY, ENDING, LIFE | MOVE | Added in plan step 4.2; arrived from main on 2026-11-20 (acb7448a49). Recovery of the tasks-settled fact for idle coordinators, the same filter as the fact queue. Reads held (the release column) and not queued or running since 4.2. |
| `apiserver/src/projects/projects.service.ts` | 18, 24, 29-31, 144, 687, 819, 824, 826, 862-868, 871-872, 4859, 4885, 5493, 5688, 5745, 6042, 6124, 6169, 6173, 6177-6182, 6185-6186 | R | ACT, REL, CAUSE, LIFE, WIRE | MOVE, COMPAT | Serves coordinator session runStatus, runState, endReason, finishedAt to clients. Plan step 4.8: conversationHasEnded reads isReleased, not SessionsService.TERMINAL. |
| `apiserver/src/projects/run-item-hold.ts` | 35, 42 | R | REL, RETRY | SAME | Reviewer hold falls back when the coordinator is over, waits when paused; helpers only. |
| `apiserver/src/projects/session-attempt.service.ts` | 272, 567 | R | REL, WORK | MOVE | reconcileAbandoned closes a TaskAttempt as INTERRUPTED only when its session is SUCCEEDED, FAILED or CANCELLED; raw SQL. Plan step 4.6: reads only released; raw SQL left for 4.3. |
| `apiserver/src/projects/session-source.ts` | 7, 690, 692, 697 | W | TURN, REL | MOVE | Runner-reported SOURCE refusal writes FAILED, error and finishedAt on a still-open session and clears the claim markers. |
| `apiserver/src/projects/task-exception-input.producer.ts` | 40, 101, 109-110, 125 | R | WORK, RETRY | MOVE | Raw SQL: newest work session in a terminal status with retry_at NULL is the ended attempt reported to the coordinator. Plan step 4.6: reads only released; raw SQL left for 4.3. |
| `apiserver/src/projects/task-run-stopped.producer.ts` | 2, 55, 102, 113, 129, 136 | R | ACT, REL, ENDING, LIFE | MOVE | Wakes the coordinator when a work run parks at AWAITING_INPUT, has not ended and has no wake source. |
| `apiserver/src/task-lists/task-lists.service.ts` | 2, 150, 514, 597, 857 | R | REL, TURN, ACT | MOVE | Live-set sessions get the new batch cap and are ended on list delete; FAILED runs error text feeds list diagnosis. Plan step 4.8: failed runs read the failure cause (failedReleaseFilter). Removal step R4: releaseWasFailureFilter reads the turn outcome and the end reason. |
| `apiserver/src/tasks/evidence-review.service.ts` | 107, 175, 177 | R | ACT, REL | MOVE | Idle sweep selects creator sessions at AWAITING_INPUT or INTERRUPTED; send-back skipped when the run has ended. |
| `apiserver/src/tasks/evidence-review.ts` | 172, 326, 350 | R | REL, RETRY | SAME | Reviewer sessions that are over or paused; helpers only. |
| `apiserver/src/tasks/manual-runnable-task-sql.ts` | 13, 44 | R | ACT | SAME | Manual-run predicate splices the carrier predicate; spells no session status itself. |
| `apiserver/src/tasks/model-routing.ts` | 71, 304 | R | TURN | MOVE | Last run status FAILED escalates the model tier for the next run. Plan step 4.6: production history always carries the outcome, read from the failure cause; the `status === 'FAILED'` fallback is reached only by a history without one (the specs). Removal step R4: the escalation reads the run's outcome alone; the status fallback, which a run whose outcome was OK also reached, is gone (W7). |
| `apiserver/src/tasks/owner-confirmation-if-confirmed.ts` | 257, 271-272 | R | REL, ENDING | MOVE | Preview of which run a DONE will end: the waiting work session if still in the live set and not ending. |
| `apiserver/src/tasks/owner-confirmation-review.service.ts` | 183, 187, 506, 577, 580, 607, 838 | R | REL, RETRY | SAME | Review delivery skips ended, over or paused reviewer and run sessions; helpers only. |
| `apiserver/src/tasks/owner-confirmation-review.ts` | 339, 477, 499 | R | REL, RETRY | MOVE | Abandons unanswered reviews of a parked reviewer unless a wake source, including retryAt, remains. |
| `apiserver/src/tasks/reclaim-stalled-task.ts` | 1, 12, 15-19, 52 | R | REL | MOVE | Defines TASK_OCCUPYING; resets an IN_PROGRESS task to OPEN or FAILED when no live-set session remains. |
| `apiserver/src/tasks/reference-expansion.ts` | 2, 105 | R | TURN | MOVE | Reads error text of FAILED runs of a list to explain why it is stuck. Plan step 4.8: failed runs read the failure cause (failedReleaseFilter). Removal step R4: releaseWasFailureFilter reads the turn outcome and the end reason. |
| `apiserver/src/tasks/session-created-tasks.service.ts` | 155 | R | ACT | SAME | Running count splices sessionCarriesTaskSql; other literals are task statuses. |
| `apiserver/src/tasks/task-completion-evidence.service.ts` | 367, 516 | R | NONE | SAME | Comments only; states that source session status never gates the evidence fact. |
| `apiserver/src/tasks/task-evidence-decision.ts` | 505, 507 | R | REL, ENDING | SAME | Reach check before a send-back only when the submitting run has not ended; via sessionHasEnded helper only. |
| `apiserver/src/tasks/task-model-routing-report.service.ts` | 58-59, 70, 81, 84, 116, 136 | R | TURN, WORK, RETRY, SHOW | MOVE | Raw SQL routing report: FAILED runs, quota-marker exclusion, first-pass success as run_status not FAILED, duration from finished_at. Plan step 4.6: FAILED runs and first-pass read the failure cause (failedReleaseSql), never null. Removal step R4: run_failed is releaseWasFailureSql. |
| `apiserver/src/tasks/task-retry-policy.ts` | 1, 36, 46, 52, 54, 59, 61, 66 | R | WORK, CAUSE, LIFE | MOVE | autoRunEnd classifies an ended auto-run from status, endReason and filing: requested, unrequested (FAILED or CANCELLED) or finished. Plan step 4.6 (D5): UNREQUESTED is any release that is not for finished work (isWorkFinishedRelease) with no end reason; engine_exited is a stop whatever the runner said. Removal step R4: FINISHED is held, or releaseFinishedTheWork (finished_at, kind, end_reason). |
| `apiserver/src/tasks/task-route-decision.ts` | 1, 372, 397-399, 405 | R | TURN, RETRY, WORK | MOVE | Builds model-routing history: run FAILED plus error text gives quota, capacity, acceptance or plain failure. Plan step 4.6: the run's failure, quota and capacity read the failure cause. Removal step R4: the run's failure reads releaseWasFailure. |
| `apiserver/src/tasks/task-run-identity.ts` | 15 | R | NONE | SAME | Comment only. |
| `apiserver/src/tasks/task-run-receipt.ts` | 462, 476, 490, 494, 522, 545 | R | WIRE | COMPAT | TASK_ALREADY_RUNNING 409 body carries conflictingSessionStatus and tells callers to wait for a terminal status. |
| `apiserver/src/tasks/task-supersession.ts` | 368 | R | NONE | SAME | Comments only; its predicates are about task status. |
| `apiserver/src/tasks/task-write-approval.ts` | 70, 283 | R | REL | MOVE | Authorization: a runner task write is refused when its session is SUCCEEDED, FAILED or CANCELLED. Plan step 4.8: reads heldFilter (finished_at IS NULL), not RELEASED_SESSION_STATUSES. |
| `apiserver/src/tasks/tasks.service.ts` | 20, 35, 137, 819, 828, 837, 1234, 1367, 1425, 1462, 1478-1479, 1484, 1585, 1766, 1784, 1814, 3787, 3862, 8161, 8267, 8272-8273, 8413, 9536, 9555, 9616, 9619, 9723, 9741-9743, 10900, 11618, 11773, 12175, 12181, 12255, 12261, 12790, 13029, 13063-13064, 13094, 13128-13129, 13131, 13163, 13168, 13547, 13596, 13706, 13715, 13749, 13876, 13962, 13965, 14436, 14443, 14471, 14473, 14521, 14885-14886, 14904-14905, 14923, 14945, 15142, 15144-15145, 15212, 15229, 15232, 15274, 15292, 15296, 15488, 16429, 16454, 16832 | R | ACT, REL, WORK, TURN, RETRY, CAUSE, ENDING, LIFE, WIRE, SHOW | MOVE, COMPAT | Dispatch sweeps, one-run claim, auto-retry counts, slot budgets, mention delivery in raw SQL. Serves sessionStatus in task reads. Plan step 4.6: the brake counts failures by the failure cause and unrequested ends as releases neither failed nor for finished work; the moment read carries release_cause for autoRunEnd. Plan step 4.8: the spent-landing check and movePausedRunToPinnedModel read isReleased, not SessionsService.TERMINAL. Removal step R4: the brake's failures read releaseWasFailureFilter, its unrequested ends NOT of both questions with no end reason, and the moment read carries finished_at and kind. |
| `apiserver/src/tasks/undecidable-evidence.ts` | 313, 317, 323, 421, 424 | R | REL | SAME | Addresses undecidable evidence to coordinator or run only if not ended; sessionHasEnded helper only. |
| `apiserver/src/tasks/verification-dependency.ts` | 57, 61, 87, 93, 132-133, 175, 178-179, 354, 379, 410, 420, 426-427 | R | WORK, REL, CAUSE, LIFE | MOVE | Check passes only if a run is SUCCEEDED with end_reason task_done and filed, and no live-set run; raw SQL dispatch gate. Plan step 4.6: a pass reads release_cause task_done in place of SUCCEEDED, beside end_reason task_done and filed. Removal step R4: a pass reads finished_at (released) beside end_reason task_done; VERIFICATION_RUN_RELEASE_CAUSE is gone. |
| `apiserver/src/tasks/verification-epoch-read.ts` | 88, 97 | R | WORK, REL, CAUSE, LIFE | MOVE | Loads each check session status, endReason and filing into the run facts the verification gate judges. Plan step 4.6: loads release_cause into the run facts. Removal step R4: loads finished_at in place of release_cause. |
| `apiserver/src/tasks/verification-liveness.ts` | 30, 73, 79 | R | REL, ACT | MOVE | hasLiveRun reads the live set; hasAnyRun reads any status other than PENDING as having run. |

## E. shared package

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `shared/src/dto.ts` | 23-27, 38, 46-47, 848, 2523, 2592, 2661, 2707, 2776, 2789, 2833, 2882, 2896, 2963, 3389, 3407, 3422, 3493-3494, 3667, 3881-3882, 3884, 3886-3888, 3901-3903 | RW | WIRE, TURN, REL | COMPAT | Wire types: SessionCapabilities, runner TurnCompleteRequest.status (turn outcome), RunFinalizeRequest.status, reclaim/takeover status, search-hit state fields. Deployed runners and clients decode them. |
| `shared/src/enums.ts` | 5-10, 12, 14, 18, 21, 26, 30-36, 44, 49, 51, 54, 65, 70-71, 74, 77, 80, 91, 94, 102, 104, 111, 121, 125-126, 130, 132, 135-146, 148-150, 154, 156, 161-164, 169, 171-176, 178, 188, 190, 192-194, 198-209, 212-213, 215-218, 220, 222-223, 226, 231, 238-244 | RW | WIRE, ACT, TURN, WORK, REL, CAUSE, LIFE | MOVE, COMPAT | Defines RunStatus, SessionEndReason and the three derived enums plus their derive functions; gracefulEndStatus picks the terminal status finalize and the reaper write. |
| `shared/src/link-preview.ts` | 16-19, 68-73, 76-77, 98-99 | R | WIRE, RETRY | COMPAT | Link-card preview types carry status, runStatus, runState, sessionState, lifecycleState, endReason, retryAt for a session and status+runState for a task run. |
| `shared/src/owner-confirmation.ts` | 61 | R | WIRE, CAUSE | SAME | Comment on a type: the task run that a DONE ends with end_reason task_done. No status read. |
| `shared/src/realtime.ts` | 3-8, 169, 171-173, 175, 177-179, 181, 267, 273, 333, 335-337, 339, 341-344, 348 | R | WIRE, RETRY, CAUSE, LIFE | COMPAT | Control-stream payloads session.created/updated/ended carry status, runStatus, sessionState, runState, lifecycleState, filingState, capabilities, retryAt, endReason to every connected client. |
| `shared/src/runner-link/v1/runner_link_pb.ts` | 503, 505, 562, 564, 592, 595 | R | NONE | SAME | Generated runner-link message named SessionState: session id, durable seq and lease_held. Not the session status; a lease fact already on the runner wire. |
| `shared/src/schedule.ts` | 69, 182, 554, 1138, 1318, 1320, 1828 | R | LIFE, WIRE | SAME | ScheduleRunSessionState is OPEN, COMPLETED, TRASH or GONE (lifecycle of a run session). runStates are the ScheduleRun enum, not the session. |
| `shared/src/session-guests.ts` | 39-40 | R | WIRE | COMPAT | GuestSessionSummary row type: status, sessionState, lifecycleState as plain strings, plus activity. |
| `shared/src/task-run-reason.ts` | 21-22 | R | ACT, WIRE | RENAME | Defines SessionActivity (TURN, BACKGROUND_JOB, WAITING) as what a parked AWAITING_INPUT session is still doing. Comments name the value. |
| `shared/src/watch.ts` | 21-23, 37-39, 207-210, 268, 272 | R | WIRE, REL, TURN | COMPAT | Watch grammar leaves SESSION_TURN_SETTLED and SESSION_RUN_TERMINAL, and the stored observed snapshot (status, endReason, runState, lifecycleState). Published to agents and persisted. |
| `shared/src/wiki-docs-wholefile.source.md` | 1331 | R | REL | RENAME | Documentation text of the dead-task rule: no PENDING, RUNNING, AWAITING_INPUT or INTERRUPTED session left on the task. Prose only. |

## F. Web client

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `web/src/api.ts` | 916, 1102, 1127, 1152, 1266-1267, 1269, 1308, 1534-1535, 1537-1538, 1934-1937, 1965, 1968-1969, 1974, 2024-2025, 2027, 2030, 2055, 2057, 2117-2118 | RW | WIRE, RETRY, CAUSE, LIFE | COMPAT | Session payload types with every state field optional, plus the calls that ask the server to end, complete, resume, interrupt and arm auto-retry (retryAt). |
| `web/src/components/CoordinatorChange.tsx` | 23, 144 | R | REL | MOVE | After endSession, polls getSession until isSessionTerminal before moving the conversation to another workspace. |
| `web/src/components/MergeRecoveryPanel.tsx` | 9, 19, 38, 50, 59, 82, 161 | R | ACT, TURN, SHOW | MOVE | Repair session: PENDING, QUEUED or RUNNING means repair in progress; FAILED shows Repair session failed with its error and changes the button. |
| `web/src/components/OrbitLinkCard.tsx` | 47, 205-209, 320 | R | SHOW, TURN, WORK | MOVE | Link card colour by run state: live, attention for AWAITING_INPUT, done for SUCCEEDED, failed for FAILED, idle otherwise. |
| `web/src/components/OwnerRequestCard.tsx` | 447, 695-696, 711 | R | NONE | SAME | endReason here belongs to an owner-request secret grant (DELIVERY_FAILED, RUNNER_DELETED), not a session. |
| `web/src/components/ProjectCoordinatorCard.tsx` | 6-7, 53-57, 65, 168, 172, 181-183, 186, 390-391, 394 | R | ACT, LIFE, SHOW | RENAME | Coordinator card: Working when runState RUNNING or AWAITING_INPUT with engineTurnActive, else Idle for every other run state; lifecycleState COMPLETED drawn apart. |
| `web/src/components/ProjectProgressStatus.tsx` | 19, 2294, 2596 | R | LIFE | SAME | Reads only coordination.session.lifecycleState COMPLETED to say the coordinator ended. |
| `web/src/components/ProjectReadyToRun.tsx` | 269, 272, 274, 309, 316, 321, 343, 355, 375, 389, 392, 394, 400, 403 | R | NONE | SAME | runState here is a project task row state (READY, QUEUED, RUNNING, PAUSED) the server derives; no session field read. |
| `web/src/components/RunNeverStartedCard.tsx` | 25, 117-120, 284, 301, 427, 452, 489 | R | TURN, ACT, RETRY, SHOW | MOVE | Never-started card: applies when QUEUED, RUNNING or FAILED with no engineStartedAt and no retry pending; FAILED with zero turns means the engine died. |
| `web/src/components/RunnerEngines.tsx` | 1520 | R | ACT, REL, SHOW | RENAME | Sessions blocking an account removal: raw status RUNNING or PENDING drawn running, AWAITING_INPUT drawn waiting. |
| `web/src/components/SessionMoveModal.tsx` | 40, 173 | R | REL | MOVE | Move to another workspace: ends the session, then polls until isSessionTerminal before the move. |
| `web/src/components/SessionSearch.tsx` | 9, 44-45, 355, 363 | R | LIFE, SHOW | SAME | Search palette: Completed or Trash tag from lifecycle; glyph and word come from WorkspaceView StatusIcon and statusLabel. |
| `web/src/components/SessionSettingsDrawer.tsx` | 266 | R | ACT | SAME | Restart button wording: turn running when runStatus or status is RUNNING. |
| `web/src/components/SharedWithMe.tsx` | 8, 98 | R | SHOW | SAME | Shared with me row prints sessionStateWord for the guest summary. |
| `web/src/components/TaskDetailPanel.tsx` | 82-85, 123-133, 136, 810, 1454, 1498-1499, 1583, 1604, 1606, 2492 | R | WORK, ACT, TURN, SHOW | MOVE | Task run rows: badge and dot from the session run state (Succeeded, Failed, Ended) as the run outcome; isSessionBusy drives polling and the running flag. |
| `web/src/components/Transcript.tsx` | 3010, 3138, 3158-3160 | R | RETRY, SHOW | MOVE | AutoRetryCard countdown from retryAt and attempts handed in by the page; gave-up state when retryAt is null and attempts are spent. |
| `web/src/components/WatchCard.tsx` | 350-352 | R | SHOW, WIRE | COMPAT | Prints a stored watch snapshot verbatim: status, run state, filed state, approval pending. |
| `web/src/components/WatchParts.tsx` | 49 | R | SHOW | RENAME | Watch target name and status for a session: runState, else status, passed to the word map. |
| `web/src/components/WatchRelations.tsx` | 278-280, 282-285 | R | SHOW, TURN | MOVE | Pill colour for a watched session by run state, including SUCCEEDED done, FAILED failed, ENDED and INTERRUPTED cancelled. |
| `web/src/components/WikiChatPanel.tsx` | 78, 1129, 1147, 1151-1152, 1247-1248, 1270, 1430, 1490 | R | ACT, REL, TURN, RETRY | MOVE | Wiki chat: live gates send; terminal feeds stream idle and the ended state unless retry pending; RUNNING offers steer; FAILED marks the failed turn. |
| `web/src/components/WikiSources.tsx` | 4, 115 | R | SHOW | SAME | Passes WorkspaceView statusLabel to link cards as the state word. |
| `web/src/components/WorkspaceView.tsx` | 557-559, 563, 565-570, 611, 615, 1141, 1166, 1174, 1176, 1343, 1345, 1383, 1394, 1396, 1404, 1441, 1437, 1792, 1798, 1801, 1809-1810, 1814-1815, 1822, 1839, 1850-1851, 1853, 1878, 1885, 1902, 1919, 1959, 1964, 1983, 1992, 2761, 3118-3119, 3173, 3308, 3357, 3366, 3369, 3372, 4249, 4420, 4440, 4468, 4536, 4542, 4809, 4811, 5022, 5221, 5938, 5942, 6430, 6516, 6551, 6624, 7183, 7191, 7425, 7449, 7476, 7564, 7568, 8095, 8142, 8220-8221, 8293-8294, 8673, 9528, 9556, 9771-9772, 9816, 11180 | R | ACT, TURN, REL, RETRY, LIFE, SHOW | MOVE | The console: row line, glyph, header word, send/resume/new-session choice, ended banner, stop button, slot count, polling and export read run state and capabilities. |
| `web/src/components/help/HelpAsk.tsx` | 42, 372, 374, 378-379, 391 | R | ACT, REL | MOVE | Help chat: polls while live, passes runStatus and runTerminal to the stream, treats PENDING as working. |
| `web/src/components/settings/WorkspaceSettingsPage.tsx` | 385 | R | ACT | SAME | Worktree rows: busy when runState, runStatus or status equals RUNNING. |
| `web/src/index.css` | 3089, 15782, 15786, 15789, 15792 | R | SHOW | RENAME | CSS classes named after state values: .tdp-dot.RUNNING, .SUCCEEDED, .FAILED, .AWAITING_INPUT; a comment on the awaiting pill. |
| `web/src/lib/claudeRegion.ts` | 13, 59 | R | ACT | SAME | Held for the Claude region: run state QUEUED together with a region error text. |
| `web/src/lib/cursorRuntime.ts` | 127-128 | R | ACT | RENAME | Cursor conversation started: turns counted, a runtime id, raw status RUNNING, or AWAITING_INPUT with engineTurnActive. |
| `web/src/lib/ownerRequests.ts` | 51 | R | NONE | SAME | endReason of an owner-request grant type, not a session. |
| `web/src/lib/queries.ts` | 33, 402, 905, 941 | R | LIFE | SAME | List fetch checks every row lifecycle matches the requested view; runState at 905 is the project task row state. |
| `web/src/lib/runnerAccountCopy.ts` | 80 | R | SHOW | RENAME | Copy constants for sessions holding an account; a comment names AWAITING_INPUT. |
| `web/src/lib/runnerSlots.ts` | 4-6, 9, 23, 25, 57, 144, 160, 165 | R | REL, ACT | SAME | Slot count is sessions whose raw runStatus is RUNNING; starting and compacting notices read RUNNING plus engine fields. |
| `web/src/lib/sessionActivity.ts` | 24 | R | ACT | RENAME | Outliving work of a parked session from running subagent and background counts; only a comment names AWAITING_INPUT. |
| `web/src/lib/sessionCapabilities.ts` | 3-5, 7, 24, 32, 34, 50, 54-55, 62, 70, 74-77, 79, 98 | R | REL, LIFE, ENDING | MOVE | Picks SEND, RESUME, CREATE or BLOCK: live uses canSend, not live uses canResume; decodes resumeBlockedReason including NOT_TERMINAL and ENDING. |
| `web/src/lib/sessionDetailPolling.ts` | 1, 17-18 | R | REL | MOVE | Polls the open session detail only while isSessionLive. |
| `web/src/lib/sessionExport.tsx` | 23, 119 | R | SHOW | RENAME | HTML export prints the run state word in the header line. |
| `web/src/lib/sessionFolders.ts` | 346 | R | REL | MOVE | runWorkspaceMove loop: waits until the ended() probe (isSessionTerminal) is true after ending a session, then moves it. |
| `web/src/lib/sessionImport.ts` | 28 | R | TURN, WORK | MOVE | Import wait loop: raw status FAILED, CANCELLED or INTERRUPTED means the import failed, with session.error as the reason. |
| `web/src/lib/sessionState.ts` | 6-7, 13-19, 21, 24, 27, 31-33, 35-36, 38-39, 45-46, 48, 50, 54, 60-62, 96-97, 111-112, 117, 119, 125, 127-128, 131, 134-135, 137, 139, 144-145, 148-149, 152-154, 156-163, 165-169, 171-172, 175, 178, 186, 189-191, 206, 215, 219, 233, 236, 248-249, 255-256, 261, 264-266, 282, 284, 286, 290-293, 312-313, 316-317, 319, 323-324, 327-328, 331-332, 341-342, 356, 359, 364, 370, 375-376 | R | ACT, TURN, WORK, REL, CAUSE, LIFE, RETRY, SHOW, WIRE | MOVE | The web decoder: runState first, then runStatus or status with endReason, then legacy sessionState; defines live, terminal, busy, retry pending, words, ended banner. |
| `web/src/lib/sessionTurnIntent.ts` | 14 | R | ACT | SAME | Composer default intent: CURRENT_WORK when live and status RUNNING, or PENDING with no turns yet. |
| `web/src/lib/taskRunHandoff.ts` | 98 | R | ENDING | SAME | Task start conflict copy: a run being cancelled is ENDING, told apart from HELD by a server field, not by status. |
| `web/src/lib/transcriptPaint.ts` | 33-35, 37, 50 | R | ACT, SHOW | SAME | Empty transcript placeholder: queued when runState is QUEUED, else starting or skeleton. |
| `web/src/lib/useSessionStream.ts` | 162-163, 192-193, 241, 1318, 1323, 1325, 1332 | R | ACT, REL | RENAME | Polled idle fallback: idle when the run is terminal or runStatus is AWAITING_INPUT, not idle when RUNNING. |
| `web/src/lib/watches.ts` | 394-395, 402, 404-411 | R | SHOW, TURN | MOVE | Watch strip: words per session run state, and counts a target failed when its status is FAILED, done when neither running nor queued. |
| `web/src/pages/GuestSessionPage.tsx` | 33-35, 37, 276, 500, 502, 637 | R | REL, LIFE, SHOW | MOVE | Guest page: live and not Completed decides the composer hint (runs now or restarts the session); poll loop stops expecting once live. |
| `web/src/pages/ProjectsPage.tsx` | 3, 1576, 1716 | R | LIFE | SAME | Reads coordination.session.lifecycleState and deletedAt to choose replace-coordinator wording. Other status literals are project or task ones. |
| `web/src/pages/ScheduledPage.tsx` | 830 | R | NONE | SAME | runStates is the schedule run label table. |
| `web/src/pages/SharedLinksPage.tsx` | 18, 57, 60-61 | R | LIFE, SHOW | SAME | Shared link row: a session root shows its lifecycle label; root.status is used only for tasks and projects. |
| `web/src/pages/SharedSessionPage.tsx` | 30-31, 33-36, 38, 63-64, 117, 120, 134, 138-139, 578 | R | ACT, REL, TURN, LIFE, SHOW | MOVE | Public share page: poll cadence from working, live and Completed; pill colour per run state with SUCCEEDED done and FAILED failed. |
| `web/src/pages/SharedTaskPage.tsx` | 176 | R | WORK, SHOW | MOVE | Public task page run rows: badge from run.state through SESSION_STATE_META (Succeeded, Failed, Ended). |
| `web/src/pages/WikiPage.tsx` | 7, 263, 413 | R | SHOW | SAME | Passes WorkspaceView statusLabel to link cards as the state word. |
| `web/ui-migration/composer.browser.mjs` | 14, 41, 102, 113, 119, 144, 151, 164, 170, 281 | R | NONE | SAME | runStates is a local helper that drives composer scenarios in a browser capture. |
| `web/ui-migration/condition-triggers.capture.mjs` | 132, 179 | R | NONE | SAME | Mock capture data with invented session fields (status COMPLETED, runState IDLE or AWAITING_APPROVAL); no product read. |

## G. Published contracts

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `../contracts/codex-rate-limit-reset.contract.json` | 54-55 | R | NONE | SAME | SUCCEEDED and FAILED are refresh and operation states of a Codex rate-limit reset. |
| `../contracts/codex-rate-limit-reset.fixtures.json` | 482 | R | NONE | SAME | Fixture values of the reset operation status. |
| `../contracts/orbit-agent.contract.json` | 184, 186 | R | WIRE | COMPAT | Published agent contract: session_create and task_start receipts must carry the session status (free string). No status enum is listed here; session_get lives in runner-go. |
| `../contracts/outcome-reconciler-v2.contract.json` | 376 | R | NONE | SAME | attemptOutcomes SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, SUPERSEDED belong to a goal attempt, not a session. Not agent-facing. |
| `../contracts/outcome-reconciler-v2.schema.json` | 543 | R | NONE | SAME | Same attempt outcome enum in the JSON schema. Not a session status. |
| `../contracts/runner-link/v1/runner_link.proto` | 206, 218 | R | NONE | SAME | Runner wire message SessionState: durable_seq and lease_held (false when the session ended or was taken over). Not agent-facing; not the status. |
| `../contracts/schedule.contract.json` | 40, 274 | R | NONE | SAME | runStates is the ScheduleRun enum and its labels. Published to clients; no session status. |
| `../contracts/watch.contract.json` | 18, 28, 242, 291, 473, 486, 523, 542, 548, 554, 560, 624, 837 | R | WIRE, REL, TURN, ACT, CAUSE | COMPAT | Published agent schema: session_await leaves SESSION_TURN_SETTLED (status not PENDING/RUNNING) and SESSION_RUN_TERMINAL (run state SUCCEEDED, FAILED, ENDED); wake payload carries observed status, endReason, runState. |
| `../contracts/wiki.contract.json` | 838 | R | NONE | SAME | Prose about a tool call finished_at; no session status. |

## H. Scripts

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `../scripts/acceptance/landing-reliability-recheck.sh` | 14, 111, 114 | R | REL | MOVE | Raw SQL compares a work session finished_at with a landing job finished_at. |
| `../scripts/acceptance/lib/integration-line-fixture.sh` | 511, 517 | W | WORK, REL | MOVE | Inserts a work session as SUCCEEDED with finished_at, because the landing queue refuses a task whose work session has no finished_at. |
| `../scripts/codex-reset-e2e/harness.mjs` | - | R | NONE | SAME | SUCCEEDED is the reset operation status. |
| `../scripts/codex-reset-e2e/run.mjs` | - | R | NONE | SAME | SUCCEEDED is the reset operation status. |
| `../scripts/kimi-accounts-stack/scenario5.mjs` | 96 | R | REL | MOVE | Filters the live sessions as those whose status is not ENDED, COMPLETED, FAILED or CANCELLED. |
| `../scripts/launch-metrics/partner-funnel.sql` | 59, 61 | R | WORK | MOVE | Raw SQL metric: counts sessions with status SUCCEEDED and takes min(finished_at) as first successful run. |
| `../scripts/lib/outcome-reconciler-protocol-registry.mjs` | - | R | NONE | SAME | SUCCEEDED is a protocol action outcome. |
| `../scripts/lib/outcome-reconciler-v2.mjs` | - | R | NONE | SAME | Attempt outcome enum of the outcome reconciler. |
| `../scripts/long-running-loops/drill.py` | 412, 470, 472, 604, 606, 678-679 | R | ACT, RETRY, CAUSE, ENDING | MOVE | Drill reads status AWAITING_INPUT as idle, FAILED with retryAt as armed retry, and dumps end_reason, finished_at, cancel_requested_at. |
| `../scripts/managed-runner/image-smoke.py` | 52, 60 | W | ACT, WIRE | RENAME | Fake control plane answers reclaim and takeover-leases with status AWAITING_INPUT to a real runner binary. |
| `../scripts/managed-runner/lab/durability-lab.py` | 788, 790 | R | TURN, ACT | MOVE | Polls until status is FAILED, AWAITING_INPUT or CANCELLED and asserts FAILED for a refused run. |
| `../scripts/managed-runner/lab/login-lab.py` | 443-444, 451-452 | R | ACT, TURN, WIRE | MOVE | Reads status, runStatus, sessionState, runState, endReason from the API; settled when not queued or running; FAILED ends the wait. |
| `../scripts/managed-runner/lab/runner-image.py` | 533-534, 677 | R | ACT, WIRE | RENAME | Dumps status, runStatus, sessionState, runState, endReason; default expected status is AWAITING_INPUT. |
| `../scripts/managed-runner/lab/wake-lab.py` | 297, 534, 582 | R | ACT, RETRY | RENAME | Dumps status, runStatus, retry_at and retry_attempts of sessions for the wake lab report. |
| `../scripts/owner-secret-e2e/run.mjs` | 222, 224, 226 | R | ACT, TURN | MOVE | Wait loop: FAILED, INTERRUPTED or CANCELLED is fatal and prints end_reason and error; AWAITING_INPUT or COMPLETED means settled. Grant end_reason is separate. |
| `../scripts/project-liveness-audit.sql` | 51, 236 | R | REL | MOVE | Raw SQL audit: a project or owed task is live when a session has status in PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED. |
| `../scripts/runner-link/drills/README.md` | 46, 203 | R | ACT | RENAME | Drill documentation naming AWAITING_INPUT. |
| `../scripts/runner-link/drills/durable-events-drill.sh` | 754 | R | ACT | RENAME | Verdict requires the session to be AWAITING_INPUT at the end. |
| `../scripts/runner-link/drills/mass-disconnect-drill.sh` | 333, 674, 746, 759 | R | ACT | RENAME | Parked means AWAITING_INPUT; during an outage status must stay RUNNING or AWAITING_INPUT. |
| `../scripts/runner-link/drills/release-outage-drill.sh` | 239 | R | ACT | RENAME | Verdict requires AWAITING_INPUT after the outage. |
| `../scripts/runner-link/loadgen-seed.sh` | 97, 110-111, 150-151 | RW | REL, ACT | MOVE | Seeds sessions at AWAITING_INPUT and ends a previous load run by UPDATE status SUCCEEDED, finished_at now where status is RUNNING, PENDING or INTERRUPTED; clears cancel_requested_at. |
| `../scripts/runner-link/reconnect-probe.sh` | 85, 96, 211 | R | REL | MOVE | Raw SQL: sessions a reconnecting runner still holds are those with status in the four live values and an assigned runner. |
| `../scripts/runner-link/welcome-walk-cost.sh` | 60 | R | REL | MOVE | Raw SQL cost probe over conversation sessions in the four live statuses. |
| `../scripts/task-codeless-drill/run.mjs` | 160-161 | R | ACT, TURN | MOVE | Wait loop: FAILED, INTERRUPTED, CANCELLED fatal; AWAITING_INPUT or COMPLETED settled. |
| `../scripts/task-fork-drill/run.mjs` | 170-171 | R | ACT, TURN | MOVE | Wait loop: FAILED, INTERRUPTED, CANCELLED fatal; AWAITING_INPUT or COMPLETED settled. |
| `../scripts/test-dsh-dispatch.mjs` | 228, 284-285, 324, 326-327, 366, 412-413 | R | ACT, TURN, REL, CAUSE | MOVE | Asserts an ended session settles CANCELLED with finished_at and end_reason ended; AWAITING_INPUT after a turn; FAILED or CANCELLED abort the wait. |
| `../scripts/test-dsh-executable-acceptance.mjs` | 371-372 | R | ACT, TURN | RENAME | Waits for status AWAITING_INPUT after a turn; FAILED or CANCELLED abort. Other statuses there are task ones. |
| `../scripts/test-dsh-install-gate.mjs` | 222, 227-228, 264, 306, 335-336, 348, 366-367 | R | ACT, TURN, REL, CAUSE | MOVE | Same assertions: CANCELLED plus end_reason ended after End, AWAITING_INPUT after a turn, PENDING with an error while the engine is not installed. |
| `../scripts/test-merge-recovery-server.mjs` | 54, 57 | R | REL | RENAME | Comments beside spec names: an AWAITING_INPUT or INTERRUPTED repair session is reused, a SUCCEEDED or CANCELLED one is resumed. |

## I. Apple clients (OrbitKit, macOS, iOS)

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `macos/OrbitApp/Sources/OrbitApp/AppModel.swift` | 1483, 3325, 3382, 3766 | R | CAUSE, LIFE, REL | MOVE | Reads endReason task_done to decide finish banner; polls status until terminal before a workspace move; lifecycle filters. |
| `macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift` | 211, 233, 245, 251, 497, 974, 1345, 1354, 1806, 2100, 2183, 2216, 2223, 2231, 2266, 2413, 2520, 2536, 2577, 2588, 3010, 3021, 3141-3142, 3146, 3151, 3188, 3193, 3215, 3217, 3228, 3232, 3389, 3469, 3471, 3492, 3494, 3511, 3552, 3608 | RW | ACT, REL, RETRY, SHOW | MOVE | Reconciles stream and REST status; terminal status picks POST /resume over /turns; pending gates start cards; arms and cancels auto-retry. |
| `macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift` | 340, 346, 368, 371-372, 379, 822, 852, 857, 884, 905, 929, 943, 1800 | R | ACT, LIFE | SAME | Reads running to offer queue/stop, passes authoritative status into send, completed-resume notice from lifecycle and capabilities. |
| `macos/OrbitApp/Sources/OrbitApp/Views/Console/AutoRetryCard.swift` | 53-54 | R | RETRY | SAME | Passes the detail retryAt and attempts into the auto-retry card state. |
| `macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift` | 266, 636, 694, 773, 784, 848, 853, 856, 864, 1526, 1646, 1648, 1999 | R | ACT, LIFE, SHOW | RENAME | Running flags for transcript rows, lifecycle menus, isLive adds Stops the current run, prints raw status word. |
| `macos/OrbitApp/Sources/OrbitApp/Views/Console/FoldedBandBar.swift` | 49, 176 | R | ACT, REL | MOVE | Turn-active from status; treats not-live status as committed worktree for the merge/commit button. |
| `macos/OrbitApp/Sources/OrbitApp/Views/GuestSessionView.swift` | 35-36 | R | ACT, REL, SHOW | RENAME | Holds GuestSessionState; live clears the expecting flag, tone colours the header dot. |
| `macos/OrbitApp/Sources/OrbitApp/Views/MainCheckoutViews.swift` | 32, 576 | R | ACT | SAME | Passes effective run status into WorktreeBarLogic.turnActive to disable main checkout actions. |
| `macos/OrbitApp/Sources/OrbitApp/Views/MergeRecoverySheet.swift` | 92 | R | ACT | SAME | Passes effective run status into turnActive to disable recovery steps mid-turn. |
| `macos/OrbitApp/Sources/OrbitApp/Views/OwnerRequestViews.swift` | 277 | R | NONE | SAME | endReason of a credential grant, not a session. |
| `macos/OrbitApp/Sources/OrbitApp/Views/ProjectLandingsWindowView.swift` | 102, 118 | RW | LIFE, WIRE | RENAME | Filters landing rows not in trash; builds a placeholder Session with status succeeded for a focused landing. |
| `macos/OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift` | 2024, 2056, 2112 | R | NONE | SAME | runState of a project ready-to-run task item, not a session. |
| `macos/OrbitApp/Sources/OrbitApp/Views/SessionProjectListSupport.swift` | 10 | W | WIRE | RENAME | Builds a placeholder Session with status awaitingInput for date grouping of a project row. |
| `macos/OrbitApp/Sources/OrbitApp/Views/SessionProjectPage.swift` | 988 | R | LIFE | SAME | Chooses Open or Completed scope from lifecycle. |
| `macos/OrbitApp/Sources/OrbitApp/Views/SessionSearchView.swift` | 39, 159 | R | SHOW, LIFE | SAME | Search hit glyph from effectiveRunState and a Completed/Trash badge from lifecycle. |
| `macos/OrbitApp/Sources/OrbitApp/Views/SessionSettingsSheet.swift` | 58, 61 | R | ACT | SAME | Reads isGenerating to mark a turn running in the settings sheet. |
| `macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift` | 1265, 1868, 2880, 2900, 2953, 2957-2964, 2970-2974 | R | WORK, ACT, SHOW | MOVE | Task run rows: label and colour Succeeded/Failed/Ended from the run session state; elapsed time while running. |
| `macos/OrbitApp/Sources/OrbitApp/Views/WikiChatViews.swift` | 812, 814 | R | REL, RETRY, LIFE | MOVE | Chat ended line from trash, terminal status and retryPending. |
| `macos/OrbitApp/Sources/OrbitApp/Views/WorktreeBar.swift` | 153, 155, 161 | R | ACT, REL | MOVE | Not-live status means committed worktree; turn-active disables merge and commit. |
| `macos/OrbitApp/Sources/OrbitApp/WorktreeModel.swift` | 84-85, 156 | R | ACT, REL | MOVE | Live diff refresh only while status isLive; keeps polling while the merge repair session is queued or running. |
| `macos/OrbitKit/README.md` | 29 | R | WIRE | RENAME | Documentation line listing the status enums in Enums.swift. |
| `macos/OrbitKit/Sources/OrbitKit/App/AutoRetryLogic.swift` | 126, 146, 166 | R | RETRY | SAME | Card state from armed retryAt and attempts: armed, firing, gave up; no status read. |
| `macos/OrbitKit/Sources/OrbitKit/App/ClaudeRegion.swift` | 62-63, 67, 71-72 | R | ACT, SHOW | SAME | Queued (PENDING) plus a region error reads as held for the Claude region. |
| `macos/OrbitKit/Sources/OrbitKit/App/Composer.swift` | 94, 96, 101, 103-105, 113, 115, 124, 133, 137, 139, 141, 149, 154-155, 158, 164, 196-197, 206-207, 221, 236-237, 245-246, 249, 260, 272-274, 291, 307, 309, 448, 466 | R | ACT, REL, ENDING, TURN, LIFE | MOVE | Send availability, queue vs send, resume vs turns endpoint from terminal status, capabilities gate, blocked copy, suggestion hidden after failed. |
| `macos/OrbitKit/Sources/OrbitKit/App/CoordinatorChange.swift` | 88, 139 | R | LIFE | SAME | Coordinator session lifecycleState completed or trash decides the change card state. |
| `macos/OrbitKit/Sources/OrbitKit/App/CoordinatorContextActions.swift` | 170 | R | LIFE | SAME | Context actions only for a session whose lifecycle is open. |
| `macos/OrbitKit/Sources/OrbitKit/App/CursorRuntime.swift` | 144 | R | ACT | SAME | isGenerating counts as the conversation having started. |
| `macos/OrbitKit/Sources/OrbitKit/App/GuestSession.swift` | 56, 59-62, 67, 73, 79, 81-82, 86-92, 116, 118 | R | ACT, REL, LIFE, SHOW | MOVE | Guest view: live vs ended decides hint and poll cadence (stops following once not live), tone and word per run state. |
| `macos/OrbitKit/Sources/OrbitKit/App/ManagedRunnerDisplay.swift` | 351, 354 | R | REL | SAME | Rewrites capabilities so a managed offline runner does not block send; reads resumeBlockedReason only. |
| `macos/OrbitKit/Sources/OrbitKit/App/MenuBar.swift` | 68-71, 73, 75-76 | R | SHOW, CAUSE | RENAME | Menu bar subtitle per run status; cancelled defers to the endReason-aware word. |
| `macos/OrbitKit/Sources/OrbitKit/App/Navigation.swift` | 747 | R | LIFE | SAME | Picks the Open/Completed/Trash list for a session from lifecycle. |
| `macos/OrbitKit/Sources/OrbitKit/App/Notifications.swift` | 14, 45, 48, 51, 55, 73, 76, 84 | R | TURN, WORK, RETRY, CAUSE, REL | MOVE | Finished notification when a live row turns terminal with no retryAt or leaves Open; endReason task_done filter. |
| `macos/OrbitKit/Sources/OrbitKit/App/OpenListRowUpdate.swift` | 28-29 | R | REL, RETRY, LIFE | MOVE | A summary with terminal status forces a full list refetch because retryAt qualifies the failure. |
| `macos/OrbitKit/Sources/OrbitKit/App/OrbitLinkCard.swift` | 280, 301, 305, 307, 311 | R | SHOW, RETRY, ACT | RENAME | Link card glyph from run state, retryPending and awaitingInput plus WAITING activity. |
| `macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift` | 2195 | R | LIFE | SAME | Coordinator session lifecycle completed reads as coordinator ended. |
| `macos/OrbitKit/Sources/OrbitKit/App/OwnerRequests.swift` | 265-266, 295 | R | NONE | SAME | endReason of a credential grant, not a session. |
| `macos/OrbitKit/Sources/OrbitKit/App/ProjectPage.swift` | 1002, 1013-1014 | R | ACT, LIFE | RENAME | Coordinator pill Working/Idle from runState running or awaitingInput with engineTurnActive; Completed from lifecycle. |
| `macos/OrbitKit/Sources/OrbitKit/App/ProjectPageSections.swift` | 354, 367 | R | NONE | SAME | runState of a project queue task item, not a session. |
| `macos/OrbitKit/Sources/OrbitKit/App/QueuedCapacity.swift` | 28 | R | ACT | SAME | Queued run state plus queuedReason reads as a capacity hold. |
| `macos/OrbitKit/Sources/OrbitKit/App/QueuedDiskLow.swift` | 16 | R | ACT | SAME | Queued run state plus queuedReason reads as a low-disk hold. |
| `macos/OrbitKit/Sources/OrbitKit/App/RecapCard.swift` | 23, 52-53 | R | ACT, LIFE | SAME | Recap card only when not trashed, not generating and not queued. |
| `macos/OrbitKit/Sources/OrbitKit/App/RunnerAccountCopy.swift` | 75 | R | SHOW | SAME | Copy for sessions holding a runner account; comment names AWAITING_INPUT. |
| `macos/OrbitKit/Sources/OrbitKit/App/RunnerPageFormat.swift` | 765, 768 | R | ACT, SHOW | RENAME | Account-in-use rows: running or pending reads Running, awaitingInput Waiting, anything else muted. |
| `macos/OrbitKit/Sources/OrbitKit/App/RunnerUpdating.swift` | 67 | R | ACT | SAME | Queued run state plus queuedReason reads as held for a runner update. |
| `macos/OrbitKit/Sources/OrbitKit/App/ScheduleCopy.swift` | 120, 435-444 | R | NONE | SAME | Schedule run state labels, not session status. |
| `macos/OrbitKit/Sources/OrbitKit/App/ScheduleDisplay.swift` | 307, 453, 455, 1009 | R | NONE | SAME | Schedule run state labels, not session status. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionFolderGrouping.swift` | 132 | R | ACT | SAME | Folder summary running flag from raw status running. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionGrouping.swift` | 50-53 | R | ACT, REL | MOVE | Menu bar buckets: queued, and running for every other isLive row; terminal rows are uncounted. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionHeader.swift` | 37-38, 43, 45, 47-48, 60, 62-64, 66, 68, 147, 154 | R | SHOW, ACT, TURN, RETRY | MOVE | Status word per run state: Queued, Running, Waiting, Succeeded, Failed, Retrying, Disconnected from error text, Interrupted, Ended. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionLine.swift` | 61, 81, 102, 126 | R | ACT, SHOW | RENAME | List row line: queued hold words, awaitingInput on a watch, generating, background work. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionProjectMembers.swift` | 19, 34 | R | LIFE | SAME | Project member rows filtered by lifecycle. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionRunStart.swift` | 129, 137, 159-160, 270, 338 | R | TURN, ACT | MOVE | Start-failure card stands only while status is failed or pending and the session error names a machine reason. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionStatusGlyph.swift` | 10-11, 59, 64, 66, 75-77, 81, 83-86, 90, 92, 96, 99, 104, 106, 130-131, 135, 138, 142, 168, 171, 177, 189, 192 | R | SHOW, ACT, TURN, RETRY | MOVE | Glyph per run state: success tick, red failure with error text, retrying clock, offline, ended. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionUpsert.swift` | 44-46, 48, 84, 88, 153-157, 188, 201-203, 243, 247, 253, 280 | R | WIRE, RETRY | MOVE | Folds session.updated summary fields (status, runStatus, sessionState, runState, lifecycle, capabilities, retryAt) into the row. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionViews.swift` | 25 | R | LIFE | SAME | Maps the list view to a lifecycle state. |
| `macos/OrbitKit/Sources/OrbitKit/App/SessionWorkspaceMove.swift` | 111, 125, 127 | R | REL, ENDING | MOVE | End and Move: after POST end, polls run status until isTerminal before moving; times out otherwise. |
| `macos/OrbitKit/Sources/OrbitKit/App/ShareMarkdown.swift` | 47, 87, 89-95 | R | SHOW, WORK | MOVE | runLabel maps run state to words for task panel runs and the guest header. |
| `macos/OrbitKit/Sources/OrbitKit/App/SharedLinksList.swift` | 134 | R | LIFE | SAME | Share root lifecycle label only. |
| `macos/OrbitKit/Sources/OrbitKit/App/TaskDetailAgentFirst.swift` | 115-116, 124 | R | ACT | SAME | Finds a task's running or queued run session. |
| `macos/OrbitKit/Sources/OrbitKit/App/TaskListLogic.swift` | 149, 156 | R | ACT | SAME | Task running/queued overlay from its sessions' run state. |
| `macos/OrbitKit/Sources/OrbitKit/App/TaskRunHandoff.swift` | 95 | R | ENDING | SAME | Task-already-running conflict kinds; comment on cancel_requested_at separating held from ending. |
| `macos/OrbitKit/Sources/OrbitKit/App/WatchProjection.swift` | 557 | R | SHOW, WIRE | RENAME | Watch strip glyph from a session target's raw SessionRunState string; unknown reads Ended. |
| `macos/OrbitKit/Sources/OrbitKit/App/WikiChatLogic.swift` | 1211, 1213-1214 | R | REL, RETRY, LIFE | MOVE | endedLine: chat takes no more messages when trashed or not live, not pending and no retry pending. |
| `macos/OrbitKit/Sources/OrbitKit/App/WorktreeBarLogic.swift` | 161, 163-165 | R | ACT, REL | RENAME | turnActive: pending/running true, parked depends on sending or subagents, terminal false. |
| `macos/OrbitKit/Sources/OrbitKit/Models/ControlEvent.swift` | 117, 119, 121, 123-124, 164, 171, 187-189, 191-193, 196, 204-209, 223, 228, 243, 251-252, 272-277, 279-282, 284-286, 289, 294-300 | R | WIRE, CAUSE, RETRY, LIFE | COMPAT | Decoders for session.created/updated summary and session.ended; status is required strict RunStatus; filingState fallback. |
| `macos/OrbitKit/Sources/OrbitKit/Models/DTOs.swift` | 471-472, 476-477, 480-481, 492-494, 505, 507-508, 510-511, 514, 516, 519, 710, 713, 719, 722, 744, 768-771, 776, 778-780, 787, 809, 812-813, 820-821, 827, 834-839, 915, 918, 924, 934-936, 957, 959, 964, 983-985, 1039, 1042, 1047, 1800-1804, 1814-1816, 1829-1831, 1833, 1835-1836, 1895, 1897, 1919-1921, 1923-1925, 1928, 1934-1939, 1967-1968, 1977-1979, 1996, 2002-2004, 2032-2033, 2046, 2177, 2179, 2181, 2183-2184, 2191, 2196, 2202-2205, 2207-2208, 2214, 2222-2225, 2227-2228, 2238 | R | WIRE, ACT, RETRY, LIFE, REL | COMPAT | Session, SessionDetail, SearchHit, MergeRepairSession, capabilities decoders; isGenerating, retryPending (failed plus retryAt), lifecycle fallback. |
| `macos/OrbitKit/Sources/OrbitKit/Models/Enums.swift` | 7, 14, 21, 30, 36, 38-39, 41-42, 44-45, 48, 60, 66, 72-78, 80-85, 88-89, 93, 99-103, 105, 107-114, 116, 122, 124, 135, 208-209, 212, 226 | R | WIRE, REL, CAUSE | COMPAT | RunStatus (strict, no unknown case), SessionRunState, SessionState, lifecycle enums; isLive/isTerminal; resolve maps status plus endReason. |
| `macos/OrbitKit/Sources/OrbitKit/Models/LinkPreviews.swift` | 83-88, 91-92, 112-114, 123-124, 144-145, 150-151 | R | WIRE, RETRY | COMPAT | Link preview session and task run DTOs with strict optional RunStatus; retryPending copy. |
| `macos/OrbitKit/Sources/OrbitKit/Models/MergeRecovery.swift` | 340-342 | R | ACT, TURN | MOVE | Repair row: queued/running reads running, failed shows the error and stops continuing so the server replaces the repair session. |
| `macos/OrbitKit/Sources/OrbitKit/Models/OwnerRequestModels.swift` | 65, 74, 78 | R | NONE | SAME | endReason of a credential grant, not a session. |
| `macos/OrbitKit/Sources/OrbitKit/Models/ProjectDetail.swift` | 1009-1011, 1020-1021, 1026-1028, 1040-1042 | R | WIRE, LIFE | COMPAT | Coordinator session ref decodes runState and lifecycleState leniently. |
| `macos/OrbitKit/Sources/OrbitKit/Models/ProjectPlan.swift` | 215, 224, 229, 240 | R | NONE | SAME | RunState of a ready-to-run task item, not a session. |
| `macos/OrbitKit/Sources/OrbitKit/Models/Runners.swift` | 626, 628, 642 | R | WIRE | COMPAT | Account-removal session rows decode status leniently into RunStatus. |
| `macos/OrbitKit/Sources/OrbitKit/Models/SessionGuests.swift` | 69-70, 74-75, 80-81, 87-89, 100-101, 103-104, 107-109, 111-112, 118, 123, 126-127, 129-131, 141, 145, 167, 171, 192, 194 | R | WIRE | COMPAT | Guest summary and head decode status, runStatus, sessionState, runState, lifecycleState, filingState as lenient strings. |
| `macos/OrbitKit/Sources/OrbitKit/Models/ShareLinks.swift` | 100, 104, 109 | R | WIRE, LIFE | SAME | Share root carries status and lifecycleState as plain strings; only lifecycle is read. |
| `macos/OrbitKit/Sources/OrbitKit/Models/Tasks.swift` | 313, 318-321, 337-339 | R | WIRE | COMPAT | SessionRef on a task: strict optional RunStatus, runState, sessionState, endReason resolved to a run state. |
| `macos/OrbitKit/Sources/OrbitKit/Models/Watches.swift` | 261, 264, 287-289 | R | WIRE | COMPAT | Watch target standing and observed facts carry session status, endReason, runState as strings. |
| `macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift` | 208, 420, 454, 509, 521, 531, 534-535, 2287 | RW | WIRE, LIFE, RETRY, REL | COMPAT | Strict [Session] list decode; lifecycle scope fallback; requests POST turns, resume, end, retry-message, and arm/cancel auto-retry with retryAt. |
| `macos/OrbitKit/Sources/OrbitKit/Transcript/TranscriptReducer.swift` | 28, 109, 577, 580, 1425, 1479, 1505, 1524-1525, 1532, 1536, 1548-1550, 1876, 2302 | RW | ACT, TURN, REL | MOVE | Local stream status: adopts turn_end/status event values, sets interrupted or awaitingInput itself, terminal marks pending bubbles undelivered. |

## J. Android client

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `android/app/src/main/kotlin/io/orbitd/android/MainActivity.kt` | 258, 423 | R | ACT, LIFE, SHOW | SAME | Counts running sessions per folder for a label; reads lifecycleState to key the open route. |
| `android/app/src/main/kotlin/io/orbitd/android/cards/OwnerRequestViews.kt` | 102 | R | NONE | SAME | endReason here is a secret grant's, not the session's. |
| `android/app/src/main/kotlin/io/orbitd/android/cards/SessionCards.kt` | 35, 102, 107, 113, 131, 443 | R | NONE | SAME | SessionState is the realtime container class; no run status read. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/ComposerData.kt` | 6, 648-649, 655-656, 658-660, 663, 688, 693, 698-700, 711, 715, 717 | R | ACT, REL, TURN, LIFE | MOVE | Legacy send-or-resume gate off terminal status sets when capabilities are absent; suggestion offered only on parked states, not after FAILED; Stop gate. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/ComposerModel.kt` | 535, 563 | R | REL | MOVE | terminal(detail) decides whether a model/provider pick is stored for the resume or patched live; liveRun wording of the switch note. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/ComposerUsage.kt` | 17, 27, 30 | R | ACT | SAME | Usage strip reads runState/status RUNNING only. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/CoordinatorHandoff.kt` | 136 | R | LIFE | SAME | Reads lifecycleState COMPLETED of the coordinator session; FAILED at 299 is a handoff state. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/CursorRuntime.kt` | 136-137 | R | ACT | RENAME | Conversation started if RUNNING, or AWAITING_INPUT with engineTurnActive; gates the provider move menu. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/NewSessionComposer.kt` | 90 | R | NONE | SAME | Constructs the realtime SessionState container only. |
| `android/app/src/main/kotlin/io/orbitd/android/composer/SessionComposer.kt` | 59, 79, 143, 217, 219, 314, 435, 443 | R | ACT, REL, RETRY | MOVE | Running flag for Stop; terminal(detail) shows the resume note with resumeBlockedReason; retryAt present offers Cancel automatic retry. |
| `android/app/src/main/kotlin/io/orbitd/android/directory/DirectoryActions.kt` | 289, 302-303 | R | REL | MOVE | Move to workspace ends the session, then polls until status is SUCCEEDED/FAILED/CANCELLED; times out after 60 s otherwise. |
| `android/app/src/main/kotlin/io/orbitd/android/directory/DirectoryModels.kt` | 38, 70, 135, 186 | R | WIRE, ACT | COMPAT | Session row DTO: status (default UNKNOWN), runState, runStatus, endReason, retryAt, lifecycleState; folder summary counts status RUNNING. |
| `android/app/src/main/kotlin/io/orbitd/android/directory/DirectoryScreen.kt` | 345 | R | SHOW | RENAME | Search hit prints the raw runState or status string and lifecycleState. |
| `android/app/src/main/kotlin/io/orbitd/android/directory/RecapCard.kt` | 21, 40 | R | ACT, LIFE | SAME | Recap card only when not generating, not queued and not in Trash. |
| `android/app/src/main/kotlin/io/orbitd/android/directory/SessionLine.kt` | 59, 71-72, 85, 184-185, 188-189, 191, 199, 201, 203-204, 225-226, 228-230, 232-236, 238-240, 246, 249, 253, 256-258, 264-265, 275-277, 285 | R | ACT, TURN, CAUSE, RETRY, LIFE, SHOW, WIRE | MOVE | Defines RunState and resolves it from runState, runStatus/status and endReason; row words incl. Failed, Retrying, Interrupted, Ended; unknown reads Ended. |
| `android/app/src/main/kotlin/io/orbitd/android/directory/SessionListPage.kt` | 145, 149, 154 | R | ACT, TURN, RETRY, SHOW | MOVE | Row mark: queued clock, parked marks, red dot for FAILED unless a retry is pending or the error says offline. |
| `android/app/src/main/kotlin/io/orbitd/android/management/RunnerPage.kt` | 302, 1432, 1462-1463 | R | ACT, SHOW | RENAME | Sessions holding an account: RUNNING/PENDING read Running, AWAITING_INPUT reads Waiting for input, anything else no words. |
| `android/app/src/main/kotlin/io/orbitd/android/management/SharingSettings.kt` | 144 | R | LIFE | SAME | Shared-object row reads lifecycleState; other status maps are task/project/link states. |
| `android/app/src/main/kotlin/io/orbitd/android/navigation/ObjectDestination.kt` | 101 | R | LIFE | SAME | Maps lifecycleState to the session view for the options sheet. |
| `android/app/src/main/kotlin/io/orbitd/android/projects/CoordinatorChange.kt` | 93 | R | LIFE | SAME | Outgoing coordinator session is Completed or Open by lifecycleState. |
| `android/app/src/main/kotlin/io/orbitd/android/projects/ProjectPage.kt` | 469, 476-477, 830, 837 | R | ACT, LIFE, SHOW | RENAME | Coordinator pill: RUNNING, or AWAITING_INPUT with engineTurnActive, reads Working, else Idle; other runState reads are task queue rows. |
| `android/app/src/main/kotlin/io/orbitd/android/projects/ProjectsScreen.kt` | 545, 1155, 1160, 1162-1163, 1165 | R | NONE | SAME | runState here is the ready-queue row of a task (READY/PAUSED/QUEUED), not a session status. |
| `android/app/src/main/kotlin/io/orbitd/android/push/PushAuthority.kt` | 23, 59, 85, 99, 145, 189 | R | WORK, TURN, RETRY, ENDING, LIFE | MOVE | A finished/failed push stands only if session status equals SUCCEEDED/FAILED with no retryAt; approvals need no cancelRequestedAt and OPEN lifecycle. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/AutoRetryCard.kt` | 43, 53, 82 | R | RETRY, SHOW | MOVE | Auto-retry card counts down to the armed retryAt. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/AutoRetryLogic.kt` | 73, 80 | R | RETRY, SHOW | MOVE | Words and controls of the auto-retry card from retryAt and attempts. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/MainCheckoutModel.kt` | 174-175 | R | ACT | SAME | Move targets: a PENDING or RUNNING session is shown but not offered. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/MergeRecovery.kt` | 38, 41, 176, 262 | R | ACT, WORK, SHOW | MOVE | Repair session row: running on PENDING/QUEUED/RUNNING, FAILED shows its error, anything else reads completed. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/SessionConsole.kt` | 262, 264, 286 | RW | RETRY | MOVE | Reads retryAt and retryAttempts of the detail; posts sessions/:id/auto-retry with a new retryAt. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/SessionMenu.kt` | 28-29, 51, 61 | R | REL, LIFE, SHOW | MOVE | LIVE set QUEUED/RUNNING/AWAITING_INPUT/INTERRUPTED decides the Stops the current run warning on Complete and Trash. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/SessionReader.kt` | 229, 491, 650, 844 | R | ACT, REL | MOVE | Polls the worktree while status is RUNNING/AWAITING_INPUT/INTERRUPTED; queued gate card on QUEUED; PENDING hides the bar. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/SessionReaderModel.kt` | 19, 203 | R | NONE | SAME | Holds the realtime SessionState container only. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/SessionSettingsPage.kt` | 34, 59, 85 | R | ACT | SAME | Reads resolved run state RUNNING for the page. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/SessionWork.kt` | 18, 29 | R | NONE | SAME | status here is a background job's. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/TranscriptRows.kt` | 73 | R | TURN, WIRE | COMPAT | A turn_end event whose status is one of the seven RunStatus words is authoritative; any other value marks the turn end unexplained. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/WorktreeBar.kt` | 143-144, 147, 478 | R | REL, ACT | MOVE | committed = status not RUNNING/AWAITING_INPUT/INTERRUPTED, i.e. the runner finalized the worktree; gates Commit versus Merge and diff reload. |
| `android/app/src/main/kotlin/io/orbitd/android/reader/WorktreeBarLogic.kt` | 64-66 | R | ACT, REL | RENAME | turnActive: PENDING/RUNNING always, AWAITING_INPUT/INTERRUPTED only while sending or sub-agents run, an ended session never. |
| `android/app/src/main/kotlin/io/orbitd/android/tasks/TaskDetail.kt` | 792, 957-959, 965, 969 | R | WORK, ACT, SHOW | MOVE | Task run rows: colour and spinner per resolved run state, green SUCCEEDED and red FAILED as the run's outcome. |
| `android/app/src/main/kotlin/io/orbitd/android/tasks/TaskDetailAgentFirst.kt` | 66, 73 | R | ACT | SAME | Picks the task's RUNNING, else QUEUED, session as the live run. |
| `android/app/src/main/kotlin/io/orbitd/android/tasks/TaskLogic.kt` | 137-139, 142-148, 152-154, 158, 162, 164, 590, 909-911 | R | ACT, WORK, CAUSE, SHOW, WIRE | MOVE | resolvedRunState from runState, status+endReason, legacy sessionState; task running/queued from its sessions; run labels Succeeded/Failed/Ended; unknown reads a dash. |
| `android/app/src/main/kotlin/io/orbitd/android/watch/WatchLogic.kt` | 125, 131-137 | R | SHOW, WORK, TURN | MOVE | Watch target glyph per run state: Succeeded, Failed, Interrupted; unknown or ENDED draws the neutral Ended glyph. |
| `android/app/src/main/kotlin/io/orbitd/android/watch/WatchWire.kt` | 195-196, 206 | R | WIRE, CAUSE, LIFE | COMPAT | Decodes a watch observation's session facts: status (required), endReason, runState, lifecycleState. |
| `android/app/src/main/kotlin/io/orbitd/android/wiki/WikiJobPage.kt` | 73, 96, 151 | R | NONE | SAME | runStateLine describes a wiki job run row. |
| `android/core/src/main/kotlin/io/orbitd/android/core/cards/ClaudeRegion.kt` | 119-120, 123-125, 130 | R | ACT, RETRY | RENAME | Region hold = queued (runState QUEUED, else status PENDING) with a region error; a runState outside its seven-word set falls back to status. |
| `android/core/src/main/kotlin/io/orbitd/android/core/cards/ExceptionCards.kt` | 620 | R | LIFE | SAME | Passes the coordinator session's lifecycleState to an exception card. |
| `android/core/src/main/kotlin/io/orbitd/android/core/cards/OwnerRequests.kt` | 31, 268-269, 284 | R | NONE | SAME | endReason here is a secret grant's. |
| `android/core/src/main/kotlin/io/orbitd/android/core/cards/SessionRunStart.kt` | 45, 51 | R | TURN, ACT, RETRY | MOVE | Machine-reason card stands only while status is FAILED or PENDING, read with the session error. |
| `android/core/src/main/kotlin/io/orbitd/android/core/guests/GuestLogic.kt` | 34-35, 37, 44-46, 48-52, 54-55, 57-64, 69, 72, 78, 80-88, 91-97, 139 | R | ACT, REL, WORK, TURN, LIFE, SHOW | MOVE | GuestRunState enum and resolver; isLive decides join versus restart wording and poll cadence; words and tones; nothing known reads Ended. |
| `android/core/src/main/kotlin/io/orbitd/android/core/guests/GuestSessions.kt` | 36-37, 42, 47, 49-50, 80-83, 91 | R | WIRE | COMPAT | Decodes guest rows and heads: status/runStatus, runState, legacy sessionState, lifecycleState or filingState. |
| `android/core/src/main/kotlin/io/orbitd/android/core/protocol/DirectoryDtos.kt` | 20-21, 36-37, 44 | R | WIRE | COMPAT | SessionSummary requires a status string; runState, lifecycleState and capabilities (canSend/canResume) decide actions, never the status. |
| `android/core/src/main/kotlin/io/orbitd/android/core/realtime/RealtimeModels.kt` | 87, 154, 182 | R | NONE | SAME | SessionState is the realtime container class. |
| `android/core/src/main/kotlin/io/orbitd/android/core/realtime/RealtimeStore.kt` | 202, 354 | R | NONE | SAME | Builds and updates the realtime SessionState container. |
| `android/core/src/main/kotlin/io/orbitd/android/core/realtime/Transcript.kt` | 111 | R | ACT | SAME | A status event other than RUNNING ends the live draft blocks. |
| `android/core/src/main/kotlin/io/orbitd/android/core/schedule/ScheduleCopy.kt` | 110, 422-431 | R | NONE | SAME | runStates are schedule run states. |
| `android/core/src/main/kotlin/io/orbitd/android/core/schedule/ScheduleDisplay.kt` | 223, 348, 350, 819 | R | NONE | SAME | Schedule run states only. |
| `android/docs/notifications.md` | 52 | R | ACT | RENAME | Doc text: an AWAITING_INPUT coordinator may stay in needs-you. |
| `android/docs/projects-baseline.md` | 24 | R | NONE | SAME | Doc text about the task ready queue runState. |
| `android/docs/reading.md` | 244 | R | ACT | RENAME | Doc text of the Merge/Commit hold: PENDING, RUNNING, or AWAITING_INPUT with work in flight. |
| `android/docs/tasks-projects-contract-audit.md` | 75 | R | NONE | SAME | Doc text about the task ready queue runState. |
| `android/scripts/a11-stack/a07c-stack.mjs` | 113-114, 171 | R | ACT, TURN, RETRY | MOVE | QA stack driver, not shipped: waits for retryAt with AWAITING_INPUT and for FAILED or AWAITING_INPUT after a failed turn. |
| `android/scripts/a11-stack/verify.mjs` | 111 | R | SHOW | SAME | QA stack driver, not shipped: prints the coordinator session's runStatus and lifecycleState. |
| `android/scripts/a12-stack/seed.mjs` | 114, 119 | R | ACT, REL | RENAME | QA stack driver, not shipped: SETTLED set of AWAITING_INPUT plus the four terminal values; expects AWAITING_INPUT or SUCCEEDED. |
| `android/scripts/gen-schedule-copy.py` | 17 | R | NONE | SAME | runStates is a schedule copy map name. |
| `android/scripts/qa/README.md` | 295-297 | R | NONE | SAME | QA fixture data |
| `android/scripts/qa/dataset-server.py` | 834-835, 838, 1263 | R | NONE | SAME | QA fixture data |
| `android/scripts/qa/datasets.py` | 376-377, 379, 391, 409-410, 414-415, 434, 471, 766, 1019, 1033-1035, 1474, 1505, 1520, 1572-1573, 1577, 2041, 2094, 2155 | R | NONE | SAME | QA fixture data |
| `android/scripts/qa/stack.py` | 320, 322, 325-327, 635, 865, 920, 1252 | R | NONE | SAME | QA fixture data |

## K. Runner (Go)

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `runner-go/antigravity.go` | 576, 578, 1020, 1024, 1026, 1034, 1036, 1102, 1120, 1126, 1191, 1201, 1208, 1220, 1245, 1257, 1260, 1263, 1277, 1287, 1313, 1360 | W | TURN, REL | SAME | Antigravity turns reported SUCCEEDED/FAILED/INTERRUPTED; process loop returns its exit status to the supervisor. |
| `runner-go/claude.go` | 240, 370, 372, 374 | R | TURN | SAME | Maps a Claude result message to an ExecResult status: SUCCEEDED, FAILED, CANCELLED. |
| `runner-go/claude_delivery.go` | 378, 384, 403, 424, 471, 476, 507 | W | TURN | SAME | Settles undelivered or steer turns on turn-complete as FAILED or SUCCEEDED with a subtype. |
| `runner-go/claude_runtime.go` | 53 | R | NONE | SAME | Comment only: clients see AWAITING_INPUT for both waiting and idle. |
| `runner-go/claude_setconfig.go` | 307 | W | TURN | SAME | A config-change turn is always reported SUCCEEDED. |
| `runner-go/claude_withdraw.go` | 119 | W | TURN | SAME | A withdrawn message's turn is reported SUCCEEDED. |
| `runner-go/codex.go` | 42, 104, 116, 145, 169, 178, 189, 230, 235, 237, 518, 537, 546, 554, 595, 599-600, 604-605, 612, 647 | W | TURN, REL | SAME | codex exec turns reported SUCCEEDED/FAILED, CANCELLED when the context was cancelled; loop exit status to the supervisor. |
| `runner-go/codex_appserver.go` | 188, 191, 210, 266, 288, 291, 314, 351, 454, 459, 467, 509, 622, 656, 675, 680, 740, 744, 748, 750, 763, 769, 775, 797, 806, 817, 846, 871, 2131, 2241, 2293, 2297, 2300 | W | TURN, REL | SAME | Codex turns reported SUCCEEDED/FAILED/INTERRUPTED on turn-complete; process loop returns FAILED/CANCELLED/SUCCEEDED exit to the supervisor. |
| `runner-go/cursor_acp.go` | 1106, 1336, 1349, 1439, 1444, 1470, 1481, 1488, 1509, 1561, 1585 | W | TURN, REL | SAME | Cursor loop: turn-complete statuses and the exit status to the supervisor. |
| `runner-go/cursor_events.go` | 467, 471, 473, 476, 478, 532, 542 | W | TURN | SAME | Builds the Cursor turn-complete: SUCCEEDED, FAILED, INTERRUPTED. |
| `runner-go/cursor_usage.go` | 320, 322 | R | TURN | SAME | Reads the turn-complete it is about to send: FAILED with the usage-limit text marks the account, SUCCEEDED clears it. |
| `runner-go/dsh_acp.go` | 536, 746, 821, 837, 842, 853, 860, 871, 877, 884, 919, 934, 960 | W | TURN, REL | SAME | DSH loop: turn-complete INTERRUPTED/FAILED, unknown turn kind FAILED with its subtype; exit status to the supervisor. |
| `runner-go/dsh_events.go` | 255, 260, 265, 267, 269, 271, 278-279 | W | TURN | SAME | Builds the DSH turn-complete: SUCCEEDED, INTERRUPTED on cancel, FAILED for errors, refusal, max tokens. |
| `runner-go/kimi_account_move.go` | 186, 188, 197-198, 213, 232 | R | NONE | SAME | kimiSessionState is Kimi's own state.json. |
| `runner-go/kimi_acp.go` | 1655, 1659, 1665, 1669, 1683, 1689, 1696, 1702, 1758, 1766, 1774, 1831, 1841, 1847, 1849, 1853, 1858, 1905, 1916, 1923, 1926, 1946, 1948, 1951, 1960, 1975, 2101, 2110, 2119, 2176, 2200 | W | TURN, REL | SAME | Kimi turns reported SUCCEEDED/FAILED/INTERRUPTED; loop exit status to the supervisor. |
| `runner-go/linkpb/runner_link.pb.go` | 975, 1052, 1128, 1144-1145, 1151, 1155, 1157, 1169-1170, 1174, 1181, 1188, 3342, 3530, 3586 | R | REL, WIRE | SAME | Generated link message SessionState: lease_held and durable seq; no RunStatus. |
| `runner-go/mcp.go` | 3247, 3258-3259, 3261, 3264 | R | ACT | RENAME | sessionSettled: not PENDING/RUNNING/empty means the awaited session settled; raw status JSON passes through session tools to agents. |
| `runner-go/mcp_help_ask.go` | 28 | R | SHOW, WIRE | RENAME | Help prompt tells the model the status words: PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED = paused, COMPLETED, FAILED. |
| `runner-go/opencode.go` | 178, 224, 235, 268, 271, 278, 314, 319, 422, 431, 448, 454, 563-564, 566-567, 584, 588, 595, 643 | W | TURN, REL | SAME | OpenCode turns reported SUCCEEDED/FAILED/INTERRUPTED, CANCELLED when not an interrupt; loop exit status to the supervisor. |
| `runner-go/operation_catalog.go` | 2197, 2786, 2849, 2853, 4083 | R | WIRE | COMPAT | Published session_list input enum of the seven RunStatus values, and the CLI usage line; descriptions speak of an ended session and resumeIfEnded. |
| `runner-go/reclaim_starter.go` | 22, 221, 226, 471 | R | REL, ACT | COMPAT | Reclaim hand-over: a status outside the open set ends the takeover; RUNNING takes a turn permit. |
| `runner-go/runloop.go` | 405, 689-690, 696, 698, 753, 760, 762, 952-953, 1039, 1043, 1109, 1112, 1117, 2760, 3141-3142 | R | REL, ACT | COMPAT | Reclaim: open set is empty/PENDING/RUNNING/AWAITING_INPUT/INTERRUPTED, any other value gets no supervisor; RUNNING holds a permit; start order by status. |
| `runner-go/session.go` | 656, 658, 712, 727-728, 1270, 1300, 1319, 1380, 1394, 1396, 1464, 1487, 1566, 1570, 1598, 1607, 1678-1679, 1690, 1716, 1725, 1727, 1736, 1745, 1749, 1753, 1801, 1813, 1818, 1857, 1859, 1911, 1915, 3178, 3180-3182, 3218, 3222, 3243, 3318, 3321, 3328, 3332, 3342, 3349, 3351 | RW | TURN, REL, ACT, WORK | MOVE | Supervisor: sends turn-complete and finalize statuses, treats a terminal turn-complete answer as the run's end, parks on any answer but RUNNING, finalizes SUCCEEDED/FAILED/CANCELLED. |
| `runner-go/session_cli.go` | 155, 581, 584, 823, 1326 | R | WIRE, REL, ACT | COMPAT | orbit session list --status validates the seven values; import wait fails on FAILED/CANCELLED/INTERRUPTED; wait loop uses sessionSettled. |
| `runner-go/session_pool.go` | 64, 1137, 1359, 1514 | R | ACT | SAME | Comments only: warm/cold residency is local while the server status stays AWAITING_INPUT. |
| `runner-go/session_wait.go` | 356, 361 | R | ACT | RENAME | Durable wait for a created or awaited session: settled when its status is not PENDING/RUNNING. |
| `runner-go/shell.go` | 346 | W | TURN | SAME | A ! shell turn is reported SUCCEEDED with its exit code. |
| `runner-go/transport.go` | 905 | R | ACT, WIRE | COMPAT | turnComplete returns the answer's status or sessionStatus; an omitted status is read as AWAITING_INPUT for older servers. |
| `runner-go/types.go` | 1493, 1847, 1849, 1901, 2080, 2082-2088 | RW | WIRE | COMPAT | Status constants and wire types: TurnCompleteRequest/Response, RunFinalizeRequest, ReclaimSession.status, importOnly. |
| `runner-go/watch_tools.go` | 34, 182, 256-257, 269 | R | WIRE, REL | COMPAT | Published watch grammar: SESSION_TURN_SETTLED versus SESSION_RUN_TERMINAL (SUCCEEDED, FAILED or ended; waiting for input is settled, not over). |
| `runner-go/worktree.go` | 960, 1071, 1092, 3601-3602, 3666-3667 | R | REL, CAUSE | MOVE | Finalize as CANCELLED makes an undoable park-checkpoint commit, any other status a permanent one; gc asks the server which checkouts are resumable. |

## L. Link gateway

| File | Lines | R/W | Facts | After | What it does with the status |
|---|---|---|---|---|---|
| `link-gateway/README.md` | 294 | R | NONE | SAME | SessionState here is the link protocol message (session id, durable seq, lease held), not RunStatus. |
| `link-gateway/client_drills.go` | 417 | W | WIRE | RENAME | Drill client posts a turn-complete body with status AWAITING_INPUT to provoke a refusal; never a real completion. |
| `link-gateway/client_resume.go` | 130 | R | REL, WIRE | SAME | Drill client checks the Welcome SessionState lease_held and durable seq; no RunStatus. |
| `link-gateway/conn.go` | 195 | R | NONE | SAME | Carries the Welcome SessionState list; no RunStatus. |
| `link-gateway/linkpb/runner_link.pb.go` | 975, 1052, 1128, 1144-1145, 1151, 1155, 1157, 1169-1170, 1174, 1181, 1188, 3342, 3530, 3586 | R | REL, WIRE | SAME | Generated link message SessionState: lease_held is false once the session ended or was taken over; no RunStatus. |
| `link-gateway/welcome.go` | 39, 77, 80 | R | REL, WIRE | SAME | Relays durableSeq and leaseHeld from the apiserver into Welcome; no RunStatus. |
