-- N11: the question raised by one completion-evidence version is a durable fact. Request kind is
-- selected once from the declared criterion; the lifecycle is monotonic and never falls through
-- from executable or verification to a human request.
CREATE TYPE "task_judgment_request_status" AS ENUM ('OPEN', 'DECIDED', 'SUPERSEDED');
CREATE TYPE "task_judgment_recipient_type" AS ENUM (
  'SYSTEM_EXECUTABLE_EVALUATOR', 'VERIFIER_TASK', 'ACCOUNT_OWNER'
);
CREATE TYPE "task_judgment_decision" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');

ALTER TABLE "task_completion_evidence"
  ADD CONSTRAINT "task_completion_evidence_bound_fact_key"
  UNIQUE ("id", "task_id", "criterion_revision", "evidence_digest");

CREATE TABLE "task_judgment_request" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "evidence_id" uuid NOT NULL,
  "criterion_revision" char(64) NOT NULL,
  "evidence_digest" char(64) NOT NULL,
  "kind" "task_completion_criterion" NOT NULL,
  "recipient_type" "task_judgment_recipient_type" NOT NULL,
  "recipient_id" text NOT NULL,
  "status" "task_judgment_request_status" NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  "decided_by_type" text,
  "decided_by_id" text,
  "decision" "task_judgment_decision",
  "superseded_at" TIMESTAMP(3),
  "superseded_by_id" uuid,

  CONSTRAINT "task_judgment_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_judgment_request_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_request_evidence_fact_fkey"
    FOREIGN KEY ("evidence_id", "task_id", "criterion_revision", "evidence_digest")
    REFERENCES "task_completion_evidence"("id", "task_id", "criterion_revision", "evidence_digest")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_request_superseded_by_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "task_judgment_request"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_request_recipient_nonblank"
    CHECK (length(btrim("recipient_id")) > 0),
  CONSTRAINT "task_judgment_request_recipient_uuid"
    CHECK ("recipient_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "task_judgment_request_digest_shape"
    CHECK ("criterion_revision" ~ '^[0-9a-f]{64}$' AND "evidence_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_judgment_request_recipient_matches_kind" CHECK (
    ("kind" = 'EXECUTABLE' AND "recipient_type" = 'SYSTEM_EXECUTABLE_EVALUATOR') OR
    ("kind" = 'VERIFICATION' AND "recipient_type" = 'VERIFIER_TASK'
      AND "recipient_id" = "id"::text) OR
    ("kind" = 'HUMAN_SIGNOFF' AND "recipient_type" = 'ACCOUNT_OWNER'
      AND "recipient_id" = "owner_id"::text)
  ),
  CONSTRAINT "task_judgment_request_lifecycle" CHECK (
    ("status" = 'OPEN' AND "decided_at" IS NULL AND "decided_by_type" IS NULL
      AND "decided_by_id" IS NULL AND "decision" IS NULL
      AND "superseded_at" IS NULL AND "superseded_by_id" IS NULL) OR
    ("status" = 'DECIDED' AND "decided_at" IS NOT NULL AND "decided_by_type" IS NOT NULL
      AND length(btrim("decided_by_type")) > 0 AND "decided_by_id" IS NOT NULL
      AND length(btrim("decided_by_id")) > 0 AND "decision" IS NOT NULL
      AND "superseded_at" IS NULL AND "superseded_by_id" IS NULL) OR
    ("status" = 'SUPERSEDED' AND "decided_at" IS NULL AND "decided_by_type" IS NULL
      AND "decided_by_id" IS NULL AND "decision" IS NULL
      AND "superseded_at" IS NOT NULL AND "superseded_by_id" IS NOT NULL)
  ),
  CONSTRAINT "task_judgment_request_decider_matches_kind" CHECK (
    "status" <> 'DECIDED' OR
    ("kind" = 'EXECUTABLE' AND "decided_by_type" = 'SYSTEM'
      AND "decision" IN ('PASS', 'FAIL')) OR
    ("kind" = 'VERIFICATION' AND "decided_by_type" IN ('USER', 'AGENT')) OR
    ("kind" = 'HUMAN_SIGNOFF' AND "decided_by_type" = 'USER'
      AND "decided_by_id" = "recipient_id" AND "decision" = 'PASS')
  ),
  CONSTRAINT "task_judgment_request_id_task_digest_key"
    UNIQUE ("id", "task_id", "evidence_digest"),
  CONSTRAINT "task_judgment_request_fact_key"
    UNIQUE ("task_id", "criterion_revision", "evidence_digest", "kind")
);

CREATE INDEX "task_judgment_request_task_status_idx"
  ON "task_judgment_request"("task_id", "status", "created_at" DESC);
CREATE INDEX "task_judgment_request_recipient_idx"
  ON "task_judgment_request"("owner_id", "recipient_type", "recipient_id", "status");
CREATE INDEX "task_judgment_request_superseded_by_idx"
  ON "task_judgment_request"("superseded_by_id");

CREATE TABLE "task_executable_judgment_result" (
  "id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "command" text NOT NULL,
  "expected_exit_code" integer NOT NULL,
  "actual_exit_code" integer NOT NULL,
  "raw_output" text NOT NULL,
  "recorded_by_id" text NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_executable_judgment_result_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_executable_judgment_result_request_id_key" UNIQUE ("request_id"),
  CONSTRAINT "task_executable_judgment_result_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "task_judgment_request"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_executable_judgment_result_actor_nonblank"
    CHECK (length(btrim("recorded_by_id")) > 0)
);
CREATE INDEX "task_executable_judgment_result_recorded_idx"
  ON "task_executable_judgment_result"("recorded_at" DESC);

-- N2's signoff event is now pinned to the exact OPEN request and evidence digest it decides.
ALTER TABLE "task_human_signoff"
  ADD COLUMN "request_id" uuid,
  ADD COLUMN "evidence_digest" char(64);

-- A deployment may have accepted N2 signoffs before N11 reaches it. Preserve those decisions as
-- explicitly labelled legacy evidence/request facts instead of making ADD NOT NULL fail or
-- pretending the old event never happened. source_session_id is an immutable provenance snapshot
-- with no FK by design; the signoff event id is therefore an honest stable legacy source token.
WITH legacy AS (
  SELECT s."id", s."task_id", t."owner_id", s."signed_by_id", s."signed_at", s."evidence",
         md5('legacy-human-signoff-criterion-v1') ||
           md5('legacy-human-signoff-criterion-v1') AS "criterion_revision",
         md5(convert_to(s."evidence", 'UTF8')) ||
           md5(convert_to(s."evidence", 'UTF8')) AS "evidence_digest"
    FROM "task_human_signoff" s
    JOIN "task" t ON t."id" = s."task_id"
)
INSERT INTO "task_completion_evidence" (
  "id", "task_id", "owner_id", "actor_type", "actor_id", "submitted_at",
  "source_session_id", "criterion_revision", "criterion", "evidence", "evidence_digest", "revision"
)
SELECT legacy."id", legacy."task_id", legacy."owner_id", 'USER'::"creator_type",
       legacy."signed_by_id", legacy."signed_at", legacy."id", legacy."criterion_revision",
       jsonb_build_object('completionCriterion', 'HUMAN_SIGNOFF', 'legacy', true),
       jsonb_build_object('legacyHumanSignoffEvidence', legacy."evidence"),
       legacy."evidence_digest",
       COALESCE((SELECT max(existing."revision") FROM "task_completion_evidence" existing
                  WHERE existing."task_id" = legacy."task_id"), 0) + 1
  FROM legacy;

WITH legacy AS (
  SELECT s."id", s."task_id", t."owner_id", s."signed_by_id", s."signed_at",
         md5('legacy-human-signoff-criterion-v1') ||
           md5('legacy-human-signoff-criterion-v1') AS "criterion_revision",
         md5(convert_to(s."evidence", 'UTF8')) ||
           md5(convert_to(s."evidence", 'UTF8')) AS "evidence_digest"
    FROM "task_human_signoff" s
    JOIN "task" t ON t."id" = s."task_id"
)
INSERT INTO "task_judgment_request" (
  "id", "task_id", "owner_id", "evidence_id", "criterion_revision", "evidence_digest",
  "kind", "recipient_type", "recipient_id", "status", "created_at", "decided_at",
  "decided_by_type", "decided_by_id", "decision"
)
SELECT legacy."id", legacy."task_id", legacy."owner_id", legacy."id",
       legacy."criterion_revision", legacy."evidence_digest", 'HUMAN_SIGNOFF', 'ACCOUNT_OWNER',
       legacy."signed_by_id"::text, 'DECIDED', legacy."signed_at", legacy."signed_at",
       'USER', legacy."signed_by_id"::text, 'PASS'
  FROM legacy;

UPDATE "task_human_signoff" signoff
   SET "request_id" = request."id", "evidence_digest" = request."evidence_digest"
  FROM "task_judgment_request" request
 WHERE request."id" = signoff."id" AND request."kind" = 'HUMAN_SIGNOFF';

ALTER TABLE "task_human_signoff"
  ALTER COLUMN "request_id" SET NOT NULL,
  ALTER COLUMN "evidence_digest" SET NOT NULL,
  ADD CONSTRAINT "task_human_signoff_request_id_key" UNIQUE ("request_id"),
  ADD CONSTRAINT "task_human_signoff_request_fact_key"
    UNIQUE ("request_id", "task_id", "evidence_digest"),
  ADD CONSTRAINT "task_human_signoff_digest_shape"
    CHECK ("evidence_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "task_human_signoff_request_fact_fkey"
    FOREIGN KEY ("request_id", "task_id", "evidence_digest")
    REFERENCES "task_judgment_request"("id", "task_id", "evidence_digest")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- N10 could likewise have accepted evidence before this router existed. Give every distinct
-- evidence fact one request, choosing the newest identical revision as the canonical evidence row.
-- The criterion snapshot carries N11's explicit kind; older N10 snapshots use the task's declared
-- value added by N2. This is migration compatibility, not a runtime fallback chain.
WITH candidates AS (
  SELECT DISTINCT ON (
           evidence."task_id", evidence."criterion_revision", evidence."evidence_digest", kind."value"
         )
         evidence.*,
         kind."value"::"task_completion_criterion" AS "request_kind"
    FROM "task_completion_evidence" evidence
    JOIN "task" task ON task."id" = evidence."task_id"
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        evidence."criterion"->>'completionCriterion', task."completion_criterion"::text
      ) AS "value"
    ) kind
   WHERE NOT EXISTS (
     SELECT 1 FROM "task_judgment_request" request
      WHERE request."task_id" = evidence."task_id"
        AND request."criterion_revision" = evidence."criterion_revision"
        AND request."evidence_digest" = evidence."evidence_digest"
        AND request."kind"::text = kind."value"
   )
   ORDER BY evidence."task_id", evidence."criterion_revision", evidence."evidence_digest",
            kind."value", evidence."revision" DESC, evidence."id" DESC
)
INSERT INTO "task_judgment_request" (
  "id", "task_id", "owner_id", "evidence_id", "criterion_revision", "evidence_digest",
  "kind", "recipient_type", "recipient_id", "created_at"
)
SELECT candidates."id", candidates."task_id", candidates."owner_id", candidates."id",
       candidates."criterion_revision", candidates."evidence_digest", candidates."request_kind",
       CASE candidates."request_kind"
         WHEN 'EXECUTABLE' THEN 'SYSTEM_EXECUTABLE_EVALUATOR'
         WHEN 'VERIFICATION' THEN 'VERIFIER_TASK'
         WHEN 'HUMAN_SIGNOFF' THEN 'ACCOUNT_OWNER'
       END::"task_judgment_recipient_type",
       CASE candidates."request_kind"
         WHEN 'EXECUTABLE' THEN candidates."source_session_id"::text
         WHEN 'VERIFICATION' THEN candidates."id"::text
         WHEN 'HUMAN_SIGNOFF' THEN candidates."owner_id"::text
       END,
       candidates."submitted_at"
  FROM candidates;

