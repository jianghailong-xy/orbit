-- N24: evidence submitted after a Task is already DONE remains a first-class revision, but it
-- cannot raise a question nobody is authorised to answer. The request is retained and moves from
-- OPEN to SUPERSEDED in the evidence transaction under an explicit TASK_ALREADY_DONE rule.
--
-- `superseded_by_id` keeps its existing meaning: the successor request for a newer evidence
-- revision. A rule that says no question exists has no successor, so its actor, source Session and
-- rule are stored separately on the same monotone request row.
CREATE TYPE "task_judgment_supersession_rule" AS ENUM (
  'EVIDENCE_REVISED', 'TASK_ALREADY_DONE'
);

ALTER TABLE "task_judgment_request"
  ADD COLUMN "supersession_rule" "task_judgment_supersession_rule",
  ADD COLUMN "superseded_actor_type" "creator_type",
  ADD COLUMN "superseded_actor_id" uuid,
  ADD COLUMN "superseded_source_session_id" uuid;

ALTER TABLE "task_judgment_request"
  DROP CONSTRAINT "task_judgment_request_lifecycle";

-- Existing SUPERSEDED rows predate transition provenance and remain valid as legacy successor
-- links. Every transition made by the new writer is complete: rule, actor and source Session are
-- all present, and only TASK_ALREADY_DONE is allowed to have no successor request.
ALTER TABLE "task_judgment_request"
  ADD CONSTRAINT "task_judgment_request_lifecycle" CHECK (
    ("status" = 'OPEN' AND "decided_at" IS NULL AND "decided_by_type" IS NULL
      AND "decided_by_id" IS NULL AND "decision" IS NULL
      AND "superseded_at" IS NULL AND "superseded_by_id" IS NULL
      AND "supersession_rule" IS NULL AND "superseded_actor_type" IS NULL
      AND "superseded_actor_id" IS NULL AND "superseded_source_session_id" IS NULL) OR
    ("status" = 'DECIDED' AND "decided_at" IS NOT NULL AND "decided_by_type" IS NOT NULL
      AND length(btrim("decided_by_type")) > 0 AND "decided_by_id" IS NOT NULL
      AND length(btrim("decided_by_id")) > 0 AND "decision" IS NOT NULL
      AND "superseded_at" IS NULL AND "superseded_by_id" IS NULL
      AND "supersession_rule" IS NULL AND "superseded_actor_type" IS NULL
      AND "superseded_actor_id" IS NULL AND "superseded_source_session_id" IS NULL) OR
    ("status" = 'SUPERSEDED' AND "decided_at" IS NULL AND "decided_by_type" IS NULL
      AND "decided_by_id" IS NULL AND "decision" IS NULL AND "superseded_at" IS NOT NULL
      AND (
        ("superseded_by_id" IS NOT NULL AND "supersession_rule" IS NULL
          AND "superseded_actor_type" IS NULL AND "superseded_actor_id" IS NULL
          AND "superseded_source_session_id" IS NULL) OR
        ("superseded_by_id" IS NOT NULL AND "supersession_rule" = 'EVIDENCE_REVISED'
          AND "superseded_actor_type" IS NOT NULL AND "superseded_actor_id" IS NOT NULL
          AND "superseded_source_session_id" IS NOT NULL) OR
        ("superseded_by_id" IS NULL AND "supersession_rule" = 'TASK_ALREADY_DONE'
          AND "superseded_actor_type" IS NOT NULL AND "superseded_actor_id" IS NOT NULL
          AND "superseded_source_session_id" IS NOT NULL)
      ))
  );

