-- `[K5]` criterion 7: one more §11.2 kind — a conclusion the loop could not make durable.
--
-- §13.2's consequences are applied by ONE action under a permanent key (§8.2). Until this unit its
-- refusals were terminal by accident: `pendingVerificationVerdicts` treated the mere EXISTENCE of a
-- row at that key as "already handled", so a refusal that was a race — a snapshot that moved under
-- the apply, a contended fact write — consumed the key for ever. DEP4's gate then stayed
-- `VERDICT_NOT_APPLIED`, every dependent stayed blocked, and no pass could propose the action
-- again. Safe, and permanently stopped.
--
-- The retry is now bounded (`VERDICT_APPLY_MAX_ATTEMPTS`, three passes against three freshly
-- captured worlds) and this is the row that says the bound was reached: the check HAS a verdict,
-- the subject can never pass, and a person has to look. Deliberately not `VERIFICATION_REQUIRED`
-- (there is a check), not `VERIFICATION_CANNOT_CONCLUDE` (there is a conclusion) and not
-- `COORDINATOR_UNAVAILABLE` (the coordinator is running and making passes) — each of those sends a
-- reader somewhere the problem is not.
--
-- DEPLOYMENT ORDER — this migration goes FIRST, on 0141's reasoning: the kind is a value only new
-- code writes, so an older replica cannot be harmed by the constraint accepting it. An older
-- replica that READS one falls to BL2's `UNKNOWN_FAILURE`, which is fail-closed and still puts the
-- project in front of a person.
ALTER TABLE "project_blocker" DROP CONSTRAINT "project_blocker_kind_chk";

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
  CHECK ("kind" IN (
    'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
    'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
    'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
    'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
    'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
    'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
    'VERIFICATION_CANNOT_CONCLUDE', 'ENVIRONMENT_BROKEN', 'HUMAN_DECISION_REQUIRED',
    'VERDICT_APPLY_EXHAUSTED',
    'UNKNOWN_FAILURE'
  ));
