-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- The Open list's data version (sessions/open-list-version.ts) used to hash every row the list
-- could show, on every poll: ~31.5k shared-buffer touches on an account with 7.9k sessions,
-- 113k tasks and 16M run events, four fifths of it the task rows. This migration gives every
-- source table a per-owner counter instead, so the probe reads counters, not rows.
--
-- WHAT IS ADDED
-- -------------
--   open_list_epoch          one (owner_id, source) counter, starting at 0.
--   open_list_bump_owner()   bump from a row's own owner_id            (most tables)
--   open_list_bump_via_project()  owner through project_id              (three project facts)
--   open_list_bump_via_session()  owner through session_id              (approval, tag links, turns)
--   open_list_bump_session()      the session counter, for CONVERSATION rows only
--
--   Three triggers per table (INSERT / UPDATE / DELETE) because transition tables cannot be
--   specified for a trigger with more than one event. They are statement-level: a bulk write
--   bumps a counter once for the statement, not once per row, and an update that changes owner_id
--   bumps the owner it left as well as the one it joined.
--
--   session indexes the probe now uses: (owner_id, assigned_runner_id) for the runners a session
--   names, and partial indexes for the two all-rows predicates that are almost always empty
--   (a pending merge/commit request, a session with running background jobs).
--
-- WHAT A COUNTER GUARANTEES
-- -------------------------
-- It may move when the list did not change — any write to the table moves it, and the same row
-- change may move it twice. It cannot lag a write: the bump is in the writing transaction. A row
-- entering or leaving a set the probe derives (a task named by a session, a wake's project) is a
-- write to a source that owns a counter of its own, so no membership change is missed.
--
-- WHAT IS NOT A COUNTER
-- ---------------------
-- The clock thresholds (a runner's beat ageing out, a job going quiet, a fence going stale, a
-- share link expiring, the deadlines a review window or an escalation runs out at) and the few
-- rows that are cheap or someone else's (runners, their presence rows, share links, the foreign
-- running turns a PENDING row waits behind) are still read live, exactly as before. A counter
-- cannot answer a question about the passage of time.
--
-- The counters start at zero; a missing row reads as zero, so every client fetches once and
-- carries on. Truncation is the one write a DELETE trigger misses; the product never truncates
-- these tables.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE "open_list_epoch" (
    "owner_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "open_list_epoch_pkey" PRIMARY KEY ("owner_id", "source")
);

