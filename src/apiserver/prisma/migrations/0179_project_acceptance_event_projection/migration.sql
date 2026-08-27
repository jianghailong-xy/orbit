-- Acceptance is evaluated from durable events, not frozen as one terminal attempt.
--
-- `project_acceptance_run` remains the compatibility/API name for an immutable evidence-set
-- version. `project_acceptance_conclusion` is the append-only human/machine conclusion ledger.
-- Current PASS is a projection: for each current criterion revision, take the conclusion with the
-- greatest evidence version (then decision time/id). A newer merge observation advances the
-- evidence version without invalidating a still-unrefuted PASS; a later FAIL/INCONCLUSIVE event
-- immediately changes the projection and reopens a DONE project.

BEGIN;

CREATE TABLE "project_acceptance_conclusion" (
  "id"                  UUID PRIMARY KEY,
  "project_id"          UUID NOT NULL,
  "evidence_run_id"     UUID NOT NULL,
  "evidence_version"    BIGINT NOT NULL,

  "ordinal"             INTEGER NOT NULL,
  "criterion_key"       TEXT NOT NULL,
  "criterion_text"      TEXT NOT NULL,
  "definition_id"       UUID,
  "definition_revision" INTEGER,

  "verdict"             "project_acceptance_verdict" NOT NULL,
  "summary"             TEXT,
  "evidence"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  "evidence_task_id"    UUID,
  "evidence_session_id" UUID,

  "decided_by"          TEXT NOT NULL,
  "decided_by_id"       UUID NOT NULL,
  "acting_session_id"   UUID,
  "decided_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "project_acceptance_conclusion"
  ADD CONSTRAINT "project_acceptance_conclusion_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_acceptance_conclusion_run_fkey"
    FOREIGN KEY ("evidence_run_id") REFERENCES "project_acceptance_run"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_acceptance_conclusion_version_chk"
    CHECK ("evidence_version" >= 0),
  ADD CONSTRAINT "project_acceptance_conclusion_ordinal_chk"
    CHECK ("ordinal" >= 1),
  ADD CONSTRAINT "project_acceptance_conclusion_definition_pair_chk"
    CHECK (("definition_id" IS NULL) = ("definition_revision" IS NULL)),
  ADD CONSTRAINT "project_acceptance_conclusion_definition_revision_chk"
    CHECK ("definition_revision" IS NULL OR "definition_revision" >= 1),
  ADD CONSTRAINT "project_acceptance_conclusion_decided_by_chk"
    CHECK ("decided_by" IN ('USER', 'COORDINATOR_AGENT')),
  -- T6's boundary at the durable wall: a machine may refute, but only a person may confirm PASS.
  ADD CONSTRAINT "project_acceptance_conclusion_pass_human_chk"
    CHECK ("verdict" <> 'PASS'::"project_acceptance_verdict" OR "decided_by" = 'USER');

CREATE INDEX "project_acceptance_conclusion_standing_idx"
  ON "project_acceptance_conclusion"
    ("project_id", "definition_id", "definition_revision", "evidence_version" DESC,
     "decided_at" DESC, "id" DESC);
CREATE INDEX "project_acceptance_conclusion_run_idx"
  ON "project_acceptance_conclusion" ("evidence_run_id");

-- Preserve every historical criterion conclusion as an event. Old runs attributed execution to
-- the coordinator, not the final PASS author, so PASS is backfilled as USER: T6 already required a
-- person at the only service door that could have written it. Non-PASS keeps the run attribution.
INSERT INTO "project_acceptance_conclusion" (
  "id", "project_id", "evidence_run_id", "evidence_version",
  "ordinal", "criterion_key", "criterion_text", "definition_id", "definition_revision",
  "verdict", "summary", "evidence", "evidence_task_id", "evidence_session_id",
  "decided_by", "decided_by_id", "acting_session_id", "decided_at", "created_at"
)
SELECT gen_random_uuid(), c."project_id", r."id", r."attempt",
       c."ordinal", c."criterion_key", c."criterion_text", c."definition_id",
       c."definition_revision", c."verdict", c."summary", c."evidence",
       c."evidence_task_id", c."evidence_session_id",
       CASE WHEN c."verdict" = 'PASS'::"project_acceptance_verdict" THEN 'USER'
            ELSE r."decided_by" END,
       CASE WHEN c."verdict" = 'PASS'::"project_acceptance_verdict" THEN p."owner_id"
            ELSE COALESCE(r."coordinator_session_id", r."coordinator_agent_id", p."owner_id") END,
       r."coordinator_session_id",
       COALESCE(c."decided_at", r."completed_at", r."started_at"), c."created_at"
  FROM "project_acceptance_criterion" c
  JOIN "project_acceptance_run" r ON r."id" = c."run_id"
  JOIN "project" p ON p."id" = c."project_id"
 WHERE c."verdict" IS NOT NULL;

-- A project has exactly one current evidence version. Repair historical duplicates deterministically
-- before installing the database invariant; all rows remain as evidence history.
WITH ranked AS (
  SELECT r."id", row_number() OVER (
           PARTITION BY r."project_id" ORDER BY r."attempt" DESC, r."created_at" DESC, r."id" DESC
         ) AS position
    FROM "project_acceptance_run" r
   WHERE r."superseded_at" IS NULL
)
UPDATE "project_acceptance_run" r
   SET "superseded_at" = CURRENT_TIMESTAMP,
       "superseded_reason" = 'evidence_version_normalized'
  FROM ranked
 WHERE ranked."id" = r."id" AND ranked.position > 1;

CREATE UNIQUE INDEX "project_acceptance_run_one_current_version_idx"
  ON "project_acceptance_run" ("project_id")
  WHERE "superseded_at" IS NULL;

-- Conclusions may only name the project/version/checklist row of the evidence run they cite. This
-- is a trigger rather than three independent foreign keys because the historical criterion table
-- intentionally has no composite project key.
CREATE OR REPLACE FUNCTION project_acceptance_conclusion_validate() RETURNS TRIGGER AS $$
DECLARE
  run_project UUID;
  run_version BIGINT;
BEGIN
  -- Direct event writers take the same rank-40 mutex as the service before the new rank-60 row is
  -- inserted. The AFTER projection trigger below therefore never inverts conclusion → project.
  PERFORM 1 FROM "project" p
   WHERE p."id" = NEW."project_id" FOR NO KEY UPDATE;
  SELECT r."project_id", r."attempt" INTO run_project, run_version
    FROM "project_acceptance_run" r WHERE r."id" = NEW."evidence_run_id";
  IF NOT FOUND OR run_project IS DISTINCT FROM NEW."project_id"
               OR run_version IS DISTINCT FROM NEW."evidence_version" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_CONCLUSION_VERSION_MISMATCH: conclusion % must cite its run project and evidence version',
      NEW."id" USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "project_acceptance_criterion" c
     WHERE c."run_id" = NEW."evidence_run_id"
       AND c."ordinal" = NEW."ordinal"
       AND c."criterion_key" = NEW."criterion_key"
       AND c."definition_id" IS NOT DISTINCT FROM NEW."definition_id"
       AND c."definition_revision" IS NOT DISTINCT FROM NEW."definition_revision"
  ) THEN
    RAISE EXCEPTION
      'ACCEPTANCE_CONCLUSION_CRITERION_MISMATCH: conclusion % does not name a criterion in evidence version %',
      NEW."id", NEW."evidence_version" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_conclusion_validate
  BEFORE INSERT ON "project_acceptance_conclusion"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_conclusion_validate();

