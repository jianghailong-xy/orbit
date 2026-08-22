-- Unit L2 — where work was NOTICED, and which acceptance a PASS belongs to.
--
-- Two facts the database cannot currently state, both named by the L1 scope contract
-- (`docs/project-coordinator-scope-contract.md` §2, §3 SC6/SC7, §10) and left to this unit:
--
--   1. PROVENANCE. `task.project_id` says which goal a task counts towards, and nothing says where
--      the work was noticed. The incident L1 exists for — a coordinator session filing a batch into
--      a project it does not coordinate — leaves a row that is byte-identical to a deliberate one.
--      Four columns beside the authority column make that comparison possible after the fact
--      instead of an archaeology across sessions and turns.
--
--      They are EVIDENCE, and evidence grants nothing (SC7). The invariant is stated here in the
--      one language every writer meets: the referential actions. `task.project_id` is
--      ON DELETE RESTRICT, so deleting a project that owns work is refused — that is authority.
--      `task.discovered_from_project_id` is ON DELETE SET NULL, so deleting a project work was
--      merely noticed in succeeds and empties the note — that is evidence. Same table, same target,
--      opposite actions, and the difference is the whole contract.
--
--   2. ACCEPTANCE EPOCH. A project that is reopened starts a new acceptance; a PASS reached before
--      it is history. Today that is true only along one code path. `ProjectsService.update` retires
--      the runs when a person moves DONE → OPEN, and `project_acceptance_reopen` (0127) does it for
--      a fact change. Everything else leaves a live PASS standing:
--
--        * DONE → CANCELLED → OPEN takes neither branch (the service tests `status = DONE`), so the
--          run stays live, `accepted_run_id` stays bound, and the next DONE is granted on evidence
--          gathered before the project was reopened;
--        * a raw `UPDATE project SET status = 'OPEN'` — a migration, a repair script, the 0.1.131
--          binary still serving during a rolling deploy — takes no branch at all.
--
--      `project_runtime.acceptance_attempt` cannot answer this: it counts RUNS, so it moves when
--      acceptance is re-run and stays still when the project is reopened, which is the opposite of
--      the question. So: one monotonic epoch on the project, advanced by the database on every
--      reopen whoever performs it, and stamped onto every run at open. "Is this PASS the current
--      one" becomes an integer comparison the DONE gate makes, and a historical run is excluded by
--      being read rather than by being rewritten.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- ===============================
--   * It does not backfill. Every project lands at epoch 0 and every existing run at epoch 0, so
--     they match and no DONE that stands today is invalidated (AC11). A legacy DONE keeps its 0127
--     stamp, unread and unrewritten, until somebody reopens the project.
--   * It does not supersede anything on the epoch path. §13.4's `superseded_at` is a fact ABOUT a
--     run; the epoch is a fact about the project. Retiring a run to express "the project moved on"
--     would write the project's news into the run's record — and this unit's whole point is that a
--     historical conclusion is not rewritten.
--   * It adds no business entity, no blocker kind and no authorization code (L1 §8 CM3, §5 EC4).
--     The four new refusal codes are L3's to introduce.
--
-- RE-RUNNABILITY AND ROLLBACK
-- ===========================
-- Every statement is re-runnable: columns are `ADD COLUMN IF NOT EXISTS`, indexes are
-- `CREATE INDEX IF NOT EXISTS`, constraints are added inside a `duplicate_object` guard, functions
-- are `CREATE OR REPLACE` and triggers are dropped by name first. An interrupted apply that is
-- retried reaches the same state as one that was not. `down.sql` beside this file reverses it in
-- the opposite order and is re-runnable in the same way; it is not read by Prisma (which reads only
-- `migration.sql`) and exists so a rollback is a reviewed script rather than one improvised at 3am.
--
-- The band is 0150 on purpose. Migrations 0132–0141 are claimed by units that have not landed yet
-- (G, H, K), and a second 0132 is a merge conflict dressed up as a schema. The L unit takes 015x.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1 · Provenance: four columns beside `project_id`, and none of them authority.
-- ---------------------------------------------------------------------------------------------

-- The project whose coordination scope NOTICED this work. Normally equal to `project_id`; the row
-- worth reading is the one where it is not.
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "discovered_from_project_id" UUID;
-- WHICH fact prompted it, in the same free-text vocabulary `project_acceptance_reopen(p_fact)`
-- already speaks ('task.verdict_failed', 'merge_evidence', 'user.project_edited'). Deliberately not
-- an enum and not a CHECK over a value set: L1 froze the column NAMES and left the vocabulary open,
-- and a closed set here would have to be extended by a migration every time a new trigger is
-- written — which is how a column stops being written at all.
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "trigger_event" TEXT;
-- The task being executed when this work was noticed, and the session it was noticed in.
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "source_task_id" UUID;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "source_session_id" UUID;

