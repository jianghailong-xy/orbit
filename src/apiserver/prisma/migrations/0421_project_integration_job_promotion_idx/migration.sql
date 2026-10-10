-- A promotion's next generation is `max(generation)` over the jobs of its own candidate, read
-- inside the transaction that enqueues it (`enqueuePromotionJob` in
-- projects/project-integration-job.ts, kind PROMOTE).
--
-- Nothing indexed `promotion_id`, so PostgreSQL answered that maximum by reading the whole table:
-- measured on a 300,020-row `project_integration_job` (production DDL, PostgreSQL 16.15), a parallel
-- sequential scan of every row — 4,919 buffers, `Rows Removed by Filter` in six figures — to return
-- seven rows. With this index the same `max()` is an Index Scan over the candidate's own jobs, in 4
-- buffers.
--
-- PARTIAL over rows that name a candidate. The enqueuer of a landing writes no `promotion_id`
-- (`enqueueLanding`'s INSERT sets `task_id` and leaves this column null), so the index holds
-- promotions only and stays small however many landings the table accumulates. 0353 made the same
-- choice for `project_open_item`, which a closing candidate is looked up in by `promotion_id`.
--
-- WHAT IT COSTS: one index entry for each promotion job, and one more index to maintain on each
-- landing INSERT — which is the row count the partial predicate does not exclude. That is the price
-- of the maximum being a probe instead of a scan; a promotion is rare (one per merge attempt) while
-- the scan it replaced grows with every landing the deployment has ever run.
--
-- Deliberately not CONCURRENTLY, as with 0283, 0305, 0353, 0361 and 0417: Prisma runs the migration
-- in a transaction. If NOT EXISTS lets a deployment pre-create the identical index CONCURRENTLY,
-- which makes this a no-op.
CREATE INDEX IF NOT EXISTS "project_integration_job_promotion_idx"
  ON "project_integration_job" ("promotion_id")
  WHERE "promotion_id" IS NOT NULL;
