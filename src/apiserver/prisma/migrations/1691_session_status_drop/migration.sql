-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1691: session.status and the type run_status are dropped (docs/session-status-retirement-plan.md §4.1 and §4.3,
-- deploy D4; project 353SgnUjvamRr06Sho0EZ, task T15).
--
-- Deploy D3 (1671, live on production 2026-11-26) took the field out of schema.prisma: no server code reads or writes
-- the column, and the database kept the word from the facts for one reader only, deploy-2 code after a rollback. This
-- file ends that: the column, the type and everything that exists only for them go. The legacy wire words are still
-- answered, from the facts, by session_legacy_status and sessions/session-legacy-words.ts.
--
-- WHAT IT DROPS
-- -------------
--   trigger session_aa_status_from_facts and function session_status_from_facts()   1671's rollback trigger
--   function session_turn_state_of_status(run_status)                              1611's, the backfill's
--   function session_legacy_status(…, stored_status)                               1621's nine-argument form
--   CHECK session_turn_state_agrees_chk                                             1651's, the two spellings equal
--   CHECK session_release_fact_chk                                                 1401's, released word <=> finished_at
--   column session.status, with its default and its six indexes (session_status_idx,
--       session_assigned_runner_id_status_idx, session_batch_id_status_idx, session_owner_status_task_idx,
--       session_root_session_id_status_idx, session_over_capacity_pending_idx)
--   type run_status (it had no other column)
-- session_turn_state_released_chk, session_turn_state_chk, session_phase_chk and phase NOT NULL stay (plan §1.5).
--
-- WHAT IT RESTATES
-- ----------------
--   session_listed_at_on_settle, session_request_recipient_ended, task_supersession_live_session_guard
--       call the eight-argument session_legacy_status instead of the nine-argument one with a NULL stored word. Each
--       body is the one a database migrated through 1681 holds (pg_get_functiondef), with that call changed and
--       nothing else.
--   the 13 triggers whose UPDATE OF lists name status (plan §4.2), each re-created with its definition as that
--       database holds it (pg_get_triggerdef), `status` taken out of the list and nothing else:
--       session_acquisition_engine_guard, session_admission_lock_order_update, session_antigravity_runner_claim_guard,
--       session_cursor_runner_acquisition_guard, session_dsh_runner_acquisition_guard, session_listed_at_settle,
--       session_opencode_runner_claim_guard, session_project_capacity_serialize_update, session_request_asker_stopped,
--       session_request_recipient_ended, session_superseded_task_revive_guard, session_zz_phase,
--       task_owner_confirmation_review_reviewer_ended
--
-- WHAT DEPENDS ON THE COLUMN
-- --------------------------
-- A DROP COLUMN takes indexes and constraints with it silently, a trigger list blocks it half-way (2BP01), and
-- pg_depend does not see a plpgsql body at all (wiki pitfall). So, after the objects above are gone or restated and
-- before anything is dropped, the DO block refuses to run if pg_depend records anything else on the column or the type,
-- or any function body in `public` still names the column or the type. Then nothing has changed: the file is one
-- transaction.
--
-- THE HAND-OVER: NOT FROM THE D3 RELEASE feeb45cf16
-- ------------------------------------------------
-- The replica that serves while this runs must name the column nowhere. The release live on 2026-11-27 (feeb45cf16)
-- does in ONE place: the Run now gate (sessions/queued-gate.ts, `WHERE s.status = 'PENDING'`), part of every session
-- list read, which answers 500 once the column is gone. The fix reads turn_state, needs no migration and is its own
-- commit of task T15: it must be live on every replica BEFORE a release that carries this file starts. Nothing else
-- of D3 reads or writes the column (the PG specs run the server on the schema this file leaves).
--
-- ROLLBACK
-- --------
-- IRREVERSIBLE as a migration: the stored words are gone. A rollback of the code to the D3 release feeb45cf16 after
-- this file runs needs the column back: scripts/session-status-drop-down.sql re-adds it, fills it from the facts
-- through session_legacy_status and puts 1671's objects back, and going further back starts from there with 1671's
-- down script. A release that carries the gate's fix, and not this file, serves a database left at D4 as it is.
--
-- LOCKS
-- -----
-- DROP TRIGGER, DROP CONSTRAINT and DROP COLUMN take ACCESS EXCLUSIVE on session, for catalog changes only (no row
-- is rewritten or checked). The lock is asked for first, in one DO statement, 2 s at a time, 1 s apart, up to 45
-- tries (1261, 1401, 1443, 1671), so a long reader makes it wait and try again rather than queue every writer behind
-- it. The file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction. Nothing in it
-- COMMITs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1691: main, every project/*, pushed orbit/* and probe/* branch and every local worktree held at most 1681 on
-- 2026-11-27. Not a multiple of 10. Can run twice: CREATE OR REPLACE and IF EXISTS throughout, and the dependency
-- check reads nothing once the column and the type are gone.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.session_listed_at_on_settle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NULL)
     OR (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NOT NULL
         AND NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
         AND session_legacy_status(OLD."finished_at", NULL, OLD."end_reason", OLD."last_turn_outcome", OLD."started_at",
                                   OLD."import_source_cwd", OLD."kind", NULL) <> 'FAILED')
     OR (NEW."completed_at" IS NOT NULL AND OLD."completed_at" IS NULL) THEN
    NEW."listed_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.session_request_recipient_ended()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "session_request"
     SET "state" = 'RECIPIENT_ENDED',
         "excerpt" = NEW."last_assistant_text",
         "close_reason" = CASE
             WHEN NEW."deleted_at" IS NOT NULL THEN 'TRASHED'
             WHEN NEW."completed_at" IS NOT NULL OR NEW."archived_at" IS NOT NULL THEN 'COMPLETED'
             ELSE session_legacy_status(NEW."finished_at", session_held_turn_state(NEW), NEW."end_reason",
                    NEW."last_turn_outcome", NEW."started_at", NEW."import_source_cwd", NEW."kind",
                    CASE WHEN NEW."kind" = 'LANDING' THEN
                      (SELECT pl."settled_as" FROM "project_landing" pl WHERE pl."session_id" = NEW."id") END)
           END || COALESCE(':' || NULLIF(NEW."end_reason", ''), ''),
         "closed_at" = CURRENT_TIMESTAMP
   WHERE "to_session_id" = NEW."id" AND "state" = 'OPEN';
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.task_supersession_live_session_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  live_id     UUID;
  live_status TEXT;
BEGIN
  -- The boundary is the FIRST RETIREMENT TRANSITION and nothing else: not-retired → retired. Three
  -- other shapes reach this trigger and none of them is a task being taken away from a live run:
  --
  --   retired → retired    a successor deleted by `ON DELETE SET NULL` (pointer cleared, reason
  --                        kept), a link re-pointed at a later attempt, or the same link restated.
  --                        The task was ALREADY retired before any of these, so nothing is being
  --                        taken from anybody — and refusing them would be worse than useless,
  --                        because §1 deliberately lets a person open a USER session on a retired
  --                        attempt to read or salvage it, and that session would then permanently
  --                        block the FK from doing what a DELETE told it to do;
  --   not retired → not retired   an UPDATE touching some other column;
  --   retired → not retired       undoing a mistaken retirement, which must stay possible.
  --
  -- `terminal_reason IS NOT NULL OR superseded_by_task_id IS NOT NULL` is `taskRetirement()`, the
  -- same predicate the services read, spelled here so both sides answer one question one way.
  IF NOT (NEW."terminal_reason" IS NOT NULL OR NEW."superseded_by_task_id" IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD."terminal_reason" IS NOT NULL OR OLD."superseded_by_task_id" IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  -- All four live statuses (§4.2 guard 5). A run paused at AWAITING_INPUT is a conversation
  -- somebody is in the middle of, and retiring its task out from under it is the same accident with
  -- a person watching.
  --
  -- ...on this task OR on any check pointed at it. The third order of the same race: a check is
  -- running, and its subject is retired underneath it. That leaves a live run verifying replaced
  -- work — the state §2c removes by refusing the repoint, and this removes by refusing the
  -- retirement while the check is in flight. Both directions, so no order of the two commits
  -- reaches it.
  -- Only WORK holds a task against retirement, on either side.
  --
  -- A salvage session is somebody reading a run that already happened; it is not executing the
  -- task, so retiring the task takes nothing from it — and letting it veto the retirement would
  -- mean that opening a window onto a replaced attempt permanently froze the record of the
  -- replacement. §1 permits exactly that window, so this has to permit the retirement beside it.
  --
  -- The verifier side is narrower still: a check of this task holds it only when the check is
  -- itself un-retired. A live salvage on an already-replaced check is history looking at history,
  -- and §13.6's whole point is that history does not block.
  SELECT s."id", session_legacy_status(s."finished_at", session_held_turn_state(s), s."end_reason", s."last_turn_outcome",
                                       s."started_at", s."import_source_cwd", s."kind", NULL)
    INTO live_id, live_status
    FROM "session" s
    JOIN "task" t ON t."id" = s."task_id"
   WHERE s."deleted_at" IS NULL
     -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
     AND s."finished_at" IS NULL
     AND s."starts_task_work"
     AND (
       t."id" = NEW."id"
       OR (t."verifies_task_id" = NEW."id"
           AND t."terminal_reason" IS NULL AND t."superseded_by_task_id" IS NULL)
     )
   ORDER BY s."id" LIMIT 1;

  IF live_id IS NOT NULL THEN
    -- Deliberately not "interrupt it": INTERRUPTED is one of the four statuses this guard counts
    -- as live, so that advice would name an action which leaves the same refusal in place. What
    -- releases the task is the run reaching a terminal status of its own.
    RAISE EXCEPTION
      'TASK_RETIRED_WHILE_RUNNING: task % still has a live session (% is %), so it cannot be recorded as replaced — wait for that run to reach SUCCEEDED, FAILED or CANCELLED first',
      NEW."id", live_id, live_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DO $d4$
DECLARE
  tries integer := 0;
  others text;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;

      DROP TRIGGER IF EXISTS "session_aa_status_from_facts" ON "session";
      DROP FUNCTION IF EXISTS session_status_from_facts();
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_agrees_chk";
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_fact_chk";

      CREATE OR REPLACE TRIGGER "session_acquisition_engine_guard"
        BEFORE UPDATE OF "turn_state", "inbox_lease_owner", "inbox_lease_generation"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_session_engine_acquisition();
      CREATE OR REPLACE TRIGGER "session_admission_lock_order_update"
        BEFORE UPDATE OF "task_id", "deleted_at", "starts_task_work", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_admission_lock_order();
      CREATE OR REPLACE TRIGGER "session_antigravity_runner_claim_guard"
        BEFORE UPDATE OF "turn_state"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_antigravity_runner_claim();
      CREATE OR REPLACE TRIGGER "session_cursor_runner_acquisition_guard"
        BEFORE UPDATE OF "turn_state", "inbox_lease_owner", "inbox_lease_generation"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_cursor_runner_acquisition();
      CREATE OR REPLACE TRIGGER "session_dsh_runner_acquisition_guard"
        BEFORE UPDATE OF "turn_state", "inbox_lease_owner", "inbox_lease_generation"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_dsh_runner_acquisition();
      CREATE OR REPLACE TRIGGER "session_listed_at_settle"
        BEFORE UPDATE OF "completed_at", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_listed_at_on_settle();
      CREATE OR REPLACE TRIGGER "session_opencode_runner_claim_guard"
        BEFORE UPDATE OF "turn_state"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_opencode_runner_claim();
      CREATE OR REPLACE TRIGGER "session_project_capacity_serialize_update"
        BEFORE UPDATE OF "task_id", "deleted_at", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_project_capacity_serialize();
      CREATE OR REPLACE TRIGGER "session_request_asker_stopped"
        AFTER UPDATE OF "turn_state", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (((new.deleted_at IS NOT NULL) OR (new.completed_at IS NOT NULL) OR (new.archived_at IS NOT NULL) OR ((new.finished_at IS NOT NULL) AND ((NOT ((new.finished_at IS NOT NULL) AND (new.end_reason IS NULL) AND (NOT (new.last_turn_outcome IS DISTINCT FROM 'FAILED'::text)))) OR ((new.retry_at IS NULL) AND (NOT ((old.retry_at IS NOT NULL) AND (new.retry_attempts > old.retry_attempts)))))) OR ((session_held_turn_state(new.*) = 'ABANDONED'::text) AND (COALESCE(new.end_reason, ''::text) <> ''::text)) OR ((new.finished_at IS NULL) AND (session_held_turn_state(new.*) IS NULL) AND (new.retry_at IS NULL) AND (((old.retry_at IS NOT NULL) AND (new.retry_attempts <= old.retry_attempts)) OR (new.retry_attempts < old.retry_attempts) OR ((old.retry_claimed_at IS NOT NULL) AND (new.retry_claimed_at IS NULL))))))
        EXECUTE FUNCTION session_request_asker_stopped();
      CREATE OR REPLACE TRIGGER "session_request_recipient_ended"
        AFTER UPDATE OF "turn_state", "end_reason", "retry_at", "retry_attempts", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (((new.deleted_at IS NOT NULL) OR (new.completed_at IS NOT NULL) OR (new.archived_at IS NOT NULL) OR ((new.finished_at IS NOT NULL) AND ((NOT ((new.finished_at IS NOT NULL) AND (new.end_reason IS NULL) AND (NOT (new.last_turn_outcome IS DISTINCT FROM 'FAILED'::text)))) OR ((new.retry_at IS NULL) AND (NOT ((old.retry_at IS NOT NULL) AND (new.retry_attempts > old.retry_attempts)))))) OR ((session_held_turn_state(new.*) = 'ABANDONED'::text) AND (COALESCE(new.end_reason, ''::text) <> ''::text))))
        EXECUTE FUNCTION session_request_recipient_ended();
      CREATE OR REPLACE TRIGGER "session_superseded_task_revive_guard"
        BEFORE UPDATE OF "task_id", "dispatch_origin", "deleted_at", "starts_task_work", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_superseded_task_guard();
      CREATE OR REPLACE TRIGGER "session_zz_phase"
        BEFORE INSERT OR UPDATE OF "turn_state", "finished_at", "engine_turn_active", "running_subagents", "running_bg_jobs", "retry_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_phase_from_facts();
      CREATE OR REPLACE TRIGGER "task_owner_confirmation_review_reviewer_ended"
        AFTER UPDATE OF "turn_state", "end_reason", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (((new.deleted_at IS NOT NULL) OR (new.completed_at IS NOT NULL) OR (new.archived_at IS NOT NULL) OR ((new.finished_at IS NOT NULL) AND (NOT ((new.finished_at IS NOT NULL) AND (new.end_reason IS NULL) AND (NOT (new.last_turn_outcome IS DISTINCT FROM 'FAILED'::text))))) OR ((session_held_turn_state(new.*) = 'ABANDONED'::text) AND (COALESCE(new.end_reason, ''::text) <> ''::text))))
        EXECUTE FUNCTION task_owner_confirmation_review_reviewer_ended();

      DROP FUNCTION IF EXISTS session_turn_state_of_status(run_status);
      DROP FUNCTION IF EXISTS session_legacy_status(timestamp, text, text, text, timestamp, text, text, text, text);

      -- Nothing but the column's own default and six indexes may still depend on it, and nothing but the column, those
      -- and the type's own array on the type.
      SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), ', ')
        INTO others
        FROM pg_depend d
       WHERE ((d.refclassid = 'pg_class'::regclass AND d.refobjid = '"session"'::regclass
               AND d.refobjsubid = (SELECT a.attnum FROM pg_attribute a
                                     WHERE a.attrelid = '"session"'::regclass AND a.attname = 'status' AND NOT a.attisdropped))
              OR (d.refclassid = 'pg_type'::regclass
                  AND d.refobjid IN (to_regtype('public.run_status'), to_regtype('public._run_status'))))
         AND NOT (d.classid = 'pg_class'::regclass AND d.objid = ANY (ARRAY(SELECT i.indexrelid FROM pg_index i
                    WHERE i.indrelid = '"session"'::regclass AND i.indexrelid::regclass::text IN (
                      'session_status_idx', 'session_assigned_runner_id_status_idx', 'session_batch_id_status_idx',
                      'session_owner_status_task_idx', 'session_root_session_id_status_idx',
                      'session_over_capacity_pending_idx'))))
         AND NOT (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT ad.oid FROM pg_attrdef ad
                    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
                   WHERE ad.adrelid = '"session"'::regclass AND a.attname = 'status'))
         AND NOT (d.classid = 'pg_class'::regclass AND d.objid = '"session"'::regclass
                  AND d.refclassid = 'pg_type'::regclass)
         AND NOT (d.classid = 'pg_type'::regclass AND d.deptype = 'i');
      IF others IS NOT NULL THEN
        RAISE EXCEPTION 'SESSION_STATUS_STILL_NAMED: session.status or run_status is still used by %: nothing was dropped', others;
      END IF;

      -- pg_depend does not track what a function body names.
      WITH f AS (
        SELECT p.oid, p.proname, p.proargtypes,
               regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '/\*.*?\*/', '', 'g') AS body
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
      )
      SELECT string_agg(f.proname, ', ' ORDER BY f.proname)
        INTO others
        FROM f
       WHERE f.body ~* '\mrun_status\M'
          OR (EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = f.oid AND NOT t.tgisinternal AND t.tgrelid = '"session"'::regclass)
              AND f.body ~* '\m(new|old)\s*\.\s*"?status\M')
          OR ('"session"'::regtype = ANY (f.proargtypes::oid[]) AND f.body ~* '\.\s*"?status\M')
          OR EXISTS (SELECT 1 FROM regexp_matches(f.body, '(\w+)\s+(?:"?public"?\.)?"?session"?\s*%\s*rowtype', 'gi') AS v(m)
                      WHERE f.body ~* ('(?<![\w.])' || v.m[1] || '\s*\.\s*"?status\M'))
          OR EXISTS (SELECT 1 FROM regexp_split_to_table(f.body, ';') AS s(statement)
                       CROSS JOIN LATERAL regexp_matches(s.statement,
                         '\m(from|join|update|into)\s+(?:only\s+)?(?:"?public"?\.)?"?session"?(?![\w"])(?:\s+(?:as\s+)?([a-z_]\w*))?', 'gi') AS t(m)
                      WHERE s.statement ~* ('(?<![\w.])"?' || CASE WHEN t.m[2] IS NULL
                              OR t.m[2] ~* '^(set|where|on|inner|left|join|for|order|group|limit)$' THEN 'session' ELSE t.m[2] END
                              || '"?\s*\.\s*"?status\M')
                         OR (lower(t.m[1]) = 'update' AND s.statement ~* '\mset\M.*(?<![\w.])"?status"?\s*='));
      IF others IS NOT NULL THEN
        RAISE EXCEPTION 'SESSION_STATUS_STILL_NAMED: these functions still name session.status or run_status: %: nothing was dropped', others;
      END IF;

      ALTER TABLE "session" DROP COLUMN IF EXISTS "status";
      DROP TYPE IF EXISTS run_status;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $d4$;
