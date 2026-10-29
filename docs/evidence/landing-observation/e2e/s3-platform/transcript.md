2026-10-29T02:17:15.948Z  project 34o51E8MSi0Nq05bVfUMj started: line MAIN, deliveryMode PLATFORM (never chosen: true), Automatic off
2026-10-29T02:17:15.948Z  PASS the project is PLATFORM by default
2026-10-29T02:17:18.000Z  PASS S3-F is DONE
2026-10-29T02:17:18.000Z  fake engine for S3-F: committed 805d6d9f8a86b3093644323f27eff11c92df4314 on orbit/task-s3-f-pushes-its-work-straight-to-ma-ff7c30, pushed it to origin/main (E2E-UPSTREAM)
2026-10-29T02:17:18.004Z  PASS origin main is F's commit; no task branch on the origin
2026-10-29T02:17:40.719Z  PASS candidate source_sha = delivered_sha (O-L5) — 805d6d9f8a86b3093644323f27eff11c92df4314
2026-10-29T02:17:43.831Z  S3-F's CHECK_PROMOTION answered: ALREADY_LANDED -
2026-10-29T02:17:43.832Z  PASS the check answered ALREADY_LANDED — ALREADY_LANDED -
2026-10-29T02:17:43.878Z  PASS the candidate is SUPERSEDED, not BLOCKED — SUPERSEDED -
2026-10-29T02:17:43.925Z  PASS a receipt: ALREADY_MERGED on main, by the RUNNER, detail.observed + integrationJobId — ALREADY_MERGED main RUNNER 805d6d9f8a86b3093644323f27eff11c92df4314 {"observed": true, "integrationJobId": "81e80389-3865-4a58-8d92-635edc0e6e00"}
2026-10-29T02:17:43.939Z  PASS LANDED_WITHOUT_CONFIRMATION is the owner's, titled for the task — OWNER: Reached main without your confirmation: S3-F: pushes its work straight to main
2026-10-29T02:17:43.939Z  PASS it offers Accept — ["ACCEPT","OPEN_TASK_SESSION"]
2026-10-29T02:17:43.950Z  PASS S3-F2 started by itself (J9 released by the check's receipt, J10) — session 29JmC5rnW2mAWiKEFFyncj
2026-10-29T02:17:46.010Z  PASS S3-E is DONE
2026-10-29T02:17:46.010Z  fake engine for S3-E: committed de7c79df43bbd9d2fb8eb78092692dc11d6ea937 on orbit/task-s3-e-only-commits-the-platform-land-bd5990; pushed nothing
2026-10-29T02:18:10.763Z  PASS S3-E's candidate source_sha = its commit — de7c79df43bbd9d2fb8eb78092692dc11d6ea937
2026-10-29T02:18:44.494Z  S3-E's CHECK_PROMOTION answered: READY -
2026-10-29T02:18:44.494Z  PASS the check by commit answered READY (no SOURCE_BRANCH_MISSING for the unpublished branch) — READY -
2026-10-29T02:18:44.494Z  PASS the runner was handed the check with sourceSha = the commit (wire log) — CHECK_PROMOTION TASK_BRANCH refs/heads/orbit/task-s3-e-only-commits-the-platform-land-bd5990 sourceSha=de7c79df43bbd9d2fb8eb78092692dc11d6ea937
2026-10-29T02:18:44.582Z  S3-E's candidate e1befa47-d0e4-454c-9ed7-e67907cab2c9: READY
2026-10-29T02:18:44.605Z  owner confirms S3-E's candidate: {"ok":true,"answer":{"promotionId":"6ryY8Wm9Eg9Loh2gyywPQf","state":"CONFIRMED","sourceKind":"TASK_BRANCH","sourceRef":"refs/heads/orbit/task-s3-e-only-commits-the-platform-land-bd5990","sourceSha":"de7c79df43bbd9d2fb8eb78092692dc11d6ea937","upstreamRef":"refs/heads/main","commitsAhead":1,"filesChanged":1,"tasks":[{"taskId":"34o51EHKMerLt46xpDP0s","title":"S3-E: only commits; the platform lands it
2026-10-29T02:18:44.605Z  PASS the owner's confirmation is accepted
2026-10-29T02:18:47.695Z  S3-E's LAND_PROMOTION answered: LANDED - de7c79df43bbd9d2fb8eb78092692dc11d6ea937
2026-10-29T02:18:47.696Z  PASS LAND_PROMOTION landed it — LANDED - de7c79df43bbd9d2fb8eb78092692dc11d6ea937
2026-10-29T02:18:47.696Z  PASS the runner was handed the landing with sourceSha = the commit (wire log)
2026-10-29T02:18:47.743Z  PASS a MERGED receipt on main — MERGED main RUNNER
2026-10-29T02:19:09.984Z  PASS S3-E2 started by itself after the landing (J10) — session 5VBdmojDsKvo3gIQl6gigD
2026-10-29T02:19:12.058Z  PASS no candidate BLOCKED — 0
2026-10-29T02:19:12.104Z  PASS no SOURCE_BRANCH_MISSING — 0
2026-10-29T02:19:12.104Z  PASS the runner log shows no fetch of a task branch
2026-10-29T02:19:12.542Z  SCENARIO 3: all 22 checks passed
