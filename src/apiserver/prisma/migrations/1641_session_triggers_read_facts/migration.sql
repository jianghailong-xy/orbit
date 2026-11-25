-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1641: the session triggers and functions read the facts, not the stored word (docs/session-status-retirement-plan.md
-- §2.8, §4.2, deploy D2; project 353SgnUjvamRr06Sho0EZ, task T6).
--
-- WHAT IT CHANGES
-- ---------------
-- One new function, nine functions restated and three trigger WHEN clauses restated. Each body is the one a database
-- migrated through 1634 holds (pg_get_functiondef), with only the reads of the word replaced; the WHEN clauses are
-- 1442's, likewise. sessions/session-triggers-read-facts.pg.spec.ts holds each new body to the old one with exactly
-- these replacements, and drives the same rows through both:
--
--   session_held_turn_state(session)   NEW. A held session's turn state, QUEUED, IN_FLIGHT, ABANDONED or NULL (parked
--                                      or released): the column, or for a held row with none its stored word's. The
--                                      SQL twin of turnStateOf / sessionTurnStateSql (sessions/session-turn-state.ts),
--                                      and the one database object a restated body reaches the stored word through.
--   guard_session_engine_acquisition, guard_opencode_runner_claim, guard_antigravity_runner_claim,
--   guard_cursor_runner_acquisition, guard_dsh_runner_acquisition
--       the claim  OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING'
--               -> session_held_turn_state(OLD) = 'QUEUED' AND session_held_turn_state(NEW) = 'IN_FLIGHT'
--       the revive NEW."status" = 'PENDING'  ->  session_held_turn_state(NEW) = 'QUEUED'
--   open_list_bump_owner (workspace rows)
--       s.status = 'PENDING'  ->  session_held_turn_state(s) = 'QUEUED'
--   session_listed_at_on_settle
--       a word moved to SUCCEEDED, FAILED or CANCELLED  ->  released now (finished_at set where it was not), or
--       released again (finished_at rewritten) over a row that did not read FAILED
--   session_request_recipient_ended
--       close_reason's word  NEW."status"::text  ->  session_legacy_status(...) of the row (migration 1621)
--   task_supersession_live_session_guard (on task; reads a live session's word into its error text)
--       s."status"::text  ->  session_legacy_status(...) of the held row
--   triggers session_request_recipient_ended, session_request_asker_stopped, task_owner_confirmation_review_reviewer_ended
--       NEW."status" = 'INTERRUPTED'     ->  session_held_turn_state(NEW) = 'ABANDONED'
--       NEW."status" = 'AWAITING_INPUT'  ->  NEW."finished_at" IS NULL AND session_held_turn_state(NEW) IS NULL
--
-- WHY EVERY ROW GETS TODAY'S ANSWER
-- ---------------------------------
-- For every row the CHECKs admit, session_held_turn_state(row) is session_turn_state_of_status(row.status): a set
-- turn_state is the word's (session_turn_state_agrees_unless_null_chk, 1622), a NULL one reads the word, and a
-- released row reads NULL either way (session_release_fact_chk: a terminal word exactly when finished_at is set).
-- So `= 'QUEUED'` is `status = 'PENDING'`, IN_FLIGHT is RUNNING, ABANDONED is INTERRUPTED, and held with none is
-- AWAITING_INPUT (or the label PARKED, which nothing writes: 0071 rewrote every such row, and the census of
-- scripts/session-turn-state-census.sql counts it, expected 0). The guards are BEFORE triggers named after
-- session_aa_turn_state_from_status, which has already derived NEW."turn_state" from a word the statement writes;
-- the WHEN clauses are AFTER triggers, which see the row as every BEFORE trigger left it.
--
-- The NULL fallback is the project's deploy-order rule (2026-11-25): this file may reach production before the
-- backfill (task T3) has filled turn_state, so a held row with none still answers from its stored word, here as in
-- the TypeScript readers. Task T14 removes the fallback from session_held_turn_state, with the column's writers;
-- every caller stays as it is.
--
-- The two that read a word, through the projector's SQL twin:
--   * close_reason: a held row reaches it only when INTERRUPTED, which the projector gives back exactly. A released
--     row reads the projected word, which differs from the stored one only for the released kinds of plan §3.4
--     (C1-C7), which the owner accepted (ruling 353WVx0cafF9ciLRebN3Z). A LANDING container reads its project_landing
--     settlement (P3); every writer of one sets completed_at with finished_at, so its close_reason is COMPLETED anyway.
--   * the supersession guard's error text: held rows only, which the projector gives back exactly.
--
-- session_listed_at_on_settle: every release writes finished_at in the statement that writes its word, so "a word
-- moved to a terminal one" is "finished_at set where it was not", except for a row released again. The one writer
-- that does that is the failed transcript import (runner-api importResult, plan §2.2 #16): it writes FAILED and a new
-- finished_at over whatever the row held, and moved listed_at exactly when the row was not FAILED before. "The row did
-- not read FAILED" is session_legacy_status of OLD, which for a released row reads only the release facts (P3 never
-- gives FAILED, so the landing settlement is not looked up). It answers as the stored word did except for the §3.4
-- kinds stored FAILED that now read another word (C1-C3, C6), where a failed import over one moves listed_at.
--
-- WHAT IT DOES NOT CHANGE
-- -----------------------
-- No column list. Every one still names status, and none gains turn_state or finished_at (the plan's §4.2 adds them in
-- this deploy): every writer of this deploy writes the word, so the triggers fire on exactly the statements they
-- fire on today, and the backfill (T3), which writes turn_state alone and may run after this file, fires none of
-- them. Task T14, whose writers stop writing the word, adds turn_state (and finished_at to session_listed_at_settle)
-- where each list loses status. session_admission_lock_order_update, session_project_capacity_serialize_update and
-- session_superseded_task_revive_guard already read finished_at and are not touched; the indexes and
-- session_release_fact_chk are T5's and T15's.
--
-- WHICH RELEASE IT MAY SHIP IN, ROLLBACK
-- --------------------------------------
-- Any after 1611, 1621 and 1622, with or without the backfill: every answer is today's (above). Rolling the code back
-- is free; rolling this file back is re-running the bodies of 1424, 1425, 1442, 1464, 1490 and 1421, and
-- DROP FUNCTION session_held_turn_state.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE FUNCTION takes no table lock. CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on session: the
-- three are asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries (1261, 1401, 1442, 1611). The file
-- holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction: the functions and the triggers
-- change together. Nothing in it COMMITs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1641: main, every project/* and every pushed orbit/* and probe/* branch use up to 1634, and no local worktree has
-- more (scanned 2026-11-25). Not a multiple of 10. Can run twice: CREATE OR REPLACE throughout.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION session_held_turn_state(s "session") RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN s."finished_at" IS NULL
              THEN COALESCE(s."turn_state", session_turn_state_of_status(s."status")) END
$$;

CREATE OR REPLACE FUNCTION guard_session_engine_acquisition()
RETURNS trigger AS $$
BEGIN
    IF NEW."engine" IS NULL
       OR COALESCE(current_setting('orbit.claim_reads_session_engine', true), '0') = '1' THEN
        RETURN NEW;
    END IF;
    IF session_held_turn_state(OLD) = 'QUEUED' AND session_held_turn_state(NEW) = 'IN_FLIGHT' THEN
        RETURN NULL;
    END IF;
    IF (NEW."inbox_lease_owner" IS NOT NULL
        AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
        -- A revive: OLD released (`finished_at` set, session_release_fact_chk 1401/1402), NEW queued again.
        AND NOT (OLD."finished_at" IS NOT NULL
                 AND session_held_turn_state(NEW) = 'QUEUED'
                 AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
       OR (NEW."inbox_lease_generation" IS NOT NULL
           AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation") THEN
        RAISE EXCEPTION 'session % runs on %, and this API version does not read session engines; retry against a current replica', NEW."id", NEW."engine"
          USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_opencode_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF session_held_turn_state(OLD) = 'QUEUED'
       AND session_held_turn_state(NEW) = 'IN_FLIGHT'
       AND (NEW."engine" = 'opencode' OR (NEW."engine" IS NULL AND NEW."provider" = 'opencode'))
       AND COALESCE(current_setting('orbit.runner_supports_opencode', true), '0') <> '1' THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF session_held_turn_state(OLD) = 'QUEUED'
       AND session_held_turn_state(NEW) = 'IN_FLIGHT'
       AND COALESCE(current_setting('orbit.runner_supports_antigravity', true), '0') <> '1'
       AND (
           NEW."engine" = 'antigravity'
           OR (NEW."engine" IS NULL AND (
               NEW."provider" = 'antigravity'
               OR (NOT (NEW."provider" = 'dsh' AND NEW."provider_builtin") AND EXISTS (
                   SELECT 1 FROM "model_provider" mp
                   WHERE mp."slug" = NEW."provider"
                     AND mp."runtime" = 'antigravity'
                     AND mp."enabled"
                     AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
               ))
           ))
       ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_cursor_runner_acquisition()
RETURNS trigger AS $$
BEGIN
    IF (
           (session_held_turn_state(OLD) = 'QUEUED' AND session_held_turn_state(NEW) = 'IN_FLIGHT')
           OR (NEW."inbox_lease_owner" IS NOT NULL
               AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
               -- A revive: OLD released (`finished_at` set, session_release_fact_chk 1401/1402), NEW queued again.
               AND NOT (OLD."finished_at" IS NOT NULL
                        AND session_held_turn_state(NEW) = 'QUEUED'
                        AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
           OR (NEW."inbox_lease_generation" IS NOT NULL
               AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation")
       )
       AND COALESCE(NEW."engine", NEW."provider") = 'cursor' THEN
        IF COALESCE(current_setting('orbit.runner_supports_cursor', true), '0') <> '1' THEN
            RETURN NULL;
        END IF;
        -- Keep the heartbeat declaration true through acquisition commit. The Session row is already
        -- locked, so never wait in the reverse runner -> session deletion order: a heartbeat or delete
        -- holding the runner makes this attempt skip and the poll retry.
        BEGIN
            PERFORM 1 FROM "runner" r
            WHERE r."id" = NEW."assigned_runner_id"
              AND r."owner_id" = NEW."owner_id"
              AND r."capabilities_reported_at" IS NOT NULL
              AND 'provider:cursor' = ANY(r."capabilities")
            FOR SHARE NOWAIT;
            IF NOT FOUND THEN RETURN NULL; END IF;
        EXCEPTION WHEN lock_not_available THEN
            RETURN NULL;
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_dsh_runner_acquisition()
RETURNS trigger AS $$
BEGIN
    IF (
           (session_held_turn_state(OLD) = 'QUEUED' AND session_held_turn_state(NEW) = 'IN_FLIGHT')
           OR (NEW."inbox_lease_owner" IS NOT NULL
               AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
               -- A server terminal revive reserves a v5 handoff marker while queuing; it is
               -- not a runner process acquiring the runtime. The actual claim/takeover still
               -- passes every gate when it replaces this marker with the runner's v4 owner.
               -- A revive: OLD released (`finished_at` set, session_release_fact_chk 1401/1402), NEW queued again.
               AND NOT (OLD."finished_at" IS NOT NULL
                        AND session_held_turn_state(NEW) = 'QUEUED'
                        AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
           OR (NEW."inbox_lease_generation" IS NOT NULL
               AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation")
       )
       AND (
           NEW."engine" = 'dsh'
           OR (NEW."engine" IS NULL AND (
               (NEW."provider" = 'dsh' AND NEW."provider_builtin")
               OR (NOT NEW."provider_builtin" AND EXISTS (
                   SELECT 1 FROM "model_provider" mp
                   WHERE mp."slug" = NEW."provider"
                     AND mp."runtime" = 'dsh'
                     AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
               ))
           ))
       ) THEN
        IF COALESCE(current_setting('orbit.runner_supports_dsh', true), '0') <> '1' THEN
            RETURN NULL;
        END IF;
        IF NEW."engine" IS NULL THEN
            IF NOT NEW."provider_builtin" AND NOT EXISTS (
                SELECT 1 FROM "model_provider" mp
                WHERE mp."slug" = NEW."provider" AND mp."runtime" = 'dsh' AND mp."enabled"
                  AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
            ) THEN
                RETURN NULL;
            END IF;
        ELSIF NOT (NEW."provider" = 'dsh' AND NEW."provider_builtin") AND NOT EXISTS (
            SELECT 1 FROM "model_provider" mp
            WHERE mp."slug" = NEW."provider" AND mp."enabled"
              AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
        ) AND NOT EXISTS (
            SELECT 1 FROM "provider_slug_alias" a
            JOIN "model_provider" mp ON mp."id" = a."provider_id"
            WHERE a."slug" = NEW."provider" AND mp."enabled"
              AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
        ) THEN
            RETURN NULL;
        END IF;
        -- Keep the heartbeat declaration true through acquisition commit. The Session row is
        -- already locked, so never wait in the reverse runner -> session deletion order: a
        -- heartbeat/delete holding the runner makes this attempt skip and the poll retry.
        BEGIN
            PERFORM 1 FROM "runner" r
            WHERE r."id" = NEW."assigned_runner_id"
              AND r."owner_id" = NEW."owner_id"
              AND r."capabilities_reported_at" IS NOT NULL
              AND 'provider:dsh' = ANY(r."capabilities")
            FOR SHARE NOWAIT;
            IF NOT FOUND THEN RETURN NULL; END IF;
        EXCEPTION WHEN lock_not_available THEN
            RETURN NULL;
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION open_list_bump_owner()
RETURNS trigger AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
  k text;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'project_integration_job' THEN
    FOR o IN EXECUTE
      'SELECT DISTINCT n.owner_id
         FROM new_rows n JOIN old_rows d ON d.id = n.id
        WHERE n.state <> ''RUNNING'' OR d.state <> ''RUNNING''
           OR (to_jsonb(n) - ''heartbeat_at'' - ''updated_at'' - ''phase'' - ''round'' - ''step''
                - ''step_started_at'' - ''output_moved_at'' - ''current_check'')
              IS DISTINCT FROM
              (to_jsonb(d) - ''heartbeat_at'' - ''updated_at'' - ''phase'' - ''round'' - ''step''
                - ''step_started_at'' - ''output_moved_at'' - ''current_check'')
       UNION
       SELECT d.owner_id
         FROM new_rows n JOIN old_rows d ON d.id = n.id
        WHERE n.owner_id IS DISTINCT FROM d.owner_id'
    LOOP
      PERFORM open_list_bump(o, src);
    END LOOP;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'workspace' THEN
    FOR o, k IN EXECUTE CASE TG_OP
        WHEN 'INSERT' THEN $q$
          SELECT DISTINCT owner_id, open_list_scope_key('workspace', id, true) FROM new_rows $q$
        WHEN 'DELETE' THEN $q$
          SELECT DISTINCT owner_id, open_list_scope_key('workspace', id, true) FROM old_rows $q$
        ELSE $q$
          WITH moved AS (
            SELECT n.id, n.owner_id AS new_owner, d.owner_id AS old_owner
              FROM new_rows n JOIN old_rows d ON d.id = n.id
             WHERE (to_jsonb(n) - $1) IS DISTINCT FROM (to_jsonb(d) - $1)
                OR (n.work_dir_free_bytes IS DISTINCT FROM d.work_dir_free_bytes AND EXISTS (
                     SELECT 1 FROM session s JOIN runner r ON r.id = s.assigned_runner_id
                      WHERE s.workspace_id = n.id AND session_held_turn_state(s) = 'QUEUED' AND s.started_at IS NULL
                        AND r.min_free_disk_mb > 0
                        AND (n.work_dir_free_bytes IS NOT NULL AND n.work_dir_free_bytes < r.min_free_disk_mb::bigint * 1048576)
                            IS DISTINCT FROM
                            (d.work_dir_free_bytes IS NOT NULL AND d.work_dir_free_bytes < r.min_free_disk_mb::bigint * 1048576))))
          SELECT new_owner, open_list_scope_key('workspace', id, true) FROM moved
          UNION
          SELECT old_owner, open_list_scope_key('workspace', id, true) FROM moved $q$
      END
      USING ARRAY[
        'work_dir_exists', 'work_dir_is_git', 'work_dir_probed_at', 'work_dir_free_bytes', 'work_dir_total_bytes',
        'repo_url'
      ]::text[]
    LOOP
      PERFORM open_list_bump(o, k);
    END LOOP;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'session_request' THEN
    FOR o, k IN EXECUTE CASE TG_OP
        WHEN 'INSERT' THEN $q$
          WITH peers AS (SELECT owner_id, from_session_id AS id FROM new_rows
                         UNION SELECT owner_id, to_session_id FROM new_rows)
          SELECT p.owner_id, open_list_scope_key('session_request', s.workspace_id, bool_or(
                   s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                   AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
            FROM peers p LEFT JOIN session s ON s.id = p.id
           GROUP BY p.owner_id, s.workspace_id $q$
        WHEN 'DELETE' THEN $q$
          WITH peers AS (SELECT owner_id, from_session_id AS id FROM old_rows
                         UNION SELECT owner_id, to_session_id FROM old_rows)
          SELECT p.owner_id, open_list_scope_key('session_request', s.workspace_id, bool_or(
                   s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                   AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
            FROM peers p LEFT JOIN session s ON s.id = p.id
           GROUP BY p.owner_id, s.workspace_id $q$
        ELSE $q$
          WITH peers AS (SELECT owner_id, from_session_id AS id FROM new_rows
                         UNION SELECT owner_id, to_session_id FROM new_rows
                         UNION SELECT owner_id, from_session_id FROM old_rows
                         UNION SELECT owner_id, to_session_id FROM old_rows)
          SELECT p.owner_id, open_list_scope_key('session_request', s.workspace_id, bool_or(
                   s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                   AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
            FROM peers p LEFT JOIN session s ON s.id = p.id
           GROUP BY p.owner_id, s.workspace_id $q$
      END
    LOOP
      PERFORM open_list_bump(o, k);
    END LOOP;
    RETURN NULL;
  END IF;

  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT owner_id FROM new_rows'
      WHEN 'DELETE' THEN 'SELECT DISTINCT owner_id FROM old_rows'
      ELSE 'SELECT owner_id FROM new_rows UNION SELECT owner_id FROM old_rows'
    END
  LOOP
    PERFORM open_list_bump(o, src);
  END LOOP;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION session_listed_at_on_settle()
RETURNS trigger AS $$
BEGIN
  IF (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NULL)
     OR (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NOT NULL
         AND NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
         AND session_legacy_status(OLD."finished_at", NULL, OLD."end_reason", OLD."last_turn_outcome", OLD."started_at",
                                   OLD."import_source_cwd", OLD."kind", NULL, NULL) <> 'FAILED')
     OR (NEW."completed_at" IS NOT NULL AND OLD."completed_at" IS NULL) THEN
    NEW."listed_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION session_request_recipient_ended()
RETURNS trigger AS $$
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
                      (SELECT pl."settled_as" FROM "project_landing" pl WHERE pl."session_id" = NEW."id") END,
                    NULL)
           END || COALESCE(':' || NULLIF(NEW."end_reason", ''), ''),
         "closed_at" = CURRENT_TIMESTAMP
   WHERE "to_session_id" = NEW."id" AND "state" = 'OPEN';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION task_supersession_live_session_guard()
RETURNS trigger AS $$
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
                                       s."started_at", s."import_source_cwd", s."kind", NULL, NULL)
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
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE OR REPLACE TRIGGER "session_request_recipient_ended"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (session_held_turn_state(NEW) = 'ABANDONED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "session_request_recipient_ended"();

      CREATE OR REPLACE TRIGGER "session_request_asker_stopped"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (session_held_turn_state(NEW) = 'ABANDONED' AND COALESCE(NEW."end_reason", '') <> '')
          OR (NEW."finished_at" IS NULL AND session_held_turn_state(NEW) IS NULL AND NEW."retry_at" IS NULL
              AND ((OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" <= OLD."retry_attempts")
                   OR NEW."retry_attempts" < OLD."retry_attempts"
                   OR (OLD."retry_claimed_at" IS NOT NULL AND NEW."retry_claimed_at" IS NULL)))
        )
        EXECUTE FUNCTION "session_request_asker_stopped"();

      CREATE OR REPLACE TRIGGER "task_owner_confirmation_review_reviewer_ended"
        AFTER UPDATE OF "status", "end_reason", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL AND NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED'))
          OR (session_held_turn_state(NEW) = 'ABANDONED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "task_owner_confirmation_review_reviewer_ended"();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