-- Keep 0183's decision guards unchanged and widen only the SUPERSEDED branch. A raw writer cannot
-- use the terminal rule as a generic close button: the subject Task is locked by the application
-- writer and this database boundary independently requires its current status to be DONE. New
-- provenance is a snapshot (like completion evidence's actor/source ids), so retention cannot
-- erase it or make a later replay fail. The explicit repair service validates its live source
-- Session before writing; legacy successor links keep the exact 0183 validation so a rolling
-- deploy does not strand an older writer.
CREATE OR REPLACE FUNCTION "task_judgment_request_transition_guard"() RETURNS trigger AS $$
DECLARE successor "task_judgment_request"%ROWTYPE;
BEGIN
  IF ROW(NEW."task_id", NEW."owner_id", NEW."evidence_id", NEW."criterion_revision",
         NEW."evidence_digest", NEW."kind", NEW."recipient_type", NEW."recipient_id",
         NEW."created_at") IS DISTINCT FROM
     ROW(OLD."task_id", OLD."owner_id", OLD."evidence_id", OLD."criterion_revision",
         OLD."evidence_digest", OLD."kind", OLD."recipient_type", OLD."recipient_id",
         OLD."created_at") THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_TERMINAL_IMMUTABLE';
  END IF;
  IF NEW."status" = 'OPEN' THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_OPEN_UPDATE_REFUSED';
  ELSIF NEW."status" = 'SUPERSEDED' THEN
    IF NEW."supersession_rule" IS NULL OR NEW."supersession_rule" = 'EVIDENCE_REVISED' THEN
      SELECT * INTO successor FROM "task_judgment_request"
       WHERE "id" = NEW."superseded_by_id";
      IF NOT FOUND OR successor."task_id" <> NEW."task_id"
         OR successor."status" <> 'OPEN' OR successor."created_at" < OLD."created_at" THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_INVALID_SUCCESSOR';
      END IF;
    ELSIF NEW."supersession_rule" = 'TASK_ALREADY_DONE' THEN
      IF NEW."superseded_by_id" IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM "task" task
         WHERE task."id" = NEW."task_id" AND task."owner_id" = NEW."owner_id"
           AND task."status" = 'DONE'
      ) THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_DONE_RULE_REQUIRES_DONE_TASK';
      END IF;
    END IF;

    IF NEW."supersession_rule" IS NOT NULL
       AND NEW."superseded_actor_type" = 'USER'
       AND NEW."superseded_actor_id" <> NEW."owner_id" THEN
      RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_SUPERSESSION_ACTOR_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'EXECUTABLE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task_executable_judgment_result" result
       WHERE result."request_id" = NEW."id"
         AND CASE WHEN result."actual_exit_code" = result."expected_exit_code"
                  THEN 'PASS'::"task_judgment_decision"
                  ELSE 'FAIL'::"task_judgment_decision" END = NEW."decision"
    ) THEN
      RAISE EXCEPTION 'TASK_EXECUTABLE_JUDGMENT_RESULT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'VERIFICATION' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task" verifier
       WHERE verifier."id" = NEW."recipient_id"::uuid
         AND verifier."verifies_task_id" = NEW."task_id"
         AND verifier."verdict"::text = NEW."decision"::text
    ) THEN
      RAISE EXCEPTION 'TASK_VERIFIER_VERDICT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'HUMAN_SIGNOFF' AND NEW."decision" = 'PASS' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task_human_signoff" signoff
       WHERE signoff."request_id" = NEW."id"
         AND signoff."task_id" = NEW."task_id"
         AND signoff."evidence_digest" = NEW."evidence_digest"
         AND signoff."signed_by_id"::text = NEW."recipient_id"
    ) THEN
      RAISE EXCEPTION 'TASK_HUMAN_SIGNOFF_EVENT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'HUMAN_SIGNOFF' AND NEW."decision" = 'INCONCLUSIVE' THEN
    IF NEW."decided_by_type" <> 'USER'
       OR NEW."decided_by_id" <> NEW."recipient_id"
       OR length(btrim(NEW."decision_note")) = 0 THEN
      RAISE EXCEPTION 'TASK_HUMAN_EVIDENCE_REQUEST_AUDIT_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN "task_judgment_request"."supersession_rule" IS
  'Why the request became SUPERSEDED; TASK_ALREADY_DONE is the only no-successor terminal rule.';
COMMENT ON COLUMN "task_judgment_request"."superseded_actor_type" IS
  'Snapshot of the principal type that caused this request supersession.';
COMMENT ON COLUMN "task_judgment_request"."superseded_actor_id" IS
  'Snapshot of the principal id that caused this request supersession.';
COMMENT ON COLUMN "task_judgment_request"."superseded_source_session_id" IS
  'Snapshot of the Session from which this request supersession was caused.';