CREATE OR REPLACE FUNCTION project_acceptance_conclusion_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ACCEPTANCE_CONCLUSION_IMMUTABLE: conclusion % is an event and cannot be rewritten',
    OLD."id" USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_conclusion_immutable
  BEFORE UPDATE ON "project_acceptance_conclusion"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_conclusion_immutable();

-- The canonical current projection. A conclusion carries forward across later evidence versions,
-- but never across a definition revision. A later-version refutation always outranks a late write
-- against an older evidence version.
CREATE OR REPLACE FUNCTION project_acceptance_standing(
  p_project UUID, p_evidence_version BIGINT
) RETURNS TABLE (
  definition_id UUID,
  ordinal INTEGER,
  criterion_text TEXT,
  verdict "project_acceptance_verdict",
  decided_by TEXT,
  conclusion_id UUID
) AS $$
  SELECT d."id", d."ordinal", d."text", current."verdict", current."decided_by", current."id"
    FROM "project_acceptance_criterion_definition" d
    LEFT JOIN LATERAL (
      SELECT e."id", e."verdict", e."decided_by"
        FROM "project_acceptance_conclusion" e
       WHERE e."project_id" = p_project
         AND e."definition_id" = d."id"
         AND e."definition_revision" = d."revision"
         AND e."evidence_version" <= p_evidence_version
       ORDER BY e."evidence_version" DESC, e."decided_at" DESC, e."id" DESC
       LIMIT 1
    ) current ON TRUE
   WHERE d."project_id" = p_project
   ORDER BY d."ordinal"
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION project_acceptance_is_pass(
  p_project UUID, p_evidence_version BIGINT
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
           SELECT 1 FROM "project_acceptance_criterion_definition" d
            WHERE d."project_id" = p_project
         )
     AND NOT EXISTS (
           SELECT 1 FROM project_acceptance_standing(p_project, p_evidence_version) s
            WHERE s.verdict IS DISTINCT FROM 'PASS'::"project_acceptance_verdict"
         )