-- The four bump functions. Each one bumps the owner set of the statement's transition table, in
-- the writing transaction, once per statement. EXECUTE keeps the branch naming a transition table
-- the current event does not have (new_rows on DELETE, old_rows on INSERT) out of the parse path.
CREATE FUNCTION open_list_bump_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    EXECUTE format('INSERT INTO open_list_epoch(owner_id, source, epoch)
                    SELECT DISTINCT owner_id, %L, 1 FROM new_rows
                    ON CONFLICT (owner_id, source)
                    DO UPDATE SET epoch = open_list_epoch.epoch + 1', src);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    EXECUTE format('INSERT INTO open_list_epoch(owner_id, source, epoch)
                    SELECT DISTINCT owner_id, %L, 1 FROM old_rows
                    ON CONFLICT (owner_id, source)
                    DO UPDATE SET epoch = open_list_epoch.epoch + 1', src);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION open_list_bump_via_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    EXECUTE format('INSERT INTO open_list_epoch(owner_id, source, epoch)
                    SELECT DISTINCT p.owner_id, %L, 1
                      FROM new_rows r JOIN project p ON p.id = r.project_id
                    ON CONFLICT (owner_id, source)
                    DO UPDATE SET epoch = open_list_epoch.epoch + 1', src);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    EXECUTE format('INSERT INTO open_list_epoch(owner_id, source, epoch)
                    SELECT DISTINCT p.owner_id, %L, 1
                      FROM old_rows r JOIN project p ON p.id = r.project_id
                    ON CONFLICT (owner_id, source)
                    DO UPDATE SET epoch = open_list_epoch.epoch + 1', src);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION open_list_bump_via_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    EXECUTE format('INSERT INTO open_list_epoch(owner_id, source, epoch)
                    SELECT DISTINCT s.owner_id, %L, 1
                      FROM new_rows r JOIN session s ON s.id = r.session_id
                    ON CONFLICT (owner_id, source)
                    DO UPDATE SET epoch = open_list_epoch.epoch + 1', src);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    EXECUTE format('INSERT INTO open_list_epoch(owner_id, source, epoch)
                    SELECT DISTINCT s.owner_id, %L, 1
                      FROM old_rows r JOIN session s ON s.id = r.session_id
                    ON CONFLICT (owner_id, source)
                    DO UPDATE SET epoch = open_list_epoch.epoch + 1', src);
  END IF;
  RETURN NULL;
END $$;

-- A session's own row: the flat list counts only CONVERSATION rows. Any other kind (LANDING) is
-- visible only to a project read, which hashes its own body and consults no counter.
CREATE FUNCTION open_list_bump_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    EXECUTE $q$INSERT INTO open_list_epoch(owner_id, source, epoch)
                 SELECT DISTINCT owner_id, 'session', 1
                   FROM new_rows WHERE kind = 'CONVERSATION'
                 ON CONFLICT (owner_id, source)
                 DO UPDATE SET epoch = open_list_epoch.epoch + 1$q$;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    EXECUTE $q$INSERT INTO open_list_epoch(owner_id, source, epoch)
                 SELECT DISTINCT owner_id, 'session', 1
                   FROM old_rows WHERE kind = 'CONVERSATION'
                 ON CONFLICT (owner_id, source)
                 DO UPDATE SET epoch = open_list_epoch.epoch + 1$q$;
  END IF;
  RETURN NULL;
END $$;


-- Tables whose row carries its own owner_id.

CREATE TRIGGER "workspace_open_list_epoch_insert" AFTER INSERT ON "workspace"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('workspace');

CREATE TRIGGER "workspace_open_list_epoch_update" AFTER UPDATE ON "workspace"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('workspace');

CREATE TRIGGER "workspace_open_list_epoch_delete" AFTER DELETE ON "workspace"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('workspace');

CREATE TRIGGER "task_open_list_epoch_insert" AFTER INSERT ON "task"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('task');

CREATE TRIGGER "task_open_list_epoch_update" AFTER UPDATE ON "task"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('task');

CREATE TRIGGER "task_open_list_epoch_delete" AFTER DELETE ON "task"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('task');

CREATE TRIGGER "project_open_list_epoch_insert" AFTER INSERT ON "project"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('project');

CREATE TRIGGER "project_open_list_epoch_update" AFTER UPDATE ON "project"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('project');

CREATE TRIGGER "project_open_list_epoch_delete" AFTER DELETE ON "project"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('project');

CREATE TRIGGER "project_open_item_open_list_epoch_insert" AFTER INSERT ON "project_open_item"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('project_open_item');

CREATE TRIGGER "project_open_item_open_list_epoch_update" AFTER UPDATE ON "project_open_item"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('project_open_item');

CREATE TRIGGER "project_open_item_open_list_epoch_delete" AFTER DELETE ON "project_open_item"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('project_open_item');

CREATE TRIGGER "project_ratified_action_intent_open_list_epoch_insert" AFTER INSERT ON "project_ratified_action_intent"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('ratified_intent');

CREATE TRIGGER "project_ratified_action_intent_open_list_epoch_update" AFTER UPDATE ON "project_ratified_action_intent"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('ratified_intent');

CREATE TRIGGER "project_ratified_action_intent_open_list_epoch_delete" AFTER DELETE ON "project_ratified_action_intent"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('ratified_intent');

CREATE TRIGGER "project_ratified_action_commit_open_list_epoch_insert" AFTER INSERT ON "project_ratified_action_commit"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('ratified_commit');

CREATE TRIGGER "project_ratified_action_commit_open_list_epoch_update" AFTER UPDATE ON "project_ratified_action_commit"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('ratified_commit');

CREATE TRIGGER "project_ratified_action_commit_open_list_epoch_delete" AFTER DELETE ON "project_ratified_action_commit"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('ratified_commit');

CREATE TRIGGER "project_criteria_decision_open_list_epoch_insert" AFTER INSERT ON "project_criteria_decision"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('criteria_decision');

CREATE TRIGGER "project_criteria_decision_open_list_epoch_update" AFTER UPDATE ON "project_criteria_decision"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('criteria_decision');

CREATE TRIGGER "project_criteria_decision_open_list_epoch_delete" AFTER DELETE ON "project_criteria_decision"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('criteria_decision');

CREATE TRIGGER "project_standard_set_confirmation_open_list_epoch_insert" AFTER INSERT ON "project_standard_set_confirmation"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('standard_set_confirmation');

CREATE TRIGGER "project_standard_set_confirmation_open_list_epoch_update" AFTER UPDATE ON "project_standard_set_confirmation"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('standard_set_confirmation');

CREATE TRIGGER "project_standard_set_confirmation_open_list_epoch_delete" AFTER DELETE ON "project_standard_set_confirmation"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('standard_set_confirmation');

CREATE TRIGGER "project_promotion_open_list_epoch_insert" AFTER INSERT ON "project_promotion"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('promotion');

CREATE TRIGGER "project_promotion_open_list_epoch_update" AFTER UPDATE ON "project_promotion"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('promotion');

CREATE TRIGGER "project_promotion_open_list_epoch_delete" AFTER DELETE ON "project_promotion"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('promotion');

CREATE TRIGGER "project_integration_job_open_list_epoch_insert" AFTER INSERT ON "project_integration_job"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('integration_job');

CREATE TRIGGER "project_integration_job_open_list_epoch_update" AFTER UPDATE ON "project_integration_job"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('integration_job');

CREATE TRIGGER "project_integration_job_open_list_epoch_delete" AFTER DELETE ON "project_integration_job"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('integration_job');

CREATE TRIGGER "project_codebase_open_list_epoch_insert" AFTER INSERT ON "project_codebase"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('codebase');

CREATE TRIGGER "project_codebase_open_list_epoch_update" AFTER UPDATE ON "project_codebase"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('codebase');

CREATE TRIGGER "project_codebase_open_list_epoch_delete" AFTER DELETE ON "project_codebase"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('codebase');

CREATE TRIGGER "project_criteria_authorship_open_list_epoch_insert" AFTER INSERT ON "project_criteria_authorship"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('criteria_authorship');

CREATE TRIGGER "project_criteria_authorship_open_list_epoch_update" AFTER UPDATE ON "project_criteria_authorship"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('criteria_authorship');

CREATE TRIGGER "project_criteria_authorship_open_list_epoch_delete" AFTER DELETE ON "project_criteria_authorship"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('criteria_authorship');

CREATE TRIGGER "session_merge_receipt_open_list_epoch_insert" AFTER INSERT ON "session_merge_receipt"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('merge_receipt');

CREATE TRIGGER "session_merge_receipt_open_list_epoch_update" AFTER UPDATE ON "session_merge_receipt"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('merge_receipt');

CREATE TRIGGER "session_merge_receipt_open_list_epoch_delete" AFTER DELETE ON "session_merge_receipt"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('merge_receipt');

CREATE TRIGGER "task_completion_evidence_open_list_epoch_insert" AFTER INSERT ON "task_completion_evidence"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('completion_evidence');

CREATE TRIGGER "task_completion_evidence_open_list_epoch_update" AFTER UPDATE ON "task_completion_evidence"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('completion_evidence');

CREATE TRIGGER "task_completion_evidence_open_list_epoch_delete" AFTER DELETE ON "task_completion_evidence"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('completion_evidence');

CREATE TRIGGER "task_evidence_decision_open_list_epoch_insert" AFTER INSERT ON "task_evidence_decision"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('evidence_decision');

CREATE TRIGGER "task_evidence_decision_open_list_epoch_update" AFTER UPDATE ON "task_evidence_decision"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('evidence_decision');

CREATE TRIGGER "task_evidence_decision_open_list_epoch_delete" AFTER DELETE ON "task_evidence_decision"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('evidence_decision');

CREATE TRIGGER "task_owner_confirmation_request_open_list_epoch_insert" AFTER INSERT ON "task_owner_confirmation_request"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_request');

CREATE TRIGGER "task_owner_confirmation_request_open_list_epoch_update" AFTER UPDATE ON "task_owner_confirmation_request"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_request');

CREATE TRIGGER "task_owner_confirmation_request_open_list_epoch_delete" AFTER DELETE ON "task_owner_confirmation_request"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_request');

CREATE TRIGGER "task_owner_confirmation_claim_open_list_epoch_insert" AFTER INSERT ON "task_owner_confirmation_claim"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_claim');

CREATE TRIGGER "task_owner_confirmation_claim_open_list_epoch_update" AFTER UPDATE ON "task_owner_confirmation_claim"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_claim');

CREATE TRIGGER "task_owner_confirmation_claim_open_list_epoch_delete" AFTER DELETE ON "task_owner_confirmation_claim"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_claim');

CREATE TRIGGER "task_owner_decision_open_list_epoch_insert" AFTER INSERT ON "task_owner_decision"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('owner_decision');

CREATE TRIGGER "task_owner_decision_open_list_epoch_update" AFTER UPDATE ON "task_owner_decision"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('owner_decision');

CREATE TRIGGER "task_owner_decision_open_list_epoch_delete" AFTER DELETE ON "task_owner_decision"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('owner_decision');

CREATE TRIGGER "task_owner_confirmation_review_open_list_epoch_insert" AFTER INSERT ON "task_owner_confirmation_review"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_review');

CREATE TRIGGER "task_owner_confirmation_review_open_list_epoch_update" AFTER UPDATE ON "task_owner_confirmation_review"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_review');

CREATE TRIGGER "task_owner_confirmation_review_open_list_epoch_delete" AFTER DELETE ON "task_owner_confirmation_review"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_review');

CREATE TRIGGER "task_owner_confirmation_review_record_open_list_epoch_insert" AFTER INSERT ON "task_owner_confirmation_review_record"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_review_record');

CREATE TRIGGER "task_owner_confirmation_review_record_open_list_epoch_update" AFTER UPDATE ON "task_owner_confirmation_review_record"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_review_record');

CREATE TRIGGER "task_owner_confirmation_review_record_open_list_epoch_delete" AFTER DELETE ON "task_owner_confirmation_review_record"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('confirmation_review_record');

CREATE TRIGGER "session_request_open_list_epoch_insert" AFTER INSERT ON "session_request"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('session_request');

CREATE TRIGGER "session_request_open_list_epoch_update" AFTER UPDATE ON "session_request"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('session_request');

CREATE TRIGGER "session_request_open_list_epoch_delete" AFTER DELETE ON "session_request"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('session_request');

CREATE TRIGGER "session_tag_open_list_epoch_insert" AFTER INSERT ON "session_tag"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('session_tag');

CREATE TRIGGER "session_tag_open_list_epoch_update" AFTER UPDATE ON "session_tag"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('session_tag');

CREATE TRIGGER "session_tag_open_list_epoch_delete" AFTER DELETE ON "session_tag"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('session_tag');

-- Tables whose owner is the project they belong to.

CREATE TRIGGER "project_coordinator_wake_open_list_epoch_insert" AFTER INSERT ON "project_coordinator_wake"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('coordinator_wake');

CREATE TRIGGER "project_coordinator_wake_open_list_epoch_update" AFTER UPDATE ON "project_coordinator_wake"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('coordinator_wake');

CREATE TRIGGER "project_coordinator_wake_open_list_epoch_delete" AFTER DELETE ON "project_coordinator_wake"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('coordinator_wake');

CREATE TRIGGER "project_acceptance_criterion_definition_open_list_epoch_insert" AFTER INSERT ON "project_acceptance_criterion_definition"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('criterion_definition');

CREATE TRIGGER "project_acceptance_criterion_definition_open_list_epoch_update" AFTER UPDATE ON "project_acceptance_criterion_definition"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('criterion_definition');

CREATE TRIGGER "project_acceptance_criterion_definition_open_list_epoch_delete" AFTER DELETE ON "project_acceptance_criterion_definition"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('criterion_definition');

CREATE TRIGGER "project_task_status_count_open_list_epoch_insert" AFTER INSERT ON "project_task_status_count"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('task_status_count');

CREATE TRIGGER "project_task_status_count_open_list_epoch_update" AFTER UPDATE ON "project_task_status_count"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('task_status_count');

CREATE TRIGGER "project_task_status_count_open_list_epoch_delete" AFTER DELETE ON "project_task_status_count"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_project('task_status_count');

-- Tables whose owner is the session they belong to.

CREATE TRIGGER "approval_open_list_epoch_insert" AFTER INSERT ON "approval"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('approval');

CREATE TRIGGER "approval_open_list_epoch_update" AFTER UPDATE ON "approval"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('approval');

CREATE TRIGGER "approval_open_list_epoch_delete" AFTER DELETE ON "approval"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('approval');

CREATE TRIGGER "session_tag_link_open_list_epoch_insert" AFTER INSERT ON "session_tag_link"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('session_tag_link');

CREATE TRIGGER "session_tag_link_open_list_epoch_update" AFTER UPDATE ON "session_tag_link"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('session_tag_link');

CREATE TRIGGER "session_tag_link_open_list_epoch_delete" AFTER DELETE ON "session_tag_link"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('session_tag_link');

CREATE TRIGGER "conversation_turn_open_list_epoch_insert" AFTER INSERT ON "conversation_turn"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('conversation_turn');

CREATE TRIGGER "conversation_turn_open_list_epoch_update" AFTER UPDATE ON "conversation_turn"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('conversation_turn');

CREATE TRIGGER "conversation_turn_open_list_epoch_delete" AFTER DELETE ON "conversation_turn"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('conversation_turn');

-- The session row itself.

CREATE TRIGGER "session_open_list_epoch_insert" AFTER INSERT ON "session"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_session();

CREATE TRIGGER "session_open_list_epoch_update" AFTER UPDATE ON "session"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_session();

CREATE TRIGGER "session_open_list_epoch_delete" AFTER DELETE ON "session"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_session();

-- ── The evidence-review hold's clock, kept on the evidence row ─────────────────────────────────
-- The probe used to find each review-window deadline by joining every evidence row to its task
-- (for the dispatching session) and that session's review turn (for the delivery time): ~1.1k
-- random task lookups and ~2.1k turn rows on every poll, the last large cost left in the probe.
--
-- The delivery IS the turn — evidence-review.ts writes `evidence-review:v1:<evidenceId>` once and
-- its created_at is the delivery moment — so the moment is copied onto the evidence row here, by
-- a trigger on the turn's insert, and the probe reads it without joining anything. The backfill
-- below does for existing rows what the trigger will do for new ones.
--
-- The trigger's prefix is EVIDENCE_REVIEW_TURN_KEY_PREFIX in sessions/watch-turn-key.ts, which SQL
-- cannot import: `open-list-version.pg.spec.ts` creates a turn with the TypeScript constant and
-- asserts the row was stamped, so a change to one that misses the other is red.
--
-- The probe now counts an expired window for a task that has since closed, too. That can only
-- invalidate the version more often than the list changes, never less — the one direction the
-- version is allowed to be wrong in.
ALTER TABLE "task_completion_evidence" ADD COLUMN "review_turn_at" TIMESTAMP(3);

UPDATE "task_completion_evidence" e
   SET "review_turn_at" = x.created_at
  FROM "task" t, "conversation_turn" x
 WHERE t.id = e.task_id
   AND x.session_id = t.creator_session_id
   AND x.client_turn_id = 'evidence-review:v1:' || e.id::text;

CREATE FUNCTION open_list_evidence_review_turn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_turn_id ~ '^evidence-review:v1:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    UPDATE task_completion_evidence
       SET review_turn_at = NEW.created_at
     WHERE id = substring(NEW.client_turn_id from 20)::uuid;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "conversation_turn_evidence_review_deadline" AFTER INSERT ON "conversation_turn"
  FOR EACH ROW EXECUTE FUNCTION open_list_evidence_review_turn();

-- The probe's live reads over session: the runners a session names (index-only), and the two
-- predicates that filter almost every row out. Without these the two counts are seq scans of the
-- whole account, which is what this migration exists to stop paying.
CREATE INDEX "session_open_list_runner_idx" ON "session" ("owner_id", "assigned_runner_id");

CREATE INDEX "session_open_list_fence_idx" ON "session" ("owner_id")
  WHERE "merge_status" IS NOT DISTINCT FROM 'pending' OR "commit_status" IS NOT DISTINCT FROM 'pending';

CREATE INDEX "session_open_list_bg_jobs_idx" ON "session" ("owner_id")
  WHERE cardinality("running_bg_jobs") > 0;
