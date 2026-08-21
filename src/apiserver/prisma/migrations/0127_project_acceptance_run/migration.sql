-- Native project-level acceptance (contract §13.4 AE1–AE11, §13.5).
--
-- Before this migration a Project's DONE was a column a caller could write. The evidence for it
-- lived — when it lived anywhere — in a task comment somebody wrote after reading a document, and
-- nothing in the database related that comment to the facts it was about. §13.4 has said since v1.1
-- what the replacement is: a persistent acceptance record, per-criterion, digest-bound to the world
-- it judged, and a service-side hard gate that recomputes the digest inside the writing transaction.
-- This migration is the durable half of it.
--
-- Four tables and two columns, and the two columns are the ones that carry the invariant:
-- `project.accepted_run_id` makes "this project is DONE" and "here is the run that says why" ONE
-- row, so they cannot drift; `project.legacy_accepted_at` says, out loud, which DONEs predate the
-- mechanism instead of quietly counting them as evidence.
--
-- The gate is a trigger and not only a service check for the reason §2.4 gives about D5/D6: a
-- service check exists only in the binary that has it. A DONE written by an older apiserver, by a
-- migration script or by a hand-typed UPDATE has to hit the same wall.

CREATE TYPE "project_acceptance_verdict" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');

-- ---------------------------------------------------------------------------------------------
-- 1. The run, its criteria, the merge observations and the audit.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "project_acceptance_run" (
  "id"                     UUID PRIMARY KEY,
  "project_id"             UUID NOT NULL,

  -- §13.4 AE11: claimed from `project_runtime.acceptance_attempt`, `+1` committed with this insert.
  "attempt"                BIGINT NOT NULL,

  "criteria_snapshot"      TEXT NOT NULL,
  "criteria_revision"      CHAR(64) NOT NULL,

  "input_digest"           CHAR(64) NOT NULL,
  "result_digest"          CHAR(64),

  "verdict"                "project_acceptance_verdict",
  "decided_by"             TEXT NOT NULL,

  "coordinator_agent_id"   UUID,
  "coordinator_session_id" UUID,
  "decision_id"            UUID,
  "project_action_id"      UUID,

  "superseded_at"          TIMESTAMP(3),
  "superseded_reason"      TEXT,

  "started_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"           TIMESTAMP(3),
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same-project decision lineage, exactly as `project_action` declares it (migration 0120): a run
-- may only cite a decision of its own project.
ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_decision_fkey"
  FOREIGN KEY ("decision_id", "project_id") REFERENCES "project_decision"("id", "project_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The permanent name of one attempt. Monotonic and never reused (§8.2 GE1), so a retry of the same
-- pass lands on the row it already made instead of opening a second one.
CREATE UNIQUE INDEX "project_acceptance_run_attempt_idx"
  ON "project_acceptance_run" ("project_id", "attempt");
CREATE INDEX "project_acceptance_run_project_created_idx"
  ON "project_acceptance_run" ("project_id", "created_at");

-- `decided_by` is the same closed pair `project_decision.decided_by` carries. §13.4 clause 5 is the
-- reason it is constrained and not free text: "who concluded" decides whether the conclusion may be
-- used at all, and a third value would be a third answer nobody wrote a rule for.
ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_decided_by_chk"
  CHECK ("decided_by" IN ('COORDINATOR_AGENT', 'USER'));

-- A run is open or terminal, and terminal means "concluded at a moment": a verdict without a
-- completion stamp (or the reverse) is a half-written row the gate would have to guess about.
ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_terminal_chk"
  CHECK (("verdict" IS NULL AND "completed_at" IS NULL AND "result_digest" IS NULL)
      OR ("verdict" IS NOT NULL AND "completed_at" IS NOT NULL AND "result_digest" IS NOT NULL));

CREATE TABLE "project_acceptance_criterion" (
  "id"                  UUID PRIMARY KEY,
  "run_id"              UUID NOT NULL,
  "project_id"          UUID NOT NULL,

  "ordinal"             INTEGER NOT NULL,
  "criterion_key"       TEXT NOT NULL,
  "criterion_text"      TEXT NOT NULL,

  "verdict"             "project_acceptance_verdict",
  "summary"             TEXT,
  "evidence"            JSONB NOT NULL DEFAULT '{}'::jsonb,

  "evidence_task_id"    UUID,
  "evidence_session_id" UUID,

  "decided_at"          TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "project_acceptance_criterion" ADD CONSTRAINT "project_acceptance_criterion_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "project_acceptance_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "project_acceptance_criterion_ordinal_idx"
  ON "project_acceptance_criterion" ("run_id", "ordinal");
CREATE INDEX "project_acceptance_criterion_project_idx"
  ON "project_acceptance_criterion" ("project_id");

ALTER TABLE "project_acceptance_criterion" ADD CONSTRAINT "project_acceptance_criterion_ordinal_chk"
  CHECK ("ordinal" >= 1);

-- §13.4 AE9: the one authoritative representation of what a target branch contained, and the only
-- place `contentHash` may be written from (AE9-b). Rows are appended, never rewritten when the
-- content differs — that is what `ref_generation` is for.
CREATE TABLE "project_merge_evidence" (
  "id"             UUID PRIMARY KEY,
  "project_id"     UUID NOT NULL,

  "requirement_id" TEXT NOT NULL,
  "target_branch"  TEXT NOT NULL,
  "content_hash"   CHAR(64) NOT NULL,
  "ref_generation" BIGINT NOT NULL,

  "source"         TEXT NOT NULL DEFAULT 'MERGE_EVIDENCE_WRITER',
  "detail"         JSONB NOT NULL DEFAULT '{}'::jsonb,

  "observed_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "project_merge_evidence" ADD CONSTRAINT "project_merge_evidence_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "project_merge_evidence_generation_idx"
  ON "project_merge_evidence" ("project_id", "requirement_id", "target_branch", "ref_generation");
CREATE INDEX "project_merge_evidence_lookup_idx"
  ON "project_merge_evidence" ("project_id", "requirement_id", "target_branch");

ALTER TABLE "project_merge_evidence" ADD CONSTRAINT "project_merge_evidence_generation_chk"
  CHECK ("ref_generation" >= 1);

CREATE TABLE "project_acceptance_audit" (
  "id"         UUID PRIMARY KEY,
  "project_id" UUID NOT NULL,
  "kind"       TEXT NOT NULL,
  "run_id"     UUID,
  "reason"     TEXT,
  "detail"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "project_acceptance_audit" ADD CONSTRAINT "project_acceptance_audit_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "project_acceptance_audit_project_created_idx"
  ON "project_acceptance_audit" ("project_id", "created_at");

-- The closed set, declared where every writer meets it — including the trigger below, which is a
-- writer no TypeScript type covers.
ALTER TABLE "project_acceptance_audit" ADD CONSTRAINT "project_acceptance_audit_kind_chk"
  CHECK ("kind" IN (
    'run_opened', 'run_finalized', 'run_superseded',
    'done_bound', 'done_refused',
    'reopened_by_fact_change', 'reopened_by_user', 'legacy_marked', 'merge_evidence_observed'
  ));

-- ---------------------------------------------------------------------------------------------
-- 2. The two columns on `project`, and the legacy backfill.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "project" ADD COLUMN "accepted_run_id"    UUID;
ALTER TABLE "project" ADD COLUMN "legacy_accepted_at" TIMESTAMP(3);

ALTER TABLE "project" ADD CONSTRAINT "project_accepted_run_id_fkey"
  FOREIGN KEY ("accepted_run_id") REFERENCES "project_acceptance_run"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "project_accepted_run_idx" ON "project" ("accepted_run_id");

-- AC11, stated as a write rather than as an intention: every project that is ALREADY DONE keeps its
-- DONE and is stamped as legacy. It is not reopened (nobody asked for that, and reopening somebody's
-- finished project during an upgrade is the destructive reading of "compatibility"), it is not
-- credited with evidence it does not have, and the stamp is exactly what the reopen trigger below
-- looks at to leave it alone. The moment such a project is reopened by a person, the stamp is
-- cleared and its next DONE has to earn a real run.
UPDATE "project" SET "legacy_accepted_at" = CURRENT_TIMESTAMP
 WHERE "status" = 'DONE' AND "legacy_accepted_at" IS NULL;

INSERT INTO "project_acceptance_audit" ("id", "project_id", "kind", "reason", "detail")
SELECT gen_random_uuid(), p."id", 'legacy_marked',
       'DONE predates native project acceptance (migration 0127)',
       jsonb_build_object('migration', '0127_project_acceptance_run', 'stampedAt', to_jsonb(CURRENT_TIMESTAMP))
  FROM "project" p
 WHERE p."status" = 'DONE' AND p."accepted_run_id" IS NULL;

-- A DONE project is bound to a run or stamped legacy; there is no third shape. Declared as a CHECK
-- so it holds for rows nobody has touched since, and so the invariant can be read off the schema
-- instead of reconstructed from the service.
ALTER TABLE "project" ADD CONSTRAINT "project_done_evidence_chk"
  CHECK ("status" <> 'DONE' OR "accepted_run_id" IS NOT NULL OR "legacy_accepted_at" IS NOT NULL);

-- ---------------------------------------------------------------------------------------------
-- 3. `project_acceptance_done_gate` — the hard gate, in the database (§13.4 AE2 / AE7).
-- ---------------------------------------------------------------------------------------------
--
-- The service performs AE2's three steps under `FOR UPDATE` and is where the typed refusals come
-- from. This trigger is the wall behind it: it never recomputes the digest (that is the service's
-- job and needs sha256 over canonical JSON), it checks the four things a wrong DONE always gets
-- wrong — the run belongs to this project, it concluded PASS, it has not been superseded, and
-- nothing is left unresolved.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run          "project_acceptance_run"%ROWTYPE;
  open_blocker INTEGER;
  open_defect  INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN
    RETURN NEW;
  END IF;

  -- A legacy DONE that is being re-asserted without a run: only allowed while the stamp is still
  -- there, which is precisely the row the backfill above made and nothing else can create.
  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no acceptance run to be DONE against', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: acceptance run % does not belong to project %',
      NEW."accepted_run_id", NEW."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."verdict" IS DISTINCT FROM 'PASS'::"project_acceptance_verdict" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: acceptance run % concluded %, not PASS',
      run."id", COALESCE(run."verdict"::text, 'nothing yet') USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was superseded at %',
      run."id", run."superseded_at" USING ERRCODE = 'raise_exception';
  END IF;

  -- §13.4 clause 4 read the other way round: a project cannot be finished while something it
  -- already knows about is unfinished. Both counts are the same reads the service gate makes.
  SELECT count(*) INTO open_blocker FROM "project_blocker" b
   WHERE b."project_id" = NEW."id" AND b."resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_defect FROM "task_verification_failure" f
   WHERE f."project_id" = NEW."id" AND f."resolved_at" IS NULL;
  IF open_defect > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % unresolved verification failure(s)',
      NEW."id", open_defect USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_done_gate
  BEFORE UPDATE OF "status", "accepted_run_id" ON "project"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_done_gate();

-- ---------------------------------------------------------------------------------------------
-- 4. `project_acceptance_fact_reopen` — AE8's atomic reopen, for every writer.
-- ---------------------------------------------------------------------------------------------
--
-- AE6 lists the closed set of writes that can change the acceptance digest, and AE8 says what such
-- a write must do when it lands on a project that is already DONE: reopen it, in the SAME
-- transaction, and record which fact changed. v1.2 wrote that as an obligation on each writer.
-- Here it is a database function every one of those writers hits whether it knows about it or not —
-- including the raw `UPDATE task SET status = ...` that a future migration will inevitably contain.
--
-- Three things it does NOT do, each deliberate:
--   * `CANCELLED` is untouched (AE8 推论 3): a task changing does not undo a person's decision to
--     stop the project.
--   * a legacy DONE is untouched (§13.5 LG1): it never claimed to be bound to a fact set, so no
--     fact can invalidate it. AC11's promise is exactly this.
--   * it does not decide `run_state`. §4.3 I1 keeps that column for reconcile alone, and the
--     `user.project_edited` event this writes is what asks reconcile to recompute it.
CREATE OR REPLACE FUNCTION project_acceptance_reopen(
  p_project UUID, p_fact TEXT, p_detail JSONB
) RETURNS VOID AS $$
DECLARE
  current_status  TEXT;
  current_run     UUID;
  current_legacy  TIMESTAMP(3);
BEGIN
  IF p_project IS NULL THEN RETURN; END IF;

  -- AE6-a's lock, taken by whoever got here first. `FOR NO KEY UPDATE` and not `FOR SHARE`: AE8
  -- may have to UPDATE this very row, and §8.6 LO3 forbids the upgrade that would deadlock.
  SELECT p."status"::text, p."accepted_run_id", p."legacy_accepted_at"
    INTO current_status, current_run, current_legacy
    FROM "project" p WHERE p."id" = p_project FOR NO KEY UPDATE;
  IF NOT FOUND OR current_status <> 'DONE' THEN RETURN; END IF;
  IF current_run IS NULL THEN RETURN; END IF;   -- legacy DONE: see the comment above

  -- Every run that could still be used is retired by this fact change, not only the bound one:
  -- otherwise a superseded-then-unsuperseded ordering could hand the next DONE an older PASS.
  UPDATE "project_acceptance_run"
     SET "superseded_at" = CURRENT_TIMESTAMP,
         "superseded_reason" = 'reopened_by_fact_change:' || p_fact
   WHERE "project_id" = p_project AND "superseded_at" IS NULL;

  UPDATE "project"
     SET "status" = 'OPEN', "accepted_run_id" = NULL, "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_project;

  INSERT INTO "project_acceptance_audit" ("id", "project_id", "kind", "run_id", "reason", "detail")
  VALUES (gen_random_uuid(), p_project, 'reopened_by_fact_change', current_run,
          p_fact, COALESCE(p_detail, '{}'::jsonb));

  -- §5.3's dirty signal, so reconcile recomputes `run_state` off the reopened row. Coalesced while
  -- unconsumed by the same partial unique index every other producer uses (migration 0116).
  INSERT INTO "project_event" ("id", "project_id", "v", "kind", "occurred_at", "source_type",
                               "source_id", "dedupe_key", "payload", "last_at")
  VALUES (gen_random_uuid(), p_project, 1, 'user.project_edited', CURRENT_TIMESTAMP, 'USER',
          p_project, 'project_reopened_by_fact_change:' || p_project::text,
          jsonb_build_object('fact', p_fact, 'detail', COALESCE(p_detail, '{}'::jsonb)),
          CURRENT_TIMESTAMP)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- taskSet + verdicts: create, delete, status, completion policy, cross-project move, the verdict
-- itself and the pointer that decides whose verdict it is (§13.4 AE6's table, both v1.3 rows
-- included). AE10's two projects are the two branches at the bottom.
CREATE OR REPLACE FUNCTION project_acceptance_task_fact() RETURNS TRIGGER AS $$
DECLARE
  fact TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM project_acceptance_reopen(NEW."project_id", 'task.created',
      jsonb_build_object('taskId', NEW."id"));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM project_acceptance_reopen(OLD."project_id", 'task.deleted',
      jsonb_build_object('taskId', OLD."id"));
    RETURN OLD;
  END IF;

  IF OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
    -- AE10: two projections change, so two projects are asked, in id order (§8.6 LO2) so that
    -- A→B and B→A cannot make a cycle out of each other.
    IF OLD."project_id" IS NOT NULL AND NEW."project_id" IS NOT NULL
       AND OLD."project_id" > NEW."project_id" THEN
      PERFORM project_acceptance_reopen(NEW."project_id", 'task.project_moved_in',
        jsonb_build_object('taskId', NEW."id", 'from', OLD."project_id"));
      PERFORM project_acceptance_reopen(OLD."project_id", 'task.project_moved_out',
        jsonb_build_object('taskId', NEW."id", 'to', NEW."project_id"));
    ELSE
      PERFORM project_acceptance_reopen(OLD."project_id", 'task.project_moved_out',
        jsonb_build_object('taskId', NEW."id", 'to', NEW."project_id"));
      PERFORM project_acceptance_reopen(NEW."project_id", 'task.project_moved_in',
        jsonb_build_object('taskId', NEW."id", 'from', OLD."project_id"));
    END IF;
    RETURN NEW;
  END IF;

  fact := CASE
    WHEN OLD."status" IS DISTINCT FROM NEW."status" THEN 'task.status_changed'
    WHEN OLD."completion_policy" IS DISTINCT FROM NEW."completion_policy" THEN 'task.completion_policy'
    WHEN OLD."verdict" IS DISTINCT FROM NEW."verdict" THEN 'task.verdict'
    WHEN OLD."verifies_task_id" IS DISTINCT FROM NEW."verifies_task_id" THEN 'task.verifies_task_id'
    ELSE NULL
  END;
  IF fact IS NOT NULL THEN
    PERFORM project_acceptance_reopen(NEW."project_id", fact,
      jsonb_build_object('taskId', NEW."id"));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_task_fact
  AFTER INSERT OR DELETE ON "task"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_task_fact();

CREATE TRIGGER project_acceptance_task_fact_update
  AFTER UPDATE OF "status", "completion_policy", "project_id", "verdict", "verifies_task_id"
  ON "task"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_task_fact();

-- criteriaRevision: the acceptance criteria themselves. A trigger on the same table it reopens, so
-- it guards against recursion by only acting when the text actually changed and the row was DONE
-- before this statement.
CREATE OR REPLACE FUNCTION project_acceptance_criteria_fact() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."acceptance_criteria" IS DISTINCT FROM NEW."acceptance_criteria"
     AND OLD."status" = 'DONE' AND NEW."status" = 'DONE'
     AND NEW."accepted_run_id" IS NOT NULL THEN
    PERFORM project_acceptance_reopen(NEW."id", 'project.acceptance_criteria', '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_criteria_fact
  AFTER UPDATE OF "acceptance_criteria" ON "project"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_criteria_fact();

-- mergeEvidence: AE9-c. A new generation is by construction different content, so its arrival on a
-- DONE project is the drift AE9-d promises to detect with bounded delay — and to reopen atomically
-- when it does arrive.
CREATE OR REPLACE FUNCTION project_acceptance_merge_fact() RETURNS TRIGGER AS $$
BEGIN
  PERFORM project_acceptance_reopen(NEW."project_id", 'merge_evidence',
    jsonb_build_object('requirementId', NEW."requirement_id",
                       'targetBranch', NEW."target_branch",
                       'refGeneration', NEW."ref_generation"));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_merge_fact
  AFTER INSERT ON "project_merge_evidence"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_merge_fact();

-- ---------------------------------------------------------------------------------------------
-- 5. Immutability of what has already been concluded (§8.2 GE1).
-- ---------------------------------------------------------------------------------------------
--
-- A finished run may still be superseded — that is a fact ABOUT the run, added later, and the whole
-- freshness mechanism is built on it. Everything the run concluded is frozen. DELETE is not guarded
-- here for the reason §2.4 states about the five ledger tables: the project cascade is the one
-- declared exit, and a BEFORE DELETE trigger would break it.
CREATE OR REPLACE FUNCTION project_acceptance_run_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."verdict" IS NULL THEN RETURN NEW; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
     OR NEW."criteria_snapshot" IS DISTINCT FROM OLD."criteria_snapshot"
     OR NEW."criteria_revision" IS DISTINCT FROM OLD."criteria_revision"
     OR NEW."input_digest" IS DISTINCT FROM OLD."input_digest"
     OR NEW."result_digest" IS DISTINCT FROM OLD."result_digest"
     OR NEW."verdict" IS DISTINCT FROM OLD."verdict"
     OR NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
     OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN
    RAISE EXCEPTION 'ACCEPTANCE_RUN_IMMUTABLE: run % has concluded; only supersession may be recorded',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_run_immutable_guard
  BEFORE UPDATE ON "project_acceptance_run"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_run_immutable();

-- A criterion of a concluded run is that run's evidence; rewriting it afterwards is rewriting the
-- conclusion by another route.
CREATE OR REPLACE FUNCTION project_acceptance_criterion_immutable() RETURNS TRIGGER AS $$
DECLARE
  concluded "project_acceptance_verdict";
BEGIN
  SELECT r."verdict" INTO concluded FROM "project_acceptance_run" r WHERE r."id" = OLD."run_id";
  IF concluded IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_RUN_IMMUTABLE: criterion % belongs to a concluded run', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_criterion_immutable_guard
  BEFORE UPDATE ON "project_acceptance_criterion"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_criterion_immutable();

-- The audit is append-only in the strict sense: it is the record of what the other rules did, and a
-- record that its own subjects may edit is not one.
CREATE OR REPLACE FUNCTION project_acceptance_audit_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ACCEPTANCE_AUDIT_APPEND_ONLY: audit row % may not be rewritten', OLD."id"
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_audit_append_only
  BEFORE UPDATE ON "project_acceptance_audit"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_audit_append_only();