-- SET NULL on all three, and the contrast with `task_project_id_fkey` (RESTRICT) is the point: a
-- project that owns work cannot be deleted, while a project, task or session that work was merely
-- noticed in can be — and what survives is the absence, which reads as "the source is gone", not as
-- "there was none". The same choice `superseded_by_task_id` and `creator_session_id` make.
DO $$ BEGIN
  ALTER TABLE "task" ADD CONSTRAINT "task_discovered_from_project_id_fkey"
    FOREIGN KEY ("discovered_from_project_id") REFERENCES "project"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "task" ADD CONSTRAINT "task_source_task_id_fkey"
    FOREIGN KEY ("source_task_id") REFERENCES "task"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "task" ADD CONSTRAINT "task_source_session_id_fkey"
    FOREIGN KEY ("source_session_id") REFERENCES "session"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A trigger event is a short fact name, not a place to park a paragraph. The bound is what keeps a
-- writer from using it as a second description field; the emptiness check is what keeps '' from
-- meaning both "nothing was recorded" and "something was, and it was blank".
DO $$ BEGIN
  ALTER TABLE "task" ADD CONSTRAINT "task_trigger_event_chk"
    CHECK ("trigger_event" IS NULL
           OR (length("trigger_event") BETWEEN 1 AND 120 AND btrim("trigger_event") <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PARTIAL, like every other index this table grew for a column most rows leave NULL (0108, 0110):
-- the six figures of tasks with no provenance stay out of them. Each is also the referencing side's
-- own lookup index, without which every project, task or session delete has to scan `task` to find
-- the rows its SET NULL applies to.
CREATE INDEX IF NOT EXISTS "task_discovered_from_project_idx"
  ON "task" ("discovered_from_project_id") WHERE "discovered_from_project_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "task_source_task_idx"
  ON "task" ("source_task_id") WHERE "source_task_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "task_source_session_idx"
  ON "task" ("source_session_id") WHERE "source_session_id" IS NOT NULL;

-- SC7, as a rule rather than as a comment: written at creation, read-only afterwards.
--
-- The one transition allowed is to NULL, and it is not a concession — it is the SET NULL above
-- arriving as an UPDATE from the referenced row's delete. Refusing it would make deleting a project
-- fail against a task it does not own, which is the failure mode `discovered_from_project_id` was
-- given SET NULL to avoid in the first place.
--
-- What is refused is every rewrite: NULL → a value (evidence cannot be retrofitted onto a write
-- that has already happened) and one value → another (evidence that can be edited is testimony).
-- A `project_id` that MOVES — L4's declared handoff — leaves these four untouched, which is exactly
-- right: where the work was noticed did not change when it changed hands.
CREATE OR REPLACE FUNCTION task_provenance_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."discovered_from_project_id" IS DISTINCT FROM OLD."discovered_from_project_id"
        AND NEW."discovered_from_project_id" IS NOT NULL)
     OR (NEW."trigger_event" IS DISTINCT FROM OLD."trigger_event"
        AND NEW."trigger_event" IS NOT NULL)
     OR (NEW."source_task_id" IS DISTINCT FROM OLD."source_task_id"
        AND NEW."source_task_id" IS NOT NULL)
     OR (NEW."source_session_id" IS DISTINCT FROM OLD."source_session_id"
        AND NEW."source_session_id" IS NOT NULL) THEN
    RAISE EXCEPTION
      'TASK_PROVENANCE_IMMUTABLE: task % records where it was discovered; that is written once',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_provenance_immutable_guard" ON "task";
CREATE TRIGGER "task_provenance_immutable_guard"
  BEFORE UPDATE OF "discovered_from_project_id", "trigger_event", "source_task_id",
                   "source_session_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_provenance_immutable();

-- ---------------------------------------------------------------------------------------------
-- 2 · The acceptance epoch: one counter on the project, one stamp on every run.
-- ---------------------------------------------------------------------------------------------

-- Monotonic, never reused, never reset — the same rule `coordinator_generation`, `fencing_token`
-- and `verdict_revision` are held to, and for the same reason: a counter that can go back is a
-- counter that can make two different worlds look like the same one.
--
-- DEFAULT 0 is what makes this migration safe on a database with history in it. Every project that
-- already exists lands at 0 and every run it already has lands at 0, so they match and every DONE
-- that stands today keeps standing (AC11).
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "acceptance_epoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "project_acceptance_run" ADD COLUMN IF NOT EXISTS "acceptance_epoch" BIGINT NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "project" ADD CONSTRAINT "project_acceptance_epoch_chk"
    CHECK ("acceptance_epoch" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_epoch_chk"
    CHECK ("acceptance_epoch" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- "Which epoch's evidence do I have for this project" is the read the DONE gate and the acceptance
-- face both make. `attempt` is already in the unique key; the epoch is the coarser key beside it.
CREATE INDEX IF NOT EXISTS "project_acceptance_run_epoch_idx"
  ON "project_acceptance_run" ("project_id", "acceptance_epoch");

-- The counter is maintained ENTIRELY by the database, exactly as
-- `project_runtime.coordinator_identity_landing_id` is, and for the sharper version of the same
-- reason: the writers that most need to advance it are the ones that do not know it exists. A
-- 0.1.131 binary reopening a project during a rolling deploy, a repair script, a future migration's
-- raw UPDATE — each advances the epoch by doing nothing but the reopen it was already doing. That
-- is also why the ELSE branch pins NEW to OLD instead of leaving it alone: a writer that sends a
-- value for this column, whatever value and whatever its reason, does not get to choose the epoch.
--
-- A reopen is "was settled, is now OPEN". Both settled statuses count, because DONE → CANCELLED →
-- OPEN is the transition the service's `status = DONE` branch misses and the one that hands the
-- next DONE a PASS from before the project was put down.
--
-- The NAME is load-bearing. PostgreSQL fires BEFORE ROW triggers in alphabetical order, and the
-- gate below (`project_acceptance_done_gate`) reads `NEW.acceptance_epoch`. `..._advance_epoch`
-- sorts before `..._done_gate`, so the gate always reads the pinned value rather than whatever the
-- statement happened to put there — otherwise `UPDATE project SET status='DONE', acceptance_epoch=0`
-- would be gated against an epoch this trigger is about to overwrite.
CREATE OR REPLACE FUNCTION project_acceptance_advance_epoch() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IN ('DONE', 'CANCELLED') AND NEW."status" = 'OPEN' THEN
    NEW."acceptance_epoch" := OLD."acceptance_epoch" + 1;
  ELSE
    NEW."acceptance_epoch" := OLD."acceptance_epoch";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_acceptance_advance_epoch" ON "project";
CREATE TRIGGER "project_acceptance_advance_epoch"
  BEFORE UPDATE ON "project"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_advance_epoch();

-- The audit says what happened to a project's acceptance standing. A reopen moving the epoch is
-- such a fact, and it is NOT `reopened_by_user`: that row is written by the one service path that
-- knows a person pressed something, while this one is written for every reopen whoever performed
-- it. Two names because they are two claims — conflating them would have the audit assert a user
-- for a reopen that came out of a repair script.
ALTER TABLE "project_acceptance_audit" DROP CONSTRAINT IF EXISTS "project_acceptance_audit_kind_chk";
ALTER TABLE "project_acceptance_audit" ADD CONSTRAINT "project_acceptance_audit_kind_chk"
  CHECK ("kind" IN (
    'run_opened', 'run_finalized', 'run_superseded',
    'done_bound', 'done_refused',
    'reopened_by_fact_change', 'reopened_by_user', 'legacy_marked', 'merge_evidence_observed',
    'acceptance_epoch_advanced'
  ));

CREATE OR REPLACE FUNCTION project_acceptance_epoch_audit() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "project_acceptance_audit" ("id", "project_id", "kind", "run_id", "reason", "detail")
  VALUES (gen_random_uuid(), NEW."id", 'acceptance_epoch_advanced', OLD."accepted_run_id",
          'project reopened: acceptance evidence from earlier epochs is history',
          jsonb_build_object('fromEpoch', OLD."acceptance_epoch", 'toEpoch', NEW."acceptance_epoch",
                             'fromStatus', OLD."status", 'toStatus', NEW."status",
                             'wasLegacy', OLD."legacy_accepted_at" IS NOT NULL));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Plain `AFTER UPDATE`, deliberately not `AFTER UPDATE OF "acceptance_epoch"`. `UPDATE OF` fires on
-- the columns a STATEMENT names, not on the ones whose values actually moved — and the reopen this
-- audits never names this column: it writes `SET status = 'OPEN'` and the BEFORE trigger above
-- advances the epoch. An `UPDATE OF` clause here would make the audit silent for exactly the writes
-- it exists to record.
DROP TRIGGER IF EXISTS "project_acceptance_epoch_audit" ON "project";
CREATE TRIGGER "project_acceptance_epoch_audit"
  AFTER UPDATE ON "project"
  FOR EACH ROW WHEN (NEW."acceptance_epoch" IS DISTINCT FROM OLD."acceptance_epoch")
  EXECUTE FUNCTION project_acceptance_epoch_audit();

-- A run is stamped with the epoch it was opened under, by the database rather than by its opener.
-- The alternative — a DEFAULT plus a service that passes the right value — is indistinguishable at
-- the column from an old binary that passes nothing, and the old binary's run would be stamped 0 on
-- a project at epoch 3: fail-closed, but refused later for a reason that has nothing to do with the
-- evidence it gathered. Stamping it here means every writer, at every version, opens a run in the
-- epoch that is actually current.
--
-- On UPDATE it is frozen for every run, concluded or not — unlike the columns
-- `project_acceptance_run_immutable_guard` protects, which are only frozen once a verdict exists.
-- The epoch is not a conclusion, it is the identity of the world the conclusion is about, and there
-- is no moment at which moving it means anything but relabelling evidence.
CREATE OR REPLACE FUNCTION project_acceptance_run_epoch() RETURNS TRIGGER AS $$
DECLARE
  project_epoch BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p."acceptance_epoch" INTO project_epoch FROM "project" p WHERE p."id" = NEW."project_id";
    -- No project: leave the value alone and let the foreign key raise. A trigger that invented an
    -- epoch here would be answering for a row that is about to be refused anyway.
    IF FOUND THEN NEW."acceptance_epoch" := project_epoch; END IF;
    RETURN NEW;
  END IF;
  IF NEW."acceptance_epoch" IS DISTINCT FROM OLD."acceptance_epoch" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_RUN_IMMUTABLE: run % was opened in epoch %; that is not a property it may change',
      OLD."id", OLD."acceptance_epoch" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_acceptance_run_epoch_guard" ON "project_acceptance_run";
CREATE TRIGGER "project_acceptance_run_epoch_guard"
  BEFORE INSERT OR UPDATE ON "project_acceptance_run"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_run_epoch();

-- ---------------------------------------------------------------------------------------------
-- 3 · The DONE gate learns to read the epoch.
-- ---------------------------------------------------------------------------------------------
--
-- 0127's four checks are unchanged; two clauses join them. Both say the same thing about two shapes
-- of evidence — it was gathered before this project was reopened, so it is not about this project:
--
--   * a bound run whose epoch is not the project's. `superseded_at` catches this along the paths
--     that remember to write it; the epoch catches it along the ones that do not, which is every
--     path that is not `ProjectsService.update`'s DONE → OPEN branch.
--   * a legacy stamp on a project that has since been reopened. 0127's own comment promises this
--     ("The moment such a project is reopened by a person, the stamp is cleared and its next DONE
--     has to earn a real run") and the service keeps that promise; nothing kept it for a reopen the
--     service did not perform. Rather than clearing the stamp — which would rewrite the record of
--     what the project once was — the gate stops honouring it once the epoch has moved.
--
-- The code is `ACCEPTANCE_EVIDENCE_STALE` in both cases and no new code is minted: PAC §12 E2
-- forbids a synonym, and "your evidence is about a world that is no longer this one" is exactly
-- what that code already means.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run          "project_acceptance_run"%ROWTYPE;
  open_blocker INTEGER;
  open_defect  INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN
    RETURN NEW;
  END IF;

  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL THEN
      IF NEW."acceptance_epoch" > 0 THEN
        RAISE EXCEPTION
          'ACCEPTANCE_EVIDENCE_STALE: project % was reopened after its legacy DONE (epoch %); its next DONE needs a real acceptance run',
          NEW."id", NEW."acceptance_epoch" USING ERRCODE = 'raise_exception';
      END IF;
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
  IF run."acceptance_epoch" IS DISTINCT FROM NEW."acceptance_epoch" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_EVIDENCE_STALE: acceptance run % passed in epoch %, and this project is now in epoch % — it was reopened after that run',
      run."id", run."acceptance_epoch", NEW."acceptance_epoch" USING ERRCODE = 'raise_exception';
  END IF;

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

-- Recreated so the trigger also fires on a write that names neither column but does move the
-- status through some other path's UPDATE. 0127 declared it `BEFORE UPDATE OF "status",
-- "accepted_run_id"`, which is the same set the function reads; keeping that list is deliberate —
-- widening it would run the gate on every project write, including the ones that touch nothing it
-- checks.
DROP TRIGGER IF EXISTS "project_acceptance_done_gate" ON "project";
CREATE TRIGGER "project_acceptance_done_gate"
  BEFORE UPDATE OF "status", "accepted_run_id" ON "project"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_done_gate();

COMMIT;
