2026-10-29T01:29:17.730Z  project 34o3qEmd7D075QEuehC7F started: line MAIN, deliveryMode PLATFORM (never chosen: true), Automatic off
2026-10-29T01:29:17.731Z  PASS the project is PLATFORM by default
2026-10-29T01:29:19.800Z  PASS S3-F is DONE
2026-10-29T01:29:19.801Z  fake engine for S3-F: committed b8a5e4913009a36bf443f584cece0e2457f88176 on orbit/task-s3-f-pushes-its-work-straight-to-ma-c292a9, pushed it to origin/main (E2E-UPSTREAM)
2026-10-29T01:29:19.804Z  PASS origin main is F's commit; no task branch on the origin
2026-10-29T01:29:38.391Z  PASS candidate source_sha = delivered_sha (O-L5) — b8a5e4913009a36bf443f584cece0e2457f88176
2026-10-29T01:29:41.493Z  S3-F's CHECK_PROMOTION answered: ALREADY_LANDED -
2026-10-29T01:29:41.493Z  PASS the check answered ALREADY_LANDED — ALREADY_LANDED -
2026-10-29T01:29:41.543Z  PASS the candidate is SUPERSEDED, not BLOCKED — SUPERSEDED -
2026-10-29T01:29:41.591Z  PASS a receipt: ALREADY_MERGED on main, by the RUNNER, detail.observed + integrationJobId — ALREADY_MERGED main RUNNER b8a5e4913009a36bf443f584cece0e2457f88176 {"observed": true, "integrationJobId": "a9370543-2539-4b3d-a442-2bc8c1a89a3a"}
2026-10-29T01:29:41.609Z  PASS LANDED_WITHOUT_CONFIRMATION is the owner's, titled for the task — OWNER: Reached main without your confirmation: S3-F: pushes its work straight to main
2026-10-29T01:29:41.609Z  PASS it offers Accept — ["ACCEPT","OPEN_TASK_SESSION"]
2026-10-29T01:29:41.622Z  PASS S3-F2 started by itself (J9 released by the check's receipt, J10) — session 4Kl4AjP8bTsWGCq0zClSGD
2026-10-29T01:29:43.696Z  PASS S3-E is DONE
2026-10-29T01:29:43.697Z  fake engine for S3-E: committed ca3d193d08f5763fe056d8d2a64304803e6abe58 on orbit/task-s3-e-only-commits-the-platform-land-b8debc; pushed nothing
2026-10-29T01:30:08.455Z  PASS S3-E's candidate source_sha = its commit — ca3d193d08f5763fe056d8d2a64304803e6abe58
2026-10-29T01:30:42.106Z  S3-E's CHECK_PROMOTION answered: READY -
2026-10-29T01:30:42.106Z  PASS the check by commit answered READY (no SOURCE_BRANCH_MISSING for the unpublished branch) — READY -
2026-10-29T01:30:42.107Z  PASS the runner was handed the check with sourceSha = the commit (wire log) — CHECK_PROMOTION TASK_BRANCH refs/heads/orbit/task-s3-e-only-commits-the-platform-land-b8debc sourceSha=ca3d193d08f5763fe056d8d2a64304803e6abe58
2026-10-29T01:30:42.198Z  S3-E's candidate 1677aad7-a124-48d2-af16-a78f01a16a88: READY
2026-10-29T01:30:42.222Z  owner confirms S3-E's candidate: {"ok":true,"answer":{"promotionId":"gOWCI6iLw7VzEDO3eFzIG","state":"CONFIRMED","sourceKind":"TASK_BRANCH","sourceRef":"refs/heads/orbit/task-s3-e-only-commits-the-platform-land-b8debc","sourceSha":"ca3d193d08f5763fe056d8d2a64304803e6abe58","upstreamRef":"refs/heads/main","commitsAhead":1,"filesChanged":1,"tasks":[{"taskId":"34o3qExS24PdtBEj9Dst4","title":"S3-E: only commits; the platform lands it"
2026-10-29T01:30:42.222Z  PASS the owner's confirmation is accepted
2026-10-29T01:30:45.315Z  S3-E's LAND_PROMOTION answered: LANDED - ca3d193d08f5763fe056d8d2a64304803e6abe58
2026-10-29T01:30:45.315Z  PASS LAND_PROMOTION landed it — LANDED - ca3d193d08f5763fe056d8d2a64304803e6abe58
2026-10-29T01:30:45.315Z  PASS the runner was handed the landing with sourceSha = the commit (wire log)
2026-10-29T01:30:45.361Z  PASS a MERGED receipt on main — MERGED main RUNNER
2026-10-29T01:31:07.591Z  PASS S3-E2 started by itself after the landing (J10) — session 395GoUcnjAHzo6qnripJa2
2026-10-29T01:31:07.647Z  PASS no candidate BLOCKED — 0
2026-10-29T01:31:07.692Z  PASS no SOURCE_BRANCH_MISSING — 0
2026-10-29T01:31:07.692Z  PASS the runner log shows no fetch of a task branch
2026-10-29T01:31:08.086Z  SCENARIO 3: all 22 checks passed
