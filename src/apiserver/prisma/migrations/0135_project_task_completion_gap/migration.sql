-- §13.1 AG7 / §13.2 V8: the two facts the aggregate-parent gate leaves behind, and the one action
-- that closes the half of them a machine can close.
--
-- 0132 made "a task its subtasks complete may never be dispatched" true at every ingress including
-- this one. What it could not do from the dispatch side is say what happens to such a task when the
-- recomputation that OWNS it has no answer either — every child settled without one finishing, or a
-- `VERIFICATION_PASSED` roll-up with nothing pointed at it. Both shapes are ordinary writes nobody
-- refuses, and both leave a row that is never dispatched, never completed and never mentioned.
--
-- Two additions, no rewrites:
--
--   1. Two kinds on `project_blocker_kind_chk`, so the gap can be a §11 row with an owner and a
--      required action instead of silence. Both are TASK-subject by construction (§11.3's default
--      dedupe key), which is what keeps them from becoming §11 BL1's "stop the whole project" —
--      the failure mode 0132 already had to route around with `STALE_SNAPSHOT`.
--   2. One `project_action_type`, so filing the missing verification is a durable, keyed, exactly
--      once action rather than a side effect of a reconcile that may run twice.
--
-- DEPLOYMENT ORDER — this migration goes FIRST, before the replicas that write either value.
-- That is the opposite order from 0134's, and for the mirror-image reason: 0134 taught the DATABASE
-- to refuse something the old code did, so the code had to stop doing it first. This teaches the
-- database to ACCEPT two values only the new code writes, so an old replica cannot be harmed by it
-- and a new replica that ran first would take a `23514` on the blocker insert and a `22P02` on the
-- action insert. Nothing here is destructive and nothing rewrites an existing row, so it is safe to
-- apply arbitrarily far ahead of the deploy.

ALTER TABLE "project_blocker" DROP CONSTRAINT "project_blocker_kind_chk";

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
  CHECK ("kind" IN (
    'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
    'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
    'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
    'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
    'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
    'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
    'UNKNOWN_FAILURE'
  ));

-- Appended rather than placed: enum ordinals are physical, and re-creating the type would have to
-- rewrite every `project_action` row and every view over it to move one label into the middle of a
-- list nothing reads in order.
ALTER TYPE "project_action_type" ADD VALUE IF NOT EXISTS 'FILE_VERIFICATION_TASK';
