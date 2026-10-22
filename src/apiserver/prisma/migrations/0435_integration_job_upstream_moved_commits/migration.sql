-- 0435 — the commits that moved the upstream under a LAND_PROMOTION
-- (docs/project-integration-line-contract.md §2.1's `upstream_moved_commits`, J-T4's
-- UpstreamMovedCommits interface, J-T13 and M-T12).
--
-- WHAT IT ADDS
-- ============
-- One nullable `jsonb` column on `project_integration_job`, written by the result route
-- (`runner-api/integration-job-relay.ts#applyIntegrationJobResult`) when a LAND_PROMOTION reports
-- that the upstream moved under it: the runner's `upstreamMovedCommits` — `{ total, commits }`,
-- first-parent, newest first, at most twenty, each `{ sha, subject }` — with the control plane's
-- own `outsideQueue` and `landedBy` added to every entry. NULL on every other job.
--
-- WHY NOT `error_detail`
-- ======================
-- That column is copied verbatim into an INTEGRATION_ERROR item's payload and into the delivery
-- text built from it (`projects/project-open-item.ts#integrationItemFacts`). The commit list is its
-- own field there instead, so the delivery text's byte-for-byte replay does not change (G6).
--
-- The numeric `project_promotion.upstream_moved_by` (0294, M-T7's "main moved N commits") is a
-- different fact and is not touched.
--
-- THE UNKNOWN-PUSH LOOKUP (J12)
-- =============================
-- Every heartbeat that claims a landing asks this table for the earlier PUSH_OUTCOME_UNKNOWN rows
-- on that job's serial key, so the job it hands out can check them. Those rows are rare — a job
-- ends that way only when a runner died or was abandoned past its lease — so a partial index over
-- exactly them keeps the question one index probe instead of a scan of every ERROR row.
--
-- LOCK
-- ====
-- One `ADD COLUMN` with no default (catalog-only): no table rewrite, no scan. One partial index
-- over the rows named above builds with a SHARE lock on a small set.

ALTER TABLE "project_integration_job"
  ADD COLUMN IF NOT EXISTS "upstream_moved_commits" jsonb;

CREATE INDEX IF NOT EXISTS "project_integration_job_unknown_push_idx"
    ON "project_integration_job" ("owner_id", "serial_key", "tested_sha")
 WHERE "state" = 'ERROR' AND "error_code" = 'PUSH_OUTCOME_UNKNOWN';