-- Only the newest evidence request for one task remains actionable. Historical evidence and its
-- request stay queryable; they become terminal facts linked to the request representing the newest
-- evidence version. A legacy DECIDED signoff may be that newest request.
WITH newest AS (
  SELECT DISTINCT ON (request."task_id")
         request."task_id", request."id", request."created_at"
    FROM "task_judgment_request" request
    JOIN "task_completion_evidence" evidence ON evidence."id" = request."evidence_id"
   ORDER BY request."task_id", evidence."revision" DESC, request."created_at" DESC, request."id" DESC
)
UPDATE "task_judgment_request" older
   SET "status" = 'SUPERSEDED',
       "superseded_at" = GREATEST(older."created_at", newest."created_at"),
       "superseded_by_id" = newest."id"
  FROM newest
 WHERE older."task_id" = newest."task_id"
   AND older."id" <> newest."id"
   AND older."status" = 'OPEN';

CREATE FUNCTION "task_human_signoff_current_request_guard"() RETURNS trigger AS $$
DECLARE request_row "task_judgment_request"%ROWTYPE;
BEGIN
  SELECT * INTO request_row FROM "task_judgment_request"
   WHERE "id" = NEW."request_id" FOR UPDATE;
  IF NOT FOUND OR request_row."task_id" <> NEW."task_id"
     OR request_row."kind" <> 'HUMAN_SIGNOFF'
     OR request_row."recipient_type" <> 'ACCOUNT_OWNER'
     OR request_row."recipient_id" <> NEW."signed_by_id"::text
     OR request_row."evidence_digest" <> NEW."evidence_digest"
     OR request_row."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'TASK_HUMAN_SIGNOFF_CURRENT_REQUEST_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_human_signoff_current_request_guard"
  BEFORE INSERT ON "task_human_signoff"
  FOR EACH ROW EXECUTE FUNCTION "task_human_signoff_current_request_guard"();

