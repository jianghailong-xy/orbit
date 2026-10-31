2026-10-29T01:56:22.838Z  stack b after the deploy: apiserver new, runner 0.1.239 (not restarted)
2026-10-29T01:57:42.884Z  PASS [5] the old runner heartbeats to the new apiserver without integration-observe/v1 — 3 heartbeats, version 0.1.239
2026-10-29T01:57:42.943Z  PASS [5] the backfill's OBSERVE_LANDING stays QUEUED, unclaimed — QUEUED - -
2026-10-29T01:57:45.274Z  PASS [5] S5-H is DONE
2026-10-29T01:57:45.274Z  fake engine for S5-H: committed 027820cf91fe356e564c7e92da682e9ded6e66fb on orbit/task-s5-h-publishes-its-task-branch-4a838a; published it (exit 0)
2026-10-29T01:58:12.877Z  PASS [5] S5-H's check on the old runner answered READY — READY -
2026-10-29T01:58:12.877Z  PASS [5] the CHECK_PROMOTION handed to the old runner carries no sourceSha (old shape: it fetches the branch) — refs/heads/orbit/task-s5-h-publishes-its-task-branch-4a838a sourceSha=(absent)
2026-10-29T01:58:12.927Z  PASS [5] the candidate row itself is named by the delivered commit — 027820cf91fe356e564c7e92da682e9ded6e66fb
2026-10-29T01:58:12.999Z  PASS [5] the owner confirms S5-H's candidate
2026-10-29T01:58:16.108Z  PASS [5] LAND_PROMOTION on the old runner landed it — LANDED -
2026-10-29T01:58:16.156Z  PASS [5] a MERGED receipt on main — MERGED main RUNNER
2026-10-29T01:58:22.241Z  PASS [5] S5-H2 started by itself after the landing (J9, J10 unchanged for the old runner)
2026-10-29T01:58:24.316Z  PASS [5] S5-I is DONE
2026-10-29T01:59:43.949Z  PASS [5] an unpublished branch still answers SOURCE_BRANCH_MISSING on the old runner (today's behaviour) — ERROR SOURCE_BRANCH_MISSING
2026-10-29T02:00:18.954Z  PASS [5] no OBSERVE_LANDING was ever handed to the old runner — 12 heartbeats since the deploy
2026-10-29T02:00:18.954Z  PASS [5] no CHECK_PROMOTION named by its commit was handed to the old runner
2026-10-29T02:00:19.000Z  PASS [5] S4's observation is still QUEUED after all of this — QUEUED -
2026-10-29T02:00:19.576Z  SCENARIO 5: all 15 checks passed
2026-10-29T02:01:22.201Z  S5-I's candidate before the retry: BLOCKED ERROR
2026-10-29T02:01:22.216Z  owner retries it: {"ok":true,"answer":{"promotionId":"5F0Exi3ML1UVkyNkX08V1M","jobId":"3AJfZtMGVIBBApX8csEaG9","generation":2,"landingSessionId":"b70f9be7-81b4-4eb6-80ce-ecd3db4da0a3","retryOfJobId":"2aLOsI7upBth0wGGTB3Fhb","failureClass":"ERROR","reason":"The runner is upgraded; check the delivered commit.","handlingItemIds":["34o4aWE7EPnLoRtAsx5dj"],"promotionPublicId":"5F0Exi3ML1UVkyNkX08V1M","retryOfJobPublicId
2026-10-29T02:01:22.216Z  PASS [5-after] the owner's retry is accepted
2026-10-29T02:01:25.323Z  PASS [5-after] checked by its commit on the upgraded runner: READY — READY -
2026-10-29T02:01:25.324Z  PASS [5-after] the retried check was handed over with sourceSha — sourceSha=3fb34ae12547f465da2a82ed4f13fbac6bfd0e9d; sourceSha=ce7b944a3b290c7998c7fcced8af946b543c4211
2026-10-29T02:01:28.127Z  SCENARIO 5 after the upgrade: all 3 checks passed
