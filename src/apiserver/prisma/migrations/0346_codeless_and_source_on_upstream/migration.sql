-- 0346 — work that has nothing to land stops holding its criterion off LANDED, on facts rather than
-- on hope (project-close redo, D1).
--
-- WHAT IT ADDS
-- ============
--   * `task.codeless_reason`: why a task that already existed was declared `codeless` (0231's SR5
--     escape hatch). Declaring it at creation is the first statement of what the task is and needs
--     none; turning an existing task codeless takes it out of its criterion's landing conjunction,
--     so the doors (task_update over MCP, CLI and the runner API) refuse it without a reason, and
--     refuse it outright for a task that already has commits of its own. NULL on every task that
--     is not codeless, and on one that was created codeless.
--   * `project_integration_job.source_on_upstream`: the runner's own measurement, taken when it
--     answers NOTHING_TO_LAND, of whether the source branch's tip is an ancestor of the upstream
--     (`git merge-base --is-ancestor <source> <upstream>`). §1.4 lets a NOTHING_TO_LAND out of a
--     criterion's roll-up only when this is true. Until now that was inferred, and only where the
--     line was the upstream itself (`target_sha_before = upstream_sha`, no main sync) — which a
--     project branch stops being after its first landing, so a zero-commit task on such a line
--     held its criterion at ON_INTEGRATION_LINE for ever (2026-10-01, project
--     34WzvgkHWbY1VwXmSPUZi, its rollout task). NULL means the runner did not measure it: every
--     row written before this, every other answer, and any runner older than this one.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default and no constraint: catalog-only, no row is rewritten,
-- backfilled or refused. A NOTHING_TO_LAND already stored reads NULL, which §1.4 reads as "not
-- measured" and withholds on — a state, a session or a task status is not the fact, since a session
-- that died and work that went to another branch are answered NOTHING_TO_LAND too.

ALTER TABLE "task" ADD COLUMN "codeless_reason" text;

ALTER TABLE "project_integration_job" ADD COLUMN "source_on_upstream" boolean;