-- Results cannot be attached to the wrong peer route. The request is locked so supersession and
-- result insertion have one winner; an aborted/unauthorised attempt consumes no fact identity.
CREATE FUNCTION "task_executable_judgment_result_request_guard"() RETURNS trigger AS $$
DECLARE request_row "task_judgment_request"%ROWTYPE;
BEGIN
  SELECT * INTO request_row FROM "task_judgment_request"
   WHERE "id" = NEW."request_id" FOR UPDATE;
  IF NOT FOUND OR request_row."kind" <> 'EXECUTABLE'
     OR request_row."recipient_type" <> 'SYSTEM_EXECUTABLE_EVALUATOR'
     OR NOT EXISTS (
       SELECT 1 FROM "task_completion_evidence" evidence
        WHERE evidence."id" = request_row."evidence_id"
          AND evidence."source_session_id"::text = request_row."recipient_id"
     )
     OR request_row."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'TASK_EXECUTABLE_JUDGMENT_OPEN_REQUEST_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_executable_judgment_result_request_guard"
  BEFORE INSERT ON "task_executable_judgment_result"
  FOR EACH ROW EXECUTE FUNCTION "task_executable_judgment_result_request_guard"();

-- Request identity is immutable and lifecycle is one-way. A DECIDED transition is accepted only
-- when the route-specific judgment fact is already present in this transaction; SUPERSEDED must
-- point to the newer request for the same task. Thus even a raw writer cannot make a notifier or
-- coordinator look like the human signer, attach a command to HUMAN_SIGNOFF, or reopen history.
CREATE FUNCTION "task_judgment_request_transition_guard"() RETURNS trigger AS $$
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
    SELECT * INTO successor FROM "task_judgment_request"
     WHERE "id" = NEW."superseded_by_id";
    IF NOT FOUND OR successor."task_id" <> NEW."task_id"
       OR successor."status" <> 'OPEN' OR successor."created_at" < OLD."created_at" THEN
      RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_INVALID_SUCCESSOR';
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
  ELSIF NEW."kind" = 'HUMAN_SIGNOFF' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task_human_signoff" signoff
       WHERE signoff."request_id" = NEW."id"
         AND signoff."task_id" = NEW."task_id"
         AND signoff."evidence_digest" = NEW."evidence_digest"
         AND signoff."signed_by_id"::text = NEW."recipient_id"
    ) THEN
      RAISE EXCEPTION 'TASK_HUMAN_SIGNOFF_EVENT_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_judgment_request_transition_guard"
  BEFORE UPDATE ON "task_judgment_request"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_request_transition_guard"();

