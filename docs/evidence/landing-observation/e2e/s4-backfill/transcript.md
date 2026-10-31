2026-10-29T01:53:43.172Z  phase A (before the deploy): apiserver old 18dfe8f1c, runner 0.1.239 0.1.239
2026-10-29T01:53:43.468Z  project 34o4RP6Y1aSbg7buR8RD8 started: MAIN line on feature/release-2, Automatic, coordinator 34o4RP9lY7PYpK6CUMEo0
2026-10-29T01:53:45.551Z  PASS [A] T1 is DONE
2026-10-29T01:53:47.603Z  PASS [A] T2 is DONE
2026-10-29T01:53:49.654Z  PASS [A] T3 is DONE
2026-10-29T01:53:51.698Z  PASS [A] T4 is DONE
2026-10-29T01:53:51.698Z  fake engine: task 34o4RPLSeUBVha64umyOu committed 6180e80ad95fee78cbe1d7d6621e1aa871c6ca96 on orbit/task-s4-t1-the-api-endpoint-da0729; pushed to origin/feature/release-2
2026-10-29T01:53:51.698Z  fake engine: task 34o4RPMvPQuNUNHDMOjM9 committed 526a6a429a2633e4ada8851c028b3ad0a526543f on orbit/task-s4-t2-the-storage-layer-d87d4d; pushed to origin/feature/release-2
2026-10-29T01:53:51.698Z  fake engine: task 34o4RPOU4vGpIzFNnFdPo committed a10bd145ecfaaaea90648775e499b02d9758f2fb on orbit/task-s4-t3-the-settings-page-records-its-f13991; pushed to origin/feature/release-2; merge_receipt ok
2026-10-29T01:53:51.698Z  fake engine: task 34o4RPS5eu8gAtXOs8SMi committed 8b63825e1daf024db919e3d56144842308ddb446 on orbit/task-s4-t6-the-settings-tests-needs-t3-6842b8; pushed to origin/feature/release-2
2026-10-29T01:53:51.698Z  fake engine: task 34o4RPPqblDOz2nBlLQuH committed 323bd3983e4dee6441f125278b57b382383c95ad on orbit/task-s4-t4-the-migration-also-publishes-3d42d0; pushed to origin/feature/release-2; published its task branch
2026-10-29T01:53:51.709Z  PASS [A] T6 started by itself after T3's own receipt
2026-10-29T01:56:13.168Z  PASS [A] five TASK_BRANCH candidates BLOCKED
2026-10-29T01:56:13.221Z  candidates:
                       title                        |  state  | blocked_reason |  check_state   |      error_code       
----------------------------------------------------+---------+----------------+----------------+-----------------------
 S4-T1: the API endpoint                            | BLOCKED | ERROR          | ERROR          | SOURCE_BRANCH_MISSING
 S4-T2: the storage layer                           | BLOCKED | ERROR          | ERROR          | SOURCE_BRANCH_MISSING
 S4-T3: the settings page (records its own receipt) | BLOCKED | ERROR          | ERROR          | SOURCE_BRANCH_MISSING
 S4-T4: the migration (also publishes its branch)   | BLOCKED | ALREADY_LANDED | ALREADY_LANDED | 
 S4-T6: the settings tests (needs T3)               | BLOCKED | ERROR          | ERROR          | SOURCE_BRANCH_MISSING
(5 rows)


