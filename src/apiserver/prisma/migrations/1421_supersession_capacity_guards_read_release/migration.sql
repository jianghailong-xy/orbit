-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1421: the 0130 guards read the release fact, not the status (docs/session-three-state-plan.md §7 step 4.4,
-- appendix A of docs/session-three-state-read-sites.md; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT CHANGES
-- ---------------
-- Three functions, each replaced with its live body and only the lines below changed:
--
--   session_superseded_task_guard (0130; triggers session_superseded_task_guard, ..._revive_guard)
--     was  IF NEW."status" NOT IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') OR ...
--     now  IF NEW."finished_at" IS NOT NULL OR ...
--     was  AND OLD."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
--     now  AND OLD."finished_at" IS NULL
--   task_supersession_live_session_guard (0130; trigger on task)
--     was  AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
--     now  AND s."finished_at" IS NULL
--   session_project_capacity_serialize (0130; triggers from 0122)
--     was  AND OLD."status" IN (...the four...);   AND NEW."status" IN (...the four...);
--     now  AND OLD."finished_at" IS NULL;          AND NEW."finished_at" IS NULL;
--
-- Two trigger column lists gain "finished_at", re-created in place with CREATE OR REPLACE TRIGGER (same name,
-- table, timing and function):
--   session_superseded_task_revive_guard        BEFORE UPDATE OF status, task_id, dispatch_origin, deleted_at,
--                                               starts_task_work, finished_at
--   session_project_capacity_serialize_update   BEFORE UPDATE OF status, task_id, deleted_at, finished_at
--
-- WHY EVERY STORED ROW GETS THE SAME ANSWER
-- -----------------------------------------
-- session_release_fact_chk (1401, validated by 1402) holds every row to: the status is SUCCEEDED, FAILED or
-- CANCELLED exactly when finished_at is set. The status type has one more label, PARKED, which no row holds:
-- 0071 moved every PARKED row to CANCELLED, nothing writes it since (the Prisma enum omits it, so Prisma could
-- not even read such a row). So for every row the CHECK admits, "status is one of the four held values" and
-- "finished_at is null" are the same test, OLD and NEW alike, and each function answers exactly what it
-- answered before. The error texts still name the status the row holds: that is a display of the legacy
-- word, not a decision.
--
-- WHY THE COLUMN LISTS
-- --------------------
-- A trigger declared UPDATE OF a column set does not fire for a write that names none of them (the restore()
-- case 0130 describes beside this function's deleted_at test). Today every release and every revive writes
-- status and finished_at in one statement, so no write is missed either way; once a write may carry the
-- release fact without the status word, the list has to name the column the functions now read. Adding a
-- column only adds firings, and each extra firing reaches the functions' own no-change early return.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE FUNCTION takes no table lock. CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on
-- session: asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries, as 1261 does. No column,
-- constraint, index or type; no INSERT, UPDATE or DELETE. session_task_execution_claim_idx is untouched
-- (plan step 4.5 swaps it, in two releases).
-- How it is sent: the file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction:
-- the function replacements and the triggers commit together, and the trigger locks are held until that one
-- commit. Nothing in it COMMITs. sessions/session-release.pg.spec.ts (12) applies it that way, with deployAgain,
-- on a database holding rows.
--
-- WHICH REPLICAS
-- --------------
-- Every replica since 1402 writes status and finished_at together (the CHECK refuses anything else), so the
-- old and the new spelling of each write agree and a replica of either release meets the same guards.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1421: main uses up to 1411 (1410_session_bg_job_stop_requests, 1411_coordinator_handoff_successor) and no
-- origin/project/* or origin/orbit/* branch uses a higher number but this project's own (rescanned 2026-11-21
-- 11:05Z); it starts 10 above main's highest so that main's next migration does not collide at once. Written as
-- 1411 to 1416 on the project line until main took 1411. Not a multiple of 10.
-- Can run twice: CREATE OR REPLACE throughout.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.session_superseded_task_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  subject_id UUID;
  retired    RECORD;
BEGIN
  IF NEW."task_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only a row that IS or IS BECOMING live-and-visible can start work, so only those are asked
  -- about. `deleted_at` belongs in this test and in the trigger's column list: a soft-deleted row is
  -- not live for any purpose (nothing counts it, no claim index covers it), so `restore()` — which
  -- writes nothing but `deleted_at = NULL` — is a transition INTO live and has to be judged as one.
  -- Released is `finished_at` set (session_release_fact_chk, 1401/1402: set exactly when the status is terminal).
  IF NEW."finished_at" IS NOT NULL
     OR NEW."deleted_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- An UPDATE of a row that was ALREADY live on this same task is not a revival — it is a live run
  -- moving between live statuses (RUNNING → AWAITING_INPUT and back, every turn of every session).
  -- Refusing those would stop the salvage runs this guard deliberately permits, mid-conversation.
  --
  -- Every field the exemption below reads is in this condition, because a fast path that ignored
  -- one would be a way to acquire the exemption by writing it: a live USER session flipped to
  -- `starts_task_work` (or to an automated origin) would otherwise skip the check entirely and end
  -- up as exactly the thing this guard refuses to create.
  IF TG_OP = 'UPDATE'
     AND OLD."task_id" IS NOT DISTINCT FROM NEW."task_id"
     -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
     AND OLD."finished_at" IS NULL
     AND OLD."deleted_at" IS NULL
     AND OLD."dispatch_origin" IS NOT DISTINCT FROM NEW."dispatch_origin"
     AND OLD."starts_task_work" IS NOT DISTINCT FROM NEW."starts_task_work" THEN
    RETURN NEW;
  END IF;

  -- THE LOCK COMES FIRST, FOR EVERY ORIGIN.
  -- ---------------------------------------
  -- Taking it before the USER exemption is the whole of the bidirectional serialization, and
  -- returning early for USER — which is what this guard did first — quietly removed it: a
  -- retirement could lock the task, see no live Session, and commit, while a USER insert that took
  -- no lock at all committed beside it. Two legal transactions, and the state they left is a live
  -- run executing a task the control plane had marked replaced.
  --
  -- Locked now, the two orders are the only two and both have an answer: the Session commits first
  -- and the retirement's own guard sees the live claim and refuses; or the retirement commits first
  -- and this insert waits, then reads the final state below.
  --
  -- The verification's SUBJECT is locked too when there is one, because a check is obsolete when
  -- the work it checks was replaced — the same derived rule §7.4's gate applies — and the subject's
  -- retirement can be committed concurrently by the same kind of transaction. Both ids in ONE
  -- statement ordered by id (§8.6 LO2), so two sessions on a verifier/subject pair cannot take them
  -- in opposite orders.
  -- The verifier row FIRST, and its link read THROUGH that lock. Reading `verifies_task_id`
  -- before locking and then locking the pair it named is a TOCTOU: a concurrent repoint of this
  -- verifier from an active subject onto a retired one commits in between, and this statement goes
  -- on checking the subject the row no longer names. Locked first, the link cannot move — changing
  -- it requires an UPDATE of this very row, which this FOR SHARE blocks — so what is read below is
  -- what will still be true at commit.
  --
  -- Two acquisitions, verifier then subject, and they cannot invert: the only transaction that
  -- takes both is this one, and a session opened on a SUBJECT takes that row plus whatever IT
  -- verifies, never back up to its own verifier.
  SELECT t."verifies_task_id" INTO subject_id
    FROM "task" t WHERE t."id" = NEW."task_id" FOR SHARE;
  IF subject_id IS NOT NULL THEN
    PERFORM 1 FROM "task" t WHERE t."id" = subject_id FOR SHARE;
  END IF;

  -- The salvage exemption, and it is available on INSERT ONLY.
  -- -------------------------------------------------------------
  -- Opening a NEW session against a replaced attempt is somebody deciding to read it, compare it
  -- with its successor, or take something out of it. `starts_task_work` is what makes that sentence
  -- checkable: Run Now says so on the row, a bare session_create does not. The origin test sits
  -- beside it and is not redundant — a binary written before that column defaults it to false, and
  -- an automated dispatch from one of those must still be refused.
  --
  -- A REVIVAL is never exempt, whoever appears to own the row. `dispatch_origin` records how a
  -- session was originally created and nothing rewrites it, so a FAILED session that a person
  -- started weeks ago still reads as USER — and the auto-retry sweep resumes exactly those. There
  -- is no field on the row that separates "a person is reviving this now" from "a sweep is", so the
  -- rule that can actually be enforced is the categorical one: a retired task's terminal sessions
  -- stay terminal. Salvage is still available, by the door above — open a new session against it.
  IF TG_OP = 'INSERT' AND NEW."dispatch_origin" = 'USER' AND NOT NEW."starts_task_work" THEN
    RETURN NEW;
  END IF;

  -- Both columns, never just the pointer. `ON DELETE SET NULL` (0128) means deleting the successor
  -- takes the pointer and leaves `terminal_reason = 'SUPERSEDED'` behind, and `ABANDONED` never had
  -- a pointer at all — a guard keyed on the pointer alone reads both of those as "never replaced".
  SELECT t."id", t."terminal_reason",
         (t."id" = NEW."task_id") AS is_self
    INTO retired
    FROM "task" t
   WHERE (t."id" = NEW."task_id" OR t."id" = subject_id)
     AND (t."terminal_reason" IS NOT NULL OR t."superseded_by_task_id" IS NOT NULL)
   ORDER BY (t."id" = NEW."task_id") DESC, t."id"
   LIMIT 1;

  IF FOUND THEN
    IF retired.is_self THEN
      RAISE EXCEPTION
        'TASK_SUPERSEDED: task % is %, so a run of its work may not be started — open a session against it directly if you mean to read or salvage the old run',
        NEW."task_id", COALESCE(retired."terminal_reason", 'SUPERSEDED')
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION
      'TASK_SUPERSEDED: task % verifies task %, which is % — a check of replaced work is obsolete',
      NEW."task_id", retired."id", COALESCE(retired."terminal_reason", 'SUPERSEDED')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
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
  SELECT s."id", s."status"::text INTO live_id, live_status
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

CREATE OR REPLACE FUNCTION public.session_project_capacity_serialize()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE old_live boolean; new_live boolean;
BEGIN
  -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
  old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
    AND OLD."deleted_at" IS NULL
    AND OLD."finished_at" IS NULL;
  new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL
    AND NEW."finished_at" IS NULL;
  IF TG_OP = 'UPDATE' AND old_live = new_live
     AND OLD."task_id" IS NOT DISTINCT FROM NEW."task_id" THEN
    RETURN NEW;
  END IF;
  UPDATE "project" SET "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" IN (
     SELECT "project_id" FROM "task"
      WHERE "id" IN (
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END
      ) AND "project_id" IS NOT NULL
   );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE OR REPLACE TRIGGER "session_superseded_task_revive_guard"
        BEFORE UPDATE OF "status", "task_id", "dispatch_origin", "deleted_at", "starts_task_work", "finished_at"
        ON "session"
        FOR EACH ROW EXECUTE FUNCTION "session_superseded_task_guard"();
      CREATE OR REPLACE TRIGGER "session_project_capacity_serialize_update"
        BEFORE UPDATE OF "status", "task_id", "deleted_at", "finished_at"
        ON "session"
        FOR EACH ROW EXECUTE FUNCTION "session_project_capacity_serialize"();
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