-- The verifier Task is the independently runnable carrier of a VERIFICATION request. Once that
-- request is decided, its verdict, subject and derived terminal status are immutable audit facts.
-- A superseded carrier has no verdict to preserve and may make exactly one lifecycle transition:
-- to CANCELLED, so historical work cannot keep PROJECT_TASKS_SETTLED open forever. This trigger
-- also fences raw SQL writers; the service refusal alone would leave a second truth boundary.
CREATE FUNCTION "task_judgment_verifier_terminal_guard"() RETURNS trigger AS $$
DECLARE request_status "task_judgment_request_status";
BEGIN
  SELECT request."status" INTO request_status
    FROM "task_judgment_request" request
   WHERE request."id" = OLD."id"
     AND request."task_id" = OLD."verifies_task_id"
     AND request."kind" = 'VERIFICATION'
     AND request."recipient_type" = 'VERIFIER_TASK'
     AND request."recipient_id" = OLD."id"::text;

  IF NOT FOUND OR request_status = 'OPEN' THEN
    RETURN NEW;
  END IF;

  IF request_status = 'DECIDED' AND
     ROW(NEW."status", NEW."verdict", NEW."verifies_task_id") IS DISTINCT FROM
     ROW(OLD."status", OLD."verdict", OLD."verifies_task_id") THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE';
  ELSIF request_status = 'SUPERSEDED' AND (
    NEW."verdict" IS DISTINCT FROM OLD."verdict" OR
    NEW."verifies_task_id" IS DISTINCT FROM OLD."verifies_task_id" OR
    (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" <> 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_VERIFIER_TERMINAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_judgment_verifier_terminal_guard"
  BEFORE UPDATE OF "status", "verdict", "verifies_task_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_verifier_terminal_guard"();

-- Signal and project blocker are read-only projections. No caller can close them independently;
-- deciding or superseding the request makes both disappear in the same transaction automatically.
CREATE VIEW "task_judgment_signal" AS
SELECT r."id", r."task_id", t."project_id", r."owner_id",
       'OPEN_JUDGMENT_REQUEST'::text AS "signal_code",
       r."kind", r."recipient_type", r."recipient_id",
       r."criterion_revision", r."evidence_id", r."evidence_digest", r."created_at"
  FROM "task_judgment_request" r
  JOIN "task" t ON t."id" = r."task_id"
 WHERE r."status" = 'OPEN';

CREATE VIEW "project_judgment_blocker" AS
SELECT r."id", t."project_id", r."task_id",
       'HUMAN_DECISION_REQUIRED'::text AS "kind",
       r."recipient_id", r."evidence_digest", r."created_at"
  FROM "task_judgment_request" r
  JOIN "task" t ON t."id" = r."task_id"
 WHERE r."status" = 'OPEN' AND r."kind" = 'HUMAN_SIGNOFF'
   AND t."project_id" IS NOT NULL;

COMMENT ON TABLE "task_judgment_request" IS
  'One durable evidence-bound criterion question; OPEN signal/blocker rows are derived views.';
COMMENT ON VIEW "task_judgment_signal" IS
  'Read-only signal projection of OPEN task_judgment_request rows.';
COMMENT ON VIEW "project_judgment_blocker" IS
  'Read-only project blocker projection of OPEN HUMAN_SIGNOFF judgment requests.';
