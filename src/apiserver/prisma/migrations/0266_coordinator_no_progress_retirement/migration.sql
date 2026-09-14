-- Resolve, once, the COORDINATOR_NO_PROGRESS blockers the retired coordinator breaker left open.
--
-- WHY THESE ROWS NEED A PASS OF THEIR OWN
-- =======================================
-- The coordinator breaker raised this kind when a project's wakes stopped moving its progress
-- vector. The breaker is gone: a wake is now recorded and always allowed, what pauses a coordinator
-- is its own spend (`CoordinatorConvergenceService.assessSpend`), and nothing raises the kind any
-- more. So a row it raised has no condition left that could clear it, and no code resolves one.
-- The project list's attention read counts every open blocker, so each of these kept its project
-- under Needs you · Critical for good. On 2026-09-13 production held 8 open, 6 of them on projects
-- already DONE.
--
-- WHY A MIGRATION
-- ===============
-- The population is closed. This ships only with code that no longer raises the kind, so nothing
-- written after it can join. A deployment rolled back to an image that still has the breaker can
-- raise them again, and this pass will not see those.
--
-- WHAT IS WRITTEN
-- ===============
-- `resolved_at` and `updated_at` now, and `resolved_by` AUTO: the resolution a producer writes when
-- a blocker's condition is gone. The rows stay, as the record that the breaker once stopped these
-- projects. Only open rows are matched: a resolved episode is terminal, and
-- `project_blocker_resolution_final` refuses to rewrite one. No other kind is touched.
--
-- Running it again changes nothing.
UPDATE "project_blocker"
   SET "resolved_at" = now(),
       "resolved_by" = 'AUTO',
       "updated_at"  = now()
 WHERE "kind" = 'COORDINATOR_NO_PROGRESS'
   AND "resolved_at" IS NULL;