2026-10-29T01:56:13.221Z  PASS [A] four answered SOURCE_BRANCH_MISSING, one ALREADY_LANDED
2026-10-29T01:56:13.269Z  PASS [A] the project has exactly one receipt (T3's agent's) — 1
2026-10-29T01:56:13.276Z  PASS [A] every DONE task's commit is on feature/release-2
2026-10-29T01:56:13.296Z  starting T5 by hand: {"ok":false,"status":400,"body":{"message":"A prerequisite is finished but its work has not landed on this project's integration line yet — it starts by itself once the landing is recorded","error":"Bad Request","statusCode":400}}
2026-10-29T01:56:13.296Z  PASS [A] J9 refuses T5 although T1 and T2 are on the line — {"message":"A prerequisite is finished but its work has not landed on this project's integration line yet — it starts by itself once the landing is recorded","error":"Bad Request","statusCode":400}
2026-10-29T01:56:13.326Z  open items before: INTEGRATION_ERROR/COORDINATOR, INTEGRATION_ERROR/COORDINATOR, INTEGRATION_ERROR/COORDINATOR, INTEGRATION_ERROR/COORDINATOR
2026-10-29T01:56:14.840Z  coordinator open_item_resolve 34o4S9UJ7ztcpg7m04V2h: The item is closed, with your reason on it. {   "itemId": "34o4S9UJ7ztcpg7m04V2h",   "state": "RESOLVED",   "resolution": "HANDLED",   "itemPublicId": "34o4S9UJ
2026-10-29T01:56:16.357Z  coordinator open_item_resolve 34o4SuXt3MVeYVkA1oPOS: The item is closed, with your reason on it. {   "itemId": "34o4SuXt3MVeYVkA1oPOS",   "state": "RESOLVED",   "resolution": "HANDLED",   "itemPublicId": "34o4SuXt
2026-10-29T01:56:17.869Z  coordinator open_item_resolve 34o4TfjepRi5XZiNewXka: The item is closed, with your reason on it. {   "itemId": "34o4TfjepRi5XZiNewXka",   "state": "RESOLVED",   "resolution": "HANDLED",   "itemPublicId": "34o4Tfje
2026-10-29T01:56:19.381Z  coordinator open_item_resolve 34o4UQszFuZXPRysGMKDO: The item is closed, with your reason on it. {   "itemId": "34o4UQszFuZXPRysGMKDO",   "state": "RESOLVED",   "resolution": "HANDLED",   "itemPublicId": "34o4UQsz
2026-10-29T01:56:19.428Z  PASS [A] the coordinator closed its INTEGRATION_ERROR items as HANDLED — 4 items
2026-10-29T01:56:19.446Z  PASS [A] T5 is still waiting — OPEN
2026-10-29T01:56:19.867Z  SCENARIO 4 phase A: all 12 checks passed
2026-10-29T01:56:19.894Z  phase B (the deploy): stop the 0.1.239 apiserver, migrate, start this branch's apiserver; the 0.1.239 runner stays up
2026-10-29T01:56:20.404Z  stopped apiserver (427556)
2026-10-29T01:56:21.020Z  prisma migrate deploy (this branch): All migrations have been successfully applied.
2026-10-29T01:56:22.083Z  apiserver 'new' pid 446425 on 127.0.0.1:3923
2026-10-29T01:56:22.156Z  boot: [Nest] 446425  - 10/29/2026, 9:56:21 AM     LOG [InstanceLoader] LandingObservationBackfillModule dependencies initialized +1ms | [Nest] 446425  - 10/29/2026, 9:56:21 AM     LOG [LandingObservationBackfill] landing backfill: 1 project(s) with unfrozen finished work, 4 identities frozen, 1 observation(s) queued, 0 failed
2026-10-29T01:56:22.156Z  PASS [B] the boot-time pass ran and froze finished work — [Nest] 446425  - 10/29/2026, 9:56:21 AM     LOG [InstanceLoader] LandingObservationBackfillModule dependencies initialized +1ms | [Nest] 446425  - 10/29/2026, 9:56:21 AM     LOG [LandingObservationBackfill] landing backfill: 1 project(s) with unfrozen finished work, 4 identities frozen, 1 observation(s) queued, 0 failed
2026-10-29T01:56:22.204Z  tasks after the pass:
                       title                        | status | frozen |                   delivered_branch                   
----------------------------------------------------+--------+--------+------------------------------------------------------
 S4-T1: the API endpoint                            | DONE   | t      | orbit/task-s4-t1-the-api-endpoint-da0729
 S4-T2: the storage layer                           | DONE   | t      | orbit/task-s4-t2-the-storage-layer-d87d4d
 S4-T3: the settings page (records its own receipt) | DONE   | f      | 
 S4-T4: the migration (also publishes its branch)   | DONE   | t      | orbit/task-s4-t4-the-migration-also-publishes-3d42d0
 S4-T5: the release notes (needs T1 and T2)         | OPEN   | f      | 
 S4-T6: the settings tests (needs T3)               | DONE   | t      | orbit/task-s4-t6-the-settings-tests-needs-t3-6842b8
(6 rows)


2026-10-29T01:56:22.301Z  PASS [B] the four DONE, NOT_KNOWN tasks (T1, T2, T4, T6) have a delivered identity; T3 (landed by its own receipt) and T5 (OPEN) have none — 4
2026-10-29T01:56:22.346Z  PASS [B] one OBSERVE_LANDING queued for the project — QUEUED gen 1 runner -
2026-10-29T01:56:22.393Z  PASS [B] its enqueue fact says trigger DEPLOY — DEPLOY
2026-10-29T01:56:22.439Z  PASS [B] the BLOCKED candidates are untouched by the pass
2026-10-29T02:00:19.576Z  SCENARIO 4 phase B: all 5 checks passed; SCENARIO 5: all 15 checks passed
2026-10-29T02:00:19.659Z  phase C (the runner upgrade): stop the 0.1.239 runner, start this branch's runner with the same ORBIT_HOME
2026-10-29T02:00:20.175Z  stopped runner (427845)
2026-10-29T02:00:20.218Z  runner orbit-new pid 461251
2026-10-29T02:00:50.247Z  PASS [C] the upgraded runner declares integration-observe/v1 — version 0.1.240
2026-10-29T02:00:53.340Z  PASS [C] the deploy round's OBSERVE_LANDING answered OBSERVED — OBSERVED -
2026-10-29T02:00:53.340Z  PASS [C] the claim named the four frozen tasks (T3 is already landed) — 6180e80ad9 526a6a429a 323bd3983e 8b63825e1d
2026-10-29T02:00:53.388Z  receipts:
                       title                        |     result     | recorded_by |   target_branch   |                                     detail                                     
----------------------------------------------------+----------------+-------------+-------------------+--------------------------------------------------------------------------------
 S4-T3: the settings page (records its own receipt) | ALREADY_MERGED | AGENT       | feature/release-2 | {"message": "pushed straight to the line by the agent"}
 S4-T1: the API endpoint                            | ALREADY_MERGED | RUNNER      | feature/release-2 | {"observed": true, "integrationJobId": "0b1dfd20-da3b-4e48-9c37-59b3fdc7278d"}
 S4-T2: the storage layer                           | ALREADY_MERGED | RUNNER      | feature/release-2 | {"observed": true, "integrationJobId": "0b1dfd20-da3b-4e48-9c37-59b3fdc7278d"}
 S4-T4: the migration (also publishes its branch)   | ALREADY_MERGED | RUNNER      | feature/release-2 | {"observed": true, "integrationJobId": "0b1dfd20-da3b-4e48-9c37-59b3fdc7278d"}
 S4-T6: the settings tests (needs T3)               | ALREADY_MERGED | RUNNER      | feature/release-2 | {"observed": true, "integrationJobId": "0b1dfd20-da3b-4e48-9c37-59b3fdc7278d"}
(5 rows)


2026-10-29T02:00:53.478Z  PASS [C] four observed receipts (T1, T2, T4, T6) beside T3's own — 4 observed
2026-10-29T02:00:53.526Z  candidates:
                       title                        |   state    | blocked_reason |         decided_at         
----------------------------------------------------+------------+----------------+----------------------------
 S4-T1: the API endpoint                            | SUPERSEDED | ERROR          | 2026-10-29 02:00:50.293+00
 S4-T2: the storage layer                           | SUPERSEDED | ERROR          | 2026-10-29 02:00:50.308+00
 S4-T3: the settings page (records its own receipt) | BLOCKED    | ERROR          | 2026-10-29 01:55:12.62+00
 S4-T4: the migration (also publishes its branch)   | SUPERSEDED | ALREADY_LANDED | 2026-10-29 02:00:50.319+00
 S4-T5: the release notes (needs T1 and T2)         | CHECKING   |                | 
 S4-T6: the settings tests (needs T3)               | SUPERSEDED | ERROR          | 2026-10-29 02:00:50.329+00
(6 rows)


2026-10-29T02:00:53.756Z  PASS [C] their four BLOCKED candidates are retired (SUPERSEDED, M-T13) — 4
2026-10-29T02:00:53.846Z  T3's candidate (its receipt predates it, and T3 was not waiting to be observed): BLOCKED ERROR
2026-10-29T02:00:53.891Z  PASS [C] one LANDED_WITHOUT_CONFIRMATION for the project, UL:backfill:<projectId>, the owner's — UL:backfill:01a1855c-f10d-73a4-bb31-48db38b818ca | OWNER | Reached feature/release-2 without your confirmation: 4 tasks
2026-10-29T02:00:53.936Z  PASS [C] no per-task LANDED_WITHOUT_CONFIRMATION in the deploy round
2026-10-29T02:00:53.980Z  PASS [C] its payload lists the four tasks and their receipts (backfill: true) — {"jobId": "0b1dfd20-da3b-4e48-9c37-59b3fdc7278d", "backfill": true, "receipts": [{"title": "S4-T1: the API endpoint", "taskId": "01a1855c-f1a6-70b9-979d-972b1fd0e4f8", "observed": true, "receiptId": "
2026-10-29T02:00:53.998Z  PASS [C] T5 (needs T1 and T2) started by itself (J9 released, J10) — session eWUshGTixwTiBgEf83x9w at 2026-10-29T02:00:50.408Z
2026-10-29T02:00:54.012Z  PASS [C] T5 is DONE
2026-10-29T02:01:22.053Z  PASS [C] T3's leftover candidate surfaces in no owner read (no blocker, no withheld criterion, not the current promotion) — BLOCKED ERROR
2026-10-29T02:01:22.064Z  owner accepts UL:backfill: {"ok":true,"answer":{"itemId":"34o4cEi3QnC2FmciLZidz","state":"RESOLVED","resolution":"ACCEPTED","itemPublicId":"34o4cEi3QnC2FmciLZidz"}}
2026-10-29T02:01:22.109Z  PASS [C] the owner's Accept closes it RESOLVED / ACCEPTED by USER — RESOLVED ACCEPTED USER
2026-10-29T02:01:25.971Z  stopped apiserver (446425)
2026-10-29T02:01:27.047Z  apiserver 'new' pid 466247 on 127.0.0.1:3923
2026-10-29T02:01:27.048Z  second start: [Nest] 466247  - 10/29/2026, 10:01:26 AM     LOG [InstanceLoader] LandingObservationBackfillModule dependencies initialized +0ms
2026-10-29T02:01:27.236Z  PASS [C] a second start writes nothing again (no observation, no second UL:backfill, no receipt) — {"observations":"1","ul":"1","receipts":"7"} -> {"observations":"1","ul":"1","receipts":"7"}
2026-10-29T02:01:28.127Z  SCENARIO 4 phase C: all 13 checks passed