$$ LANGUAGE SQL STABLE;

-- A negative event changes the derived standing immediately. It may automatically leave DONE, but
-- no event automatically enters DONE: that irreversible positive transition remains human-only.
CREATE OR REPLACE FUNCTION project_acceptance_conclusion_reconcile() RETURNS TRIGGER AS $$
DECLARE
  current_status TEXT;
  current_run UUID;
  current_version BIGINT;
BEGIN
  SELECT p."status"::text, p."accepted_run_id"
    INTO current_status, current_run
    FROM "project" p WHERE p."id" = NEW."project_id" FOR NO KEY UPDATE;
  IF NOT FOUND OR current_status <> 'DONE' OR current_run IS NULL THEN RETURN NEW; END IF;

  SELECT r."attempt" INTO current_version
    FROM "project_acceptance_run" r
   WHERE r."project_id" = NEW."project_id" AND r."superseded_at" IS NULL;
  IF current_version IS NULL OR project_acceptance_is_pass(NEW."project_id", current_version) THEN
    RETURN NEW;
  END IF;

  UPDATE "project"
     SET "status" = 'OPEN', "accepted_run_id" = NULL, "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = NEW."project_id";
  INSERT INTO "project_acceptance_audit" ("id", "project_id", "kind", "run_id", "reason", "detail")
  VALUES (gen_random_uuid(), NEW."project_id", 'reopened_by_fact_change', current_run,
          'acceptance.conclusion',
          jsonb_build_object('conclusionId', NEW."id", 'evidenceVersion', NEW."evidence_version",
                             'criterionId', NEW."definition_id", 'verdict', NEW."verdict"));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_conclusion_reconcile
  AFTER INSERT ON "project_acceptance_conclusion"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_conclusion_reconcile();

-- Merge observations no longer reopen a project or invalidate a PASS. The service advances the
-- current evidence version in the same transaction; the standing above then re-evaluates over the
-- larger event set. Direct inserts remain durable facts and are picked up by the next idempotent
-- evaluation instead of manufacturing a stale refusal.
DROP TRIGGER IF EXISTS project_acceptance_merge_fact ON "project_merge_evidence";
DROP FUNCTION IF EXISTS project_acceptance_merge_fact();

-- Database hard wall behind the service. It reads the same event projection and has no freshness
-- branch: a current non-PASS is ACCEPTANCE_MISSING, while changed evidence that leaves every current
-- criterion PASS remains acceptable without reopening an attempt.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run             "project_acceptance_run"%ROWTYPE;
  criterion_count INTEGER;
  unmet_criteria  TEXT;
  open_blocker    INTEGER;
  open_defect     INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN RETURN NEW; END IF;

  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL AND NEW."acceptance_epoch" = 0 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no current evidence version', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: evidence version % does not belong to project %',
      NEW."accepted_run_id", NEW."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: evidence version % is not the current project version',
      run."id" USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO criterion_count
    FROM "project_acceptance_criterion_definition" d WHERE d."project_id" = NEW."id";
  IF criterion_count = 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % states no acceptance criteria', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT string_agg(
           format('#%s %L (%s)', s.ordinal, s.criterion_text,
                  COALESCE(s.verdict::text, 'UNDECIDED')),
           '; ' ORDER BY s.ordinal
         )
    INTO unmet_criteria
    FROM project_acceptance_standing(NEW."id", run."attempt") s
   WHERE s.verdict IS DISTINCT FROM 'PASS'::"project_acceptance_verdict";
  IF unmet_criteria IS NOT NULL THEN
    RAISE EXCEPTION
      'ACCEPTANCE_MISSING: current acceptance criteria are non-PASS: %. A new finding belongs to this project only if it changes an acceptance criterion: record a new conclusion event; otherwise create a separate project.',
      unmet_criteria
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_blocker FROM "project_blocker" b
   WHERE b."project_id" = NEW."id" AND b."resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_defect
    FROM "task_verification_failure" f
    JOIN "task" verifier ON verifier."id" = f."verifier_task_id"
    JOIN "task" subject  ON subject."id"  = f."subject_task_id"
   WHERE f."project_id" = NEW."id" AND f."resolved_at" IS NULL
     AND verifier."terminal_reason" IS NULL AND verifier."superseded_by_task_id" IS NULL
     AND subject."terminal_reason" IS NULL AND subject."superseded_by_task_id" IS NULL;
  IF open_defect > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % unresolved verification failure(s)',
      NEW."id", open_defect USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_acceptance_done_gate() IS
  'Allows DONE from the current append-only conclusion projection; evidence changes never create stale attempts.';

COMMIT;
