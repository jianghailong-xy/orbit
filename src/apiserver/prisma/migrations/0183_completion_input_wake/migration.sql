-- Completion is driven by immutable criterion inputs, not by Session lifecycle or task-set
-- emptiness. Reuse the wake ledger's partial-unique identity/retry rule, while naming consumers
-- that are not coordinator Sessions.

ALTER TABLE "project_coordinator_wake"
  ADD COLUMN IF NOT EXISTS "consumer_type" TEXT,
  ADD COLUMN IF NOT EXISTS "consumed_at" TIMESTAMP(3);

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_event_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_event_chk" CHECK ("event" IN (
    'ATTEMPT_ENDED_UNSETTLED',
    'ATTEMPT_BUDGET_SPENT',
    'PROJECT_TASKS_SETTLED',
    'CRITERION_READY',
    'COMPLETION_EVIDENCE_REVISED',
    'EXECUTABLE_RESULT_RECORDED',
    'VERIFICATION_VERDICT_RECORDED',
    'HUMAN_SIGNOFF_REQUESTED',
    'HUMAN_SIGNOFF_DECIDED',
    'HUMAN_SIGNOFF_REQUEST_SUPERSEDED'
  ));

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_subject_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_subject_chk" CHECK ("subject_type" IN (
    'TASK', 'PROJECT', 'CRITERION', 'JUDGMENT_REQUEST'
  ));

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_status_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_status_chk"
  CHECK ("status" IN ('CLAIMED', 'SESSION_OPENED', 'CONSUMED', 'REFUSED'));

ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_consumer_type_chk" CHECK (
    "consumer_type" IS NULL OR "consumer_type" IN (
      'JUDGMENT_REQUEST_DERIVER',
      'DERIVED_COMPLETION_EVALUATOR',
      'SYSTEM_EXECUTABLE_EVALUATOR',
      'VERIFIER_TASK',
      'HUMAN_INBOX'
    )
  ),
  ADD CONSTRAINT "project_coordinator_wake_consumed_chk" CHECK (
    ("status" = 'CONSUMED' AND "consumer_type" IS NOT NULL AND "consumed_at" IS NOT NULL)
    OR
    ("status" <> 'CONSUMED' AND "consumer_type" IS NULL AND "consumed_at" IS NULL)
  );

COMMENT ON COLUMN "project_coordinator_wake"."consumer_type" IS
  'Criterion-input consumer; HUMAN_INBOX is a human route and never a Session.';
COMMENT ON COLUMN "project_coordinator_wake"."consumed_at" IS
  'Set by the CLAIMED-to-CONSUMED CAS after the named consumer succeeds.';
