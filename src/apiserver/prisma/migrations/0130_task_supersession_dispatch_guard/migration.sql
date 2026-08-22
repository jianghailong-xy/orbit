-- The database's own half of §13.6 SU6–SU8: a replaced attempt is not dispatchable, a running
-- attempt cannot be replaced, and "one live Session per task" means all four live statuses.
--
-- Migration 0128 gave supersession three columns and a guard that keeps the RELATION honest — same
-- tenant, same project, terminal status, acyclic. What it did not do, because §13.6 as written did
-- not say it, is give the columns any CONSEQUENCE. Every gate downstream still asked `status`, and
-- `status` cannot tell a failure that is being re-done from one that is not.
--
-- What that cost, in production, on 0.1.130: `ProjectFailureRecoveryService`'s boot scan selected a
-- `FAILED` task whose work a fresh attempt had already completed, re-armed its project's wake, the
-- §7.8 pass selected it, §9.2 admitted it, and the dispatcher minted a Session for a review that
-- was finished. Every clause was satisfied; the composition started work nobody asked for. The
-- service-side fix is in this same change — the scan, the pass, the turn planner, the blocker
-- detectors, aggregation and §9.2's commit-point gate all read the columns now.
--
-- The triggers here are the half that survives the binary. §2.4's reason for D5/D6 applies
-- literally: a service check exists only in the process that has it, and during a rolling deploy
-- the process that does NOT have it is still running, still holding a lease, and still able to
-- insert the Session this whole change exists to prevent. A hand-typed INSERT is the same case with
-- a person behind it.
--
-- ONE TRANSACTION, AND WHY THE LOCK ORDER IS WRITTEN DOWN
-- ======================================================
-- Prisma's PostgreSQL migration executor commits each top-level statement unless the migration
-- supplies its own transaction (0113 says the same thing and for the same reason). Left as loose
-- statements this migration has two windows, and both are the shape §2.4 keeps closing:
--
--   * between `DROP INDEX` and `CREATE UNIQUE INDEX` there is no execution claim at all. A failure
--     anywhere after the DROP — or a deploy killed mid-file — leaves a database whose D5 invariant
--     is simply gone, and nothing later notices, because the absence of an index is not an error;
--   * between the duplicate preflight and the rebuild, a concurrent dispatcher can insert exactly
--     the second live Session the preflight just proved absent. The CREATE then fails on data that
--     was legal when it was read, and the DROP above it has already committed.
--
-- So: explicit BEGIN/COMMIT, and the locks are taken BEFORE the preflight rather than acquired
-- implicitly by the DDL. Two tables, in a fixed order, and the order is not free:
--
--   `task` first, then `session`.
--
-- That is the order every writer of this pair already uses. The supersession link path takes the
-- task row (UPDATE / FOR UPDATE) and THEN reads sessions; `session_dispatch_authority_guard` and
-- the new `session_superseded_task_guard` insert into session and then take the task row FOR SHARE
-- — which needs only ROW SHARE on `task`, and ROW SHARE does not conflict with SHARE ROW EXCLUSIVE,
-- so an in-flight insert is never made to wait on this migration while this migration waits on it.
-- Taking `session` first would invert that against the link path and deadlock: a linker holding the
-- task row would block on ACCESS SHARE over a session table this migration had already locked
-- ACCESS EXCLUSIVE, while this migration blocked on its task row.
--
-- BOTH are taken ACCESS EXCLUSIVE up front, and that is deliberate rather than an over-reach. Each
-- is needed at full strength before this transaction ends — `session` for the index rebuild and the
-- added column, `task` for `ADD CONSTRAINT` — so anything weaker here is a lock this migration
-- ESCALATES halfway through. The escalation is where the cycle lives: holding `session` ACCESS
-- EXCLUSIVE and reaching for `task` ACCESS EXCLUSIVE, while a writer that already took a compatible
-- `task` ROW SHARE waits for `session`, is a deadlock neither side can be blamed for.
--
-- Taken up front, in the order below, there is no intermediate state for a waiter to queue into:
-- this migration either holds both tables or is waiting for the first, and whatever it waits for
-- started before it and will finish. The cost is a pause on `session` reads for the length of the
-- migration, which is short, and is the price of it being atomic at all.
--
-- Everything below therefore commits together or not at all. On any failure the old index and the
-- old triggers are exactly as they were — provable, because nothing outside this transaction ever
-- observes an intermediate state.

BEGIN;

LOCK TABLE "task" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------------------------
-- 1. SU6: automated dispatch may not start work on a replaced attempt.
-- ---------------------------------------------------------------------------------------------
--
-- Scope: AUTOMATED dispatch only. `dispatch_origin = 'USER'` is left alone, deliberately. A person
-- opening a session against a superseded attempt — to read it, to compare it with its successor, to
-- salvage something from it — is making a decision, not repeating one the loop made by accident.
-- SU6 is about what the control loop may start by itself; refusing the person as well would be this
-- guard deciding something §13.6 never said, and it would be unappealable from any UI.

-- WHAT THIS SESSION IS FOR, as a column rather than as an inference.
-- -----------------------------------------------------------------
-- The guard below has to tell two USER-origin inserts apart, and until now it could not:
--
--   Run Now (`TasksService.execute`) — "do this task's work again". SU6 refuses it: the work is
--     being done by the successor;
--   an explicit `session_create` against the task — "let me look at what that run did". SU6 must
--     NOT refuse it, and refusing it would be unappealable from any UI.
--
-- Both wrote `dispatch_origin = 'USER'` and `run_source = 'MANUAL'`, so no fence could separate
-- them and Run Now's protection was an in-memory pre-check — which a supersession committing
-- between the check and the insert walks straight past, leaving a live Session and a 500.
--
-- A column and not a new `session_run_source` value, deliberately: adding an enum value breaks the
-- OLD binary still serving reads during a rolling deploy (Prisma refuses to deserialize a value its
-- client does not know), while an added column is simply not selected by it.
--
-- DEFAULT **true**, and that direction is the whole point. The column exists to carve an EXEMPTION
-- out of a refusal, so its default decides what happens to a write that does not mention it — every
-- row an older binary inserts during a rolling deploy, and every row already in the table. Default
-- false would hand all of them the exemption: an old binary's Run Now is `dispatch_origin = 'USER'`
-- with no opinion about this column, and would sail past the guard onto a replaced attempt, which
-- is the exact incident this release exists to prevent. Default true fails the other way — an old
-- binary's explicit `session_create` against a retired task is refused when it could have been
-- allowed — and that is a refusal somebody can read, retry after the deploy, and act on.
--
-- The new binary is explicit on every path: `SessionsService.create` writes false unless a caller
-- asks for work, and the work-starting callers ask.
ALTER TABLE "session" ADD COLUMN "starts_task_work" BOOLEAN NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION "session_superseded_task_guard"() RETURNS trigger AS $$
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
  IF NEW."status" NOT IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
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
     AND OLD."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "session_superseded_task_guard" ON "session";
CREATE TRIGGER "session_superseded_task_guard"
  BEFORE INSERT ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_superseded_task_guard"();

-- INSERT is not the only way a Session becomes live, and the other way had no guard at all.
-- `SessionsService.resume` and the auto-retry sweep both take a TERMINAL row and write a live
-- status back onto it IN PLACE. So a FAILED session carrying a `retry_at`, whose task is retired
-- during that terminal window, was revived by the next sweep — past this guard, past §9.2's
-- authorization, and with the Session's own history rewritten rather than a new row created.
--
-- Same function, because it is the same question asked of the same row: is this task's work still
-- this task's to do. The column list is what decides whether it is called at all, so it names every
-- column that can move a row INTO live or change the answer once it is there: the status, the task
-- it belongs to, `deleted_at` (restore is a transition into live), and the two fields the salvage
-- exemption reads.
DROP TRIGGER IF EXISTS "session_superseded_task_revive_guard" ON "session";
CREATE TRIGGER "session_superseded_task_revive_guard"
  BEFORE UPDATE OF "status", "task_id", "dispatch_origin", "deleted_at", "starts_task_work"
  ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_superseded_task_guard"();

-- ---------------------------------------------------------------------------------------------
-- 2. SU8: an attempt somebody is RUNNING may not be retired.
-- ---------------------------------------------------------------------------------------------
--
-- The other direction of the same race, and it needs no mixed-version binary to reach. A legacy
-- execute commits its Session first and flips the task's status second (`clearFailedForRetry`); a
-- supersession that lands in that window takes the task row while it still reads FAILED, sees
-- nothing to refuse, and commits. What is left is a PENDING Session executing a task the control
-- plane has marked as replaced — and §1's guard cannot help, because the Session was inserted
-- before the link existed.
--
-- The two guards are each other's other half, serialized on the task row: §1 reads it FOR SHARE
-- from the session INSERT, and this one runs inside an UPDATE of that same row. Session commits
-- first ⇒ this guard sees the live Session and refuses the link. Link commits first ⇒ §1's FOR
-- SHARE waits, then sees the retirement and refuses the Session. There is no third outcome and no
-- order in which both succeed.
--
-- Only on RETIRING. Clearing the columns is how a mistaken retirement is undone, and refusing that
-- because a session is running would make the mistake permanent.
--
-- The refusal says "wait for the run to reach a terminal status", and never "interrupt it":
-- INTERRUPTED is one of the four live statuses below, so it would be advice that leaves this guard
-- refusing for the same reason — and stopping a run to make an unrelated write succeed throws away
-- whatever that run was in the middle of.
CREATE OR REPLACE FUNCTION "task_supersession_live_session_guard"() RETURNS trigger AS $$
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
     AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
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

DROP TRIGGER IF EXISTS "task_supersession_live_session_guard" ON "task";
CREATE TRIGGER "task_supersession_live_session_guard"
  BEFORE UPDATE OF "superseded_by_task_id", "terminal_reason" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_supersession_live_session_guard"();

-- ---------------------------------------------------------------------------------------------
-- 2b. SU2/SU3 in the other direction: a successor may not be moved out from under its predecessor.
-- ---------------------------------------------------------------------------------------------
--
-- 0128's guard enforces "same tenant, same project" — on the row that HOLDS the pointer, when that
-- row is written. The successor can be moved instead, and then nothing looks: `task_update B
-- --project-id other` checks B's own parent and subject and commits. What is left is A, in one
-- project, recording its failure as history because B took over — with B outside that project's
-- authority entirely, invisible to its acceptance and to every read SU3 exists to make possible.
--
-- The service refuses this with a sentence naming the predecessors; this is the wall behind it, and
-- it is the half a hand-typed UPDATE or an older binary also hits. No lock is taken here: both
-- writes go through the owner-scoped serialization the service takes for any hierarchy move, and a
-- trigger that took its own would introduce a second lock order against the link path's.
CREATE OR REPLACE FUNCTION "task_supersession_successor_move_guard"() RETURNS trigger AS $$
DECLARE
  predecessor RECORD;
BEGIN
  IF NEW."project_id" IS NOT DISTINCT FROM OLD."project_id"
     AND NEW."owner_id" IS NOT DISTINCT FROM OLD."owner_id" THEN
    RETURN NEW;
  END IF;

  SELECT t."id", t."project_id", t."owner_id" INTO predecessor
    FROM "task" t
   WHERE t."superseded_by_task_id" = NEW."id"
     AND (t."project_id" IS DISTINCT FROM NEW."project_id"
          OR t."owner_id" IS DISTINCT FROM NEW."owner_id")
   ORDER BY t."id"
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'TASK_SUPERSESSION_SUCCESSOR_MOVED: task % replaces task %, so it may not move to project % / owner % — unlink or re-point that attempt first',
      NEW."id", predecessor."id",
      COALESCE(NEW."project_id"::text, 'none'), NEW."owner_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_supersession_successor_move_guard" ON "task";
CREATE TRIGGER "task_supersession_successor_move_guard"
  BEFORE UPDATE OF "project_id", "owner_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_supersession_successor_move_guard"();

-- ---------------------------------------------------------------------------------------------
-- 2c. A check may not be pointed at work that was replaced.
-- ---------------------------------------------------------------------------------------------
--
-- The other half of the repoint race. §1's guard, having locked the verifier, refuses a live
-- session on a check whose subject is retired — that is "repoint first, then try to run". This is
-- "run first, then repoint": the session is already live and legal, and the repoint would make it
-- retroactively a check of replaced work.
--
-- Rather than refuse the repoint only when a run happens to be live, refuse it always: a check
-- pointed at a replaced attempt is obsolete the moment it is filed, because its subject will never
-- be dispatched again and can never become DONE. That makes the rule one sentence instead of a
-- condition, and it removes the race by removing the reachable state.
CREATE OR REPLACE FUNCTION "task_verification_subject_guard"() RETURNS trigger AS $$
DECLARE
  subject RECORD;
  checker UUID;
BEGIN
  IF NEW."verifies_task_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."verifies_task_id" IS NOT DISTINCT FROM NEW."verifies_task_id" THEN
    RETURN NEW;
  END IF;

  IF NEW."verifies_task_id" = NEW."id" THEN
    RAISE EXCEPTION 'TASK_VERIFICATION_SELF: task % cannot verify itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- NOWAIT, because this acquisition is inherently second: the row being UPDATED is already locked
  -- by the statement that reached this trigger, so two concurrent repoints — `A verifies B` and
  -- `B verifies A` — hold A and B respectively and then reach for each other. That is a native
  -- 40P01 with a random victim, from two ordinary UPDATEs, and the depth-one rule below cannot
  -- prevent it because it is the rule being evaluated. Refusing immediately cannot cycle: at most
  -- one of the two proceeds, the other is told so by name, and neither leaves a partial write.
  BEGIN
    SELECT t."id", t."terminal_reason", t."superseded_by_task_id", t."verifies_task_id"
      INTO subject
      FROM "task" t WHERE t."id" = NEW."verifies_task_id" FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'TASK_VERIFICATION_SUBJECT_BUSY: task % is being written right now, so a check cannot be pointed at it in this transaction — nothing was written; retry',
      NEW."verifies_task_id"
      USING ERRCODE = 'lock_not_available';
  END;
  IF FOUND AND (subject."terminal_reason" IS NOT NULL
                OR subject."superseded_by_task_id" IS NOT NULL) THEN
    RAISE EXCEPTION
      'TASK_VERIFICATION_SUBJECT_SUPERSEDED: task % is %, so a check cannot be pointed at it — check the attempt that replaced it instead',
      subject."id", COALESCE(subject."terminal_reason", 'SUPERSEDED')
      USING ERRCODE = 'check_violation';
  END IF;

  -- DEPTH ONE, and it is a lock-ordering invariant as much as a modelling one.
  -- --------------------------------------------------------------------------
  -- §1's session guard locks a verifier and then its subject. Two acquisitions in a fixed order
  -- are only acyclic if the relation itself is: with `A verifies B` and `B verifies A` in the
  -- table, a Session on A takes A→B while a Session on B takes B→A, and the pair deadlocks with a
  -- native 40P01 — no typed refusal, no defined winner, and reachable from two ordinary inserts.
  -- The service refuses a check of a check today, but a service check lives only in the binary
  -- that has it, which is the whole reason these guards exist.
  --
  -- Depth one removes the possibility rather than ordering around it: a subject may not itself be
  -- a check, and a check may not be a subject, so the graph has no path of length two and no cycle
  -- of any length. §13.2 already reads it that way — a verification is a second opinion about
  -- work, and a second opinion about a second opinion is not something any consequence is defined
  -- for.
  IF FOUND AND subject."verifies_task_id" IS NOT NULL THEN
    RAISE EXCEPTION
      'TASK_VERIFICATION_OF_VERIFICATION: task % is itself a check (of %), so it cannot be the subject of one',
      subject."id", subject."verifies_task_id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The other direction of depth one: is anything already checking THIS task? Read without a lock
  -- on purpose — a row arriving here concurrently is itself passing through this same guard, and
  -- whichever of the two commits second finds the first and is refused by it.
  SELECT t."id" INTO checker
    FROM "task" t WHERE t."verifies_task_id" = NEW."id" ORDER BY t."id" LIMIT 1;
  IF checker IS NOT NULL THEN
    RAISE EXCEPTION
      'TASK_VERIFICATION_OF_VERIFICATION: task % is already the subject of check %, so it cannot become a check itself',
      NEW."id", checker
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Existing data first: the guard above only sees future writes, and a chain or cycle already in
-- the table is exactly the shape that deadlocks §1's two-step lock. Fail closed and name them.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(format('task %s verifies %s, which itself verifies %s',
                           a."id", b."id", b."verifies_task_id"), E'\n  '
                    ORDER BY a."id")
    INTO offenders
    FROM "task" a
    JOIN "task" b ON b."id" = a."verifies_task_id"
   WHERE b."verifies_task_id" IS NOT NULL;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION E'TASK_VERIFICATION_OF_VERIFICATION: these checks are pointed at other checks, which this release forbids because a two-step lock over that relation can deadlock:\n  %\n\nThis migration changed nothing and has rolled back. Detach the inner link (task_update --clear-verifies) so each check points at real work, then re-run.',
      offenders;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "task_verification_subject_guard" ON "task";
CREATE TRIGGER "task_verification_subject_guard"
  BEFORE INSERT OR UPDATE OF "verifies_task_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_verification_subject_guard"();

-- ---------------------------------------------------------------------------------------------
-- 3. The execution claim covers every LIVE status, not two of the four.
-- ---------------------------------------------------------------------------------------------
--
-- `session_task_execution_claim_idx` (0122) is what makes "one live Session per task" a property of
-- the database rather than of whichever service happened to check. It was written over
-- `status IN ('PENDING', 'RUNNING')`, and §4.2 guard 5's definition of live has four members:
-- AWAITING_INPUT and INTERRUPTED are ENDED TURNS but LIVE RUNS — resumable conversations somebody
-- paused, which §7.5 refuses to rotate away from for exactly that reason.
--
-- So a task whose run is paused had, at the database level, no claim on itself. The service reads
-- that closed this in the same change (§7.4 precondition 4 and §9.4's two counts now ask for all
-- four), but a service read is not the fence: during a rolling deploy the old binary is still
-- dispatching, and its `ON CONFLICT ... DO NOTHING` inferred an index that did not cover the paused
-- session — so the insert did not conflict, and the task got a second Session while a person was
-- mid-conversation with the first.
--
-- Rebuilt rather than added beside: two overlapping partial unique indexes on one column would both
-- be inferrable by `ON CONFLICT`, and which one PostgreSQL picks is not something a reader of the
-- INSERT can see. One index, one predicate, one meaning.

-- The deterministic part, and the reason this is a RAISE and not a reconcile.
-- --------------------------------------------------------------------------
-- 0122 handled its own pre-existing duplicates by CANCELLING the losers. That is defensible for
-- PENDING/RUNNING — nothing has been said to them — and it is NOT defensible for the two statuses
-- being added: AWAITING_INPUT is a conversation waiting on a person, and a migration that silently
-- cancels it destroys the thing they paused. §7.5 says so about rotation in as many words, and a
-- migration is not a better place to do it than the loop is.
--
-- So this fails closed, names every row with its status and its runner, and rewrites nothing. It is
-- deterministic in the sense that matters: the same database always gets the same answer, no
-- Session is modified either way, the whole migration rolls back as one, and an operator who sees
-- this decides what happens to their own runs rather than reading afterwards about what a migration
-- decided. The remedy it prints is "restore the workers and let each run finish", never "end or
-- delete them" — a terminal status written to make a deploy proceed is the run's own record
-- overwritten, which is not a repair.
--
-- It runs UNDER the locks above, so the set it proves empty cannot gain a member before the index
-- that would refuse one exists.
--
-- On a database without duplicates — the expected case, since a second live Session on one task is
-- the defect this index exists to prevent and 0122 already reconciled the two older statuses — this
-- block does nothing at all.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  -- Reported per conflicting ROW, with the runner and status of each, because the remedy is
  -- addressed to whoever owns those workers — not to whoever is running the deploy.
  SELECT string_agg(detail, E'\n  ' ORDER BY detail) INTO offenders FROM (
    SELECT format('task %s: %s', d."task_id",
             string_agg(format('session %s [%s, runner %s, updated %s]',
                               s."id", s."status", COALESCE(s."assigned_runner_id"::text, 'none'),
                               s."updated_at"),
                        ', ' ORDER BY s."id")) AS detail
      FROM (
        SELECT s2."task_id"
          FROM "session" s2
         WHERE s2."task_id" IS NOT NULL AND s2."deleted_at" IS NULL
           AND s2."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
         GROUP BY s2."task_id"
        HAVING count(*) > 1
      ) d
      JOIN "session" s ON s."task_id" = d."task_id" AND s."deleted_at" IS NULL
       AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
     GROUP BY d."task_id"
  ) rows;
  IF offenders IS NOT NULL THEN
    -- The remedy deliberately does NOT say "end or delete them". Writing a terminal status onto a
    -- run that has not reached one overwrites the only record of what that run actually did, and
    -- deleting it destroys the audit outright — for a deploy's convenience. Every one of these rows
    -- is a real worker somewhere, and the only honest first move is to let it finish.
    RAISE EXCEPTION E'SESSION_TASK_CLAIM_AMBIGUOUS: these tasks hold more than one live session, so the execution claim cannot be widened without choosing between them:\n  %\n\nThis migration changes no Session and has rolled back completely; the previous claim index is intact.\n\nWhat to do, in order: (1) bring the runners named above back up and let each session reach a terminal status OF ITS OWN — SUCCEEDED, FAILED or CANCELLED — then re-run this migration; nothing else is needed if the sessions are simply live. (2) Only if a task is genuinely holding duplicates from a past dispatch incident, have a person decide WHICH row is the real execution, resolve the others explicitly as their own audited repair, and record why. Do not write terminal statuses or delete rows to make this migration pass: that overwrites what those runs did, and one of them may be a conversation somebody is waiting on.',
      offenders;
  END IF;
END;
$$;

DROP INDEX "session_task_execution_claim_idx";

-- WHY THIS PREDICATE STOPS AT THE STATUSES.
-- ----------------------------------------
-- `starts_task_work` separates a run doing the task from a session opened to look at it, and every
-- other reader in this migration uses it: the capacity counts, the retirement guard, the reaper,
-- Run Now. Narrowing THIS index the same way would also be right on the merits — an @-mention
-- naming two agents can only wake the first while a conversation session takes the claim — and it
-- is deliberately NOT done here, because it cannot be done in this migration safely.
--
-- `ON CONFLICT (...) WHERE <predicate>` infers a partial index by PROVING the stated predicate
-- implies the index's. The 0.1.130 dispatcher still running during a rolling deploy states
-- `status IN ('PENDING','RUNNING')`, which does not imply `starts_task_work` — the column's DEFAULT
-- is data, and inference is a static proof. So the moment this migration applied, every old
-- replica's dispatch would raise 42P10, roll back its action transaction and stop making progress.
-- That is a worse outage than the thing it fixes, and it lands on the deploy rather than on a rare
-- race.
--
-- The narrowing belongs in a LATER migration, shipped once no binary predicating on two statuses
-- can still be running — the same two-phase shape §12.1 uses for every other predicate change. What
-- this release does is make the SEMANTICS correct everywhere they are read; the index stays at the
-- widest safe form until the fleet has caught up.
CREATE UNIQUE INDEX "session_task_execution_claim_idx" ON "session"("task_id")
 WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
   AND "status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');

-- ---------------------------------------------------------------------------------------------
-- 4. Index for the retirement predicate.
-- ---------------------------------------------------------------------------------------------

-- The boot recovery scan's new predicate, and the service reads that share it, are
-- `terminal_reason IS NULL AND superseded_by_task_id IS NULL` over a project's tasks. 0128 indexed
-- the pointer; the reason column had no index, and it is the selective one (almost every row is
-- NULL, and the scan wants exactly those). Partial, so it costs nothing on the overwhelming
-- majority of rows it does not describe.
CREATE INDEX "task_terminal_reason_idx" ON "task" ("terminal_reason")
  WHERE "terminal_reason" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 3b. §9.4's admission counts and the row lock that serializes them agree about "live".
-- ---------------------------------------------------------------------------------------------
--
-- `session_project_capacity_serialize` (0122) exists so that a change ENTERING or LEAVING the
-- counted set takes the project row — the same row §9.2's adapter locks while it counts. Its
-- definition of the counted set was `('PENDING', 'RUNNING')`, and this release widens every count
-- that reads it to the four §4.2 guard 5 calls live. A trigger measuring a narrower set than the
-- counts it protects is worse than none: it silently early-returns for exactly the transitions
-- nobody thought about.
--
-- The reachable one is `restore()`, which writes nothing but `deleted_at = NULL`. On a soft-deleted
-- AWAITING_INPUT row both `old_live` and `new_live` were false, so the trigger returned without
-- touching the project — while the row it restored is now counted by every gate above. Concurrently
-- with a Coordinator admission holding the project lock and counting free slots, the two commit and
-- the project runs over `max_concurrent_tasks`.
--
-- Function replaced, triggers left alone: their column lists (`status`, `task_id`, `deleted_at`)
-- were already right, and the lock order — project row taken from a session write — is unchanged,
-- so nothing about §8.6's ordering moves.
CREATE OR REPLACE FUNCTION "session_project_capacity_serialize"() RETURNS trigger AS $$
DECLARE old_live boolean; new_live boolean;
BEGIN
  old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
    AND OLD."deleted_at" IS NULL
    AND OLD."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');
  new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL
    AND NEW."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');
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
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 3b-2. One lock order for the whole system: PROJECT, then TASK, then SESSION.
-- ---------------------------------------------------------------------------------------------
--
-- Every Coordinator path takes the project first — §8.1's lease, §9.2's adapter, §13.2's verdict
-- apply (project row, then verifier and subject `FOR UPDATE`) — and then the tasks it is about.
-- A Session write took them the other way round, and not by anyone's decision: PostgreSQL fires
-- `BEFORE` triggers in NAME order, so `session_dispatch_authority_guard` (which takes the task
-- `FOR SHARE`) has always run before `session_project_capacity_serialize` (which writes the project
-- row). Task, then project. Interleaved with any Coordinator pass that already holds the project,
-- that is a cycle, and PostgreSQL resolves it by killing one of them with a native 40P01 — no typed
-- refusal, no defined winner, and a 500 for whoever loses.
--
-- Nothing about the existing guards is changed. A trigger whose name sorts before all of them takes
-- the project row FIRST, so by the time the authority guard reaches for the task this transaction
-- already holds everything the capacity trigger would have taken afterwards.
--
-- That gives project → task → session for an INSERT. It does NOT for an UPDATE or a DELETE, and the
-- difference is not a matter of trigger names: PostgreSQL locks the target row before it fires a
-- `BEFORE ROW` trigger, so those statements are already session → … whatever this does next. There
-- is no ordering fix available for them, so they get the other mechanism — every acquisition here
-- is NOWAIT, and a transaction that cannot have a row it needs is told so by name instead of
-- waiting. Waiting is what builds a cycle; a typed refusal with nothing written cannot.
--
-- It acts on EXACTLY the set `session_project_capacity_serialize` acts on — same predicate, same
-- early return — so it adds no contention anywhere that transaction was not already going to lock
-- the project one statement later. `FOR NO KEY UPDATE` rather than the capacity trigger's UPDATE:
-- this is an ordering acquisition, not a write, and the write it precedes is free once held.
CREATE OR REPLACE FUNCTION "session_admission_lock_order"() RETURNS trigger AS $$
DECLARE old_live boolean; new_live boolean; ordered UUID;
        scope_before UUID[]; scope_after UUID[];
BEGIN
  old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
    AND OLD."deleted_at" IS NULL
    AND OLD."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');
  new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL
    AND NEW."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');
  IF TG_OP = 'UPDATE' AND old_live = new_live
     AND OLD."task_id" IS NOT DISTINCT FROM NEW."task_id" THEN
    RETURN NEW;
  END IF;
  -- Which projects to take is read from the TASK rows, and that read is itself a guess until those
  -- rows are held: a task can be moved between this trigger's read and the capacity trigger's
  -- write, and then this transaction holds P1 while the write reaches for P2 — the same inversion,
  -- one step later.
  --
  -- So: read the scope, lock those projects, lock the task rows, then CONFIRM the scope did not
  -- move. Every acquisition after the first is NOWAIT, because each is taken with something already
  -- held and waiting is what builds a cycle. A confirmation that fails is a typed refusal with
  -- nothing written — never a wait, and never a retry loop inside a trigger.
  SELECT array_agg(DISTINCT t."project_id" ORDER BY t."project_id") INTO scope_before
    FROM "task" t
   WHERE t."id" IN (
     CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END
   ) AND t."project_id" IS NOT NULL;

  IF scope_before IS NOT NULL THEN
    FOREACH ordered IN ARRAY scope_before LOOP
      BEGIN
        PERFORM 1 FROM "project" p WHERE p."id" = ordered FOR NO KEY UPDATE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION
          'SESSION_PROJECT_BUSY: project % is being reconciled right now, so this session cannot be admitted in this transaction — nothing was written; retry',
          ordered
          USING ERRCODE = 'lock_not_available';
      END;
    END LOOP;
  END IF;

  BEGIN
    PERFORM 1 FROM "task" t
     WHERE t."id" IN (
       CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END,
       CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END
     )
     ORDER BY t."id"
     FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'SESSION_TASK_BUSY: this session''s task is being written right now, so the session cannot be admitted in this transaction — nothing was written; retry'
      USING ERRCODE = 'lock_not_available';
  END;

  SELECT array_agg(DISTINCT t."project_id" ORDER BY t."project_id") INTO scope_after
    FROM "task" t
   WHERE t."id" IN (
     CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END
   ) AND t."project_id" IS NOT NULL;

  IF scope_after IS DISTINCT FROM scope_before THEN
    RAISE EXCEPTION
      'SESSION_TASK_MOVED: this session''s task changed project while it was being admitted — nothing was written; retry'
      USING ERRCODE = 'lock_not_available';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The names are the mechanism: `session_admission_lock_order` sorts before
-- `session_dispatch_authority_guard`, `session_project_capacity_serialize_*` and
-- `session_superseded_task_guard`, so it runs first on every one of those statements.
DROP TRIGGER IF EXISTS "session_admission_lock_order_insert_delete" ON "session";
CREATE TRIGGER "session_admission_lock_order_insert_delete"
  BEFORE INSERT OR DELETE ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_admission_lock_order"();
DROP TRIGGER IF EXISTS "session_admission_lock_order_update" ON "session";
CREATE TRIGGER "session_admission_lock_order_update"
  BEFORE UPDATE OF "status", "task_id", "deleted_at" ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_admission_lock_order"();

-- ---------------------------------------------------------------------------------------------
-- 3c. The last DB object still measuring "live" with two statuses.
-- ---------------------------------------------------------------------------------------------
--
-- `task_claimed_project_move_guard` (0122) stops a task being re-filed while a run holds it: the
-- action that dispatched it, the authorization that admitted it and the counts on BOTH projects are
-- all scoped to the project it was in. It asked `('PENDING', 'RUNNING')`, so a task whose run is
-- paused at `AWAITING_INPUT` — a conversation somebody is in the middle of — could be moved, which
-- cuts that run loose from its own provenance and moves a counted slot across a boundary neither
-- project's admission saw.
--
-- Audited as a set, not found one at a time: after this migration the only remaining function in
-- the database mentioning PENDING and RUNNING without the other two is
-- `guard_opencode_runner_claim`, which is about the PENDING → RUNNING claim transition itself and
-- is not a liveness predicate at all.
CREATE OR REPLACE FUNCTION "task_claimed_project_move_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
      AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
  ) THEN
    RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 4b. A retired row may only hold a terminal status (§13.6 SU4, the half nothing enforced).
-- ---------------------------------------------------------------------------------------------
--
-- 0128's guard says "only a CANCELLED or FAILED task may name a successor" and enforces it — but it
-- returns early when `superseded_by_task_id IS NULL`, so it only ever sees the LINKED shape. The
-- other two retirements have no pointer:
--
--   `terminal_reason = 'ABANDONED'`  — never had one;
--   `terminal_reason = 'SUPERSEDED'` with the pointer cleared by `ON DELETE SET NULL`.
--
-- On either of those, a plain status-only write to OPEN was accepted by the database and by the
-- service (which validates supersession only when the request MENTIONS those fields). Before this
-- release that produced an odd-looking row and nothing else. After it, it produces a wedge: every
-- gate added here reads the row as retired and refuses to dispatch it, while its status says OPEN
-- and every list, every person and the task's own page say it is waiting to run. Nothing would ever
-- move it again, and nothing would say why.
--
-- A CHECK rather than more trigger, because this is a property of the ROW and not of a transition:
-- it holds however the row got here, including a hand-typed UPDATE, and PostgreSQL evaluates it at
-- the end of the statement — so ONE statement that clears the retirement and reopens the task is
-- legal, which is exactly the repair a person needs to be able to make.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(format('task %s is %s with terminal_reason=%s, successor=%s',
                           t."id", t."status", COALESCE(t."terminal_reason", 'null'),
                           COALESCE(t."superseded_by_task_id"::text, 'null')), E'\n  '
                    ORDER BY t."id")
    INTO offenders
    FROM "task" t
   WHERE (t."terminal_reason" IS NOT NULL OR t."superseded_by_task_id" IS NOT NULL)
     AND t."status" NOT IN ('CANCELLED', 'FAILED');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION E'TASK_RETIREMENT_STATUS_INCONSISTENT: these tasks are recorded as replaced or abandoned while holding a non-terminal status, which this release turns into a task that can never be dispatched and never explains why:\n  %\n\nThis migration changes no row and has rolled back completely. Fix each one with a single write that says which fact is true — either restore the terminal status it actually ended with (task_update --status FAILED / CANCELLED), or clear the retirement if it was recorded in error (task_update --clear-superseded --clear-terminal-reason, which may be combined with a status in the same call).',
      offenders;
  END IF;
END;
$$;

-- ...and the same question asked of the OTHER pair of columns, because the guards installed above
-- only see writes that happen AFTER them.
--
-- 0128 could already retire a task, and nothing then stopped one from being retired while a run was
-- executing it — SU8's trigger is new in this migration. So a database can arrive here already
-- holding "a live Session on a replaced attempt", which is precisely the state everything in this
-- release exists to prevent, and no trigger can reach backwards to fix it. Migrating over it
-- silently would install the guards, report success, and leave the incident running.
--
-- Fail closed, enumerate stably, and change nothing. In particular: no automatic complete, cancel
-- or delete. Every row here is a real worker somewhere, and a terminal status written to make a
-- migration pass is that run's own record overwritten.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  -- TWO shapes, and the second is reachable without anybody doing anything odd: 0128 let a check be
  -- filed and started against a live subject, and let that subject be retired afterwards. The
  -- result is a run verifying replaced work — which the runtime rules installed above refuse in
  -- both directions, and which a preflight that only asked `session.task_id = retired.id` would
  -- migrate straight past, leaving the inconsistency the release exists to remove.
  --
  -- One UNION with a stable order, so the same database always prints the same list.
  SELECT string_agg(detail, E'\n  ' ORDER BY detail) INTO offenders FROM (
    SELECT format('task %s (%s, %s) has live session %s [%s, runner %s]',
                  t."id", t."status", COALESCE(t."terminal_reason", 'SUPERSEDED'),
                  s."id", s."status", COALESCE(s."assigned_runner_id"::text, 'none')) AS detail
      FROM "task" t
      JOIN "session" s ON s."task_id" = t."id" AND s."deleted_at" IS NULL
     WHERE (t."terminal_reason" IS NOT NULL OR t."superseded_by_task_id" IS NOT NULL)
       AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
    UNION ALL
    SELECT format('task %s verifies task %s (%s, %s) and has live session %s [%s, runner %s]',
                  v."id", subject."id", subject."status",
                  COALESCE(subject."terminal_reason", 'SUPERSEDED'),
                  s."id", s."status", COALESCE(s."assigned_runner_id"::text, 'none')) AS detail
      FROM "task" v
      JOIN "task" subject ON subject."id" = v."verifies_task_id"
      JOIN "session" s ON s."task_id" = v."id" AND s."deleted_at" IS NULL
     WHERE (subject."terminal_reason" IS NOT NULL OR subject."superseded_by_task_id" IS NOT NULL)
       AND (v."terminal_reason" IS NULL AND v."superseded_by_task_id" IS NULL)
       AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
  ) rows;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION E'TASK_RETIRED_WITH_LIVE_SESSION: these runs are executing work that has been replaced or abandoned — either the task itself, or the task their check is pointed at:\n  %\n\nThis migration changes no Session and no Task, and has rolled back completely. The guards it installs only see future writes, so this state has to be resolved before they can mean anything.\n\nWhat to do: wait for each run above to reach a terminal status OF ITS OWN (SUCCEEDED, FAILED or CANCELLED) — restore its runner if that is what it is waiting for — and re-run. If instead the retirement was recorded in error, revoke it explicitly first (task_update --clear-superseded --clear-terminal-reason). Do not end, cancel or delete those runs to make this migration pass.',
      offenders;
  END IF;
END;
$$;

ALTER TABLE "task"
  ADD CONSTRAINT "task_retirement_status_check"
  CHECK ("terminal_reason" IS NULL AND "superseded_by_task_id" IS NULL
         OR "status" IN ('CANCELLED', 'FAILED'));

-- ---------------------------------------------------------------------------------------------
-- 4c. The one acquisition that cannot be reordered, made deterministic instead.
-- ---------------------------------------------------------------------------------------------
--
-- §3b-2 fixed the session side by putting the project acquisition in a trigger that fires before
-- the one taking the task. That trick is not available here, and the reason is structural: the row
-- being UPDATED is the TASK, and PostgreSQL locks it before any `BEFORE ROW` trigger runs. By the
-- time anything of ours executes, the task row is already held.
--
-- So the write is inherently task → project, and §5 below adds the project half by putting the
-- supersession columns on `project_acceptance_task_fact_update`, which reaches
-- `project_acceptance_reopen`. The new service prelocks the project first and is therefore never in
-- that order. An OLD binary — or a hand-typed UPDATE — is, and against a Coordinator pass holding
-- the project and waiting for the task it is a genuine cycle: PostgreSQL kills one at random, and
-- during a rolling deploy that is an intermittent 500 nobody can attribute.
--
-- NOWAIT converts it. Waiting is what makes a cycle; refusing immediately cannot. Either this
-- transaction takes the project — which the new service already holds, so its own writes never see
-- this — or it is told so, by name, with nothing written. A multi-row UPDATE spanning several
-- projects needs no sorted order for the same reason: nothing here ever waits, so no acquisition
-- order can close a loop.
CREATE OR REPLACE FUNCTION "task_supersession_project_lock_order"() RETURNS trigger AS $$
DECLARE
  target UUID;
BEGIN
  -- A pure project MOVE reaches the same AFTER trigger and takes the same two project rows (§5's
  -- fact function reopens both), so it needs the same pre-acquisition. Returning early on "no
  -- supersession column changed" left exactly that case taking the task row first and the projects
  -- second — the inversion this guard exists to remove, reached by the one path that does not
  -- mention supersession at all.
  IF OLD."terminal_reason" IS NOT DISTINCT FROM NEW."terminal_reason"
     AND OLD."superseded_by_task_id" IS NOT DISTINCT FROM NEW."superseded_by_task_id"
     AND OLD."project_id" IS NOT DISTINCT FROM NEW."project_id" THEN
    RETURN NEW;
  END IF;

  -- BOTH projects, not just the new one. One raw UPDATE can move a task and retire it at once, and
  -- §5's fact trigger then reaches `project_acceptance_reopen` for the OLD project as well as the
  -- NEW one — so the old project is a lock this transaction is going to need, and a guard that only
  -- pre-took the new one leaves exactly the wait it exists to remove. `NEW.project_id IS NULL` was
  -- the worst version of that: it returned early, and the move-out branch then took the old project
  -- from an AFTER trigger with the task row already held.
  --
  -- Distinct, non-null, in UUID order (§8.6 LO2), so two transactions touching the same pair cannot
  -- take them in opposite orders — and NOWAIT on each, so neither ever waits and no order can close
  -- a loop even against a writer following no rule at all.
  FOR target IN
    SELECT DISTINCT candidate.id FROM (
      VALUES (OLD."project_id"), (NEW."project_id")
    ) AS candidate(id)
     WHERE candidate.id IS NOT NULL
     ORDER BY candidate.id
  LOOP
    BEGIN
      PERFORM 1 FROM "project" p WHERE p."id" = target FOR NO KEY UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION
        'TASK_SUPERSESSION_PROJECT_BUSY: project % is being reconciled right now, so the supersession of task % cannot be recorded in this transaction — nothing was written; retry',
        target, NEW."id"
        USING ERRCODE = 'lock_not_available';
    END;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_supersession_project_lock_order" ON "task";
CREATE TRIGGER "task_supersession_project_lock_order"
  BEFORE UPDATE OF "superseded_by_task_id", "terminal_reason", "project_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_supersession_project_lock_order"();

-- ---------------------------------------------------------------------------------------------
-- 5. §13.4's two acceptance hard gates learn the same facts the service just learned.
-- ---------------------------------------------------------------------------------------------
--
-- 0127 put the DONE gate and the acceptance-freshness triggers in the database on purpose: a
-- service check exists only in the binary that has it. That is exactly why both of them have to
-- move in THIS transaction rather than in a later one — the service side of §13.6 SU6 ships in the
-- same release, and a wall that disagrees with the door it stands behind is worse than either.

-- 5a-0. The evidence records WHICH READING of the world it is evidence about.
--
-- `ACCEPTANCE_DIGEST_VERSION` moved to 2 in this release because §13.6 SU6's two columns joined
-- AE1's `taskSet`. The service refuses a DONE whose recorded digest does not match a re-computation
-- — but it computes both at ITS OWN version, so an apiserver still running the previous binary
-- during a rolling deploy computes v1 on both sides, agrees with itself, and marks a project DONE
-- on evidence that never looked at whether its tasks had been replaced. The DONE gate could not
-- catch that either: it checks PASS, freshness and open blockers, and all three are true.
--
-- So the version is written down, and the gate requires the current one. NOT NULL DEFAULT 1, which
-- makes every existing row and every write by an older binary read as v1 — fail-closed, and the
-- refusal names itself.
ALTER TABLE "project_acceptance_run"
  ADD COLUMN "digest_version" INTEGER NOT NULL DEFAULT 1;

-- 5a. The DONE gate counts unresolved verification failures. The service gate now excludes the ones
-- §13.6 SU6 made unresolvable — a finding whose verifier or whose subject was REPLACED can never
-- receive the later PASS that is the only thing which resolves it. Left as it was, the two would
-- split: `assertDoneAllowed` would let the write through and this trigger would refuse it, giving a
-- project whose DONE is impossible for a reason the API reports as satisfied.
--
-- Everything else in the gate is unchanged, and the two counts are still "the same reads the
-- service gate makes" — which is the sentence 0127 wrote and this keeps true.
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
  -- The reading the evidence was taken under. A run recorded at an older version was digested over
  -- a world that did not include §13.6 SU6's columns, so "the facts have not moved" is a claim it
  -- was never in a position to make. Refused here rather than left to the service, because the
  -- service that wrote it is the one that would have to notice.
  IF run."digest_version" <> 2 THEN
    RAISE EXCEPTION
      'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was digested at version % and this deployment reads version 2 — re-run acceptance',
      run."id", run."digest_version" USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_blocker FROM "project_blocker" b
   WHERE b."project_id" = NEW."id" AND b."resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The one changed read (§13.6 SU6). The joins are inner on purpose: both tasks are NOT NULL FKs,
  -- so a row that cannot reach them does not exist.
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

-- 5b. Acceptance freshness. `ACCEPTANCE_DIGEST_VERSION` moved to 2 in this same release because
-- `terminal_reason` and `superseded_by_task_id` are now part of AE1's `taskSet` — they change which
-- tasks count as unfinished. AE9-d's promise is that a fact entering the digest reopens a DONE
-- project ATOMICALLY with the write that changed it, and 0127's trigger listened on five columns,
-- none of them these. So a project could be accepted, a supersession linked or unlinked or
-- re-pointed afterwards, and the DONE would stand on a digest that no longer describes the world.
--
-- `superseded_at` is deliberately NOT listened for, and that is the same decision the digest makes:
-- it is audit, not semantics. Nothing reads it to decide anything, so a write that only moves it
-- must not reopen a finished project.
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
    --
    -- Reproduced from 0127 CHARACTER FOR CHARACTER. This migration replaces the function only to
    -- add two arms to the CASE below, and the ordering here is the whole of AE10's deadlock
    -- freedom: rewriting it as a fixed OLD-then-NEW pair — which reads more simply and is wrong —
    -- lets two concurrent moves in opposite directions each hold the project row the other needs.
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
    -- §13.6 SU6's two columns, the only addition this migration makes to this function. Named
    -- separately because "it was replaced" and "the attempt that replaced it changed" are two
    -- different movements of the world, and an audit line collapsing them would not say which one
    -- reopened the project. `superseded_at` is deliberately absent — audit, not semantics, the same
    -- decision `ACCEPTANCE_DIGEST_VERSION` makes — so a write that only moves it reopens nothing.
    WHEN OLD."terminal_reason" IS DISTINCT FROM NEW."terminal_reason" THEN 'task.terminal_reason'
    WHEN OLD."superseded_by_task_id" IS DISTINCT FROM NEW."superseded_by_task_id"
      THEN 'task.superseded_by_task_id'
    ELSE NULL
  END;
  IF fact IS NOT NULL THEN
    PERFORM project_acceptance_reopen(NEW."project_id", fact,
      jsonb_build_object('taskId', NEW."id"));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger's own column list is what decides whether the function is ever CALLED, so replacing
-- the function alone would have changed nothing. Dropped and recreated rather than added beside:
-- two triggers on overlapping column sets would each reopen the project for the same write.
DROP TRIGGER "project_acceptance_task_fact_update" ON "task";
CREATE TRIGGER "project_acceptance_task_fact_update"
  AFTER UPDATE OF "status", "completion_policy", "project_id", "verdict", "verifies_task_id",
                  "terminal_reason", "superseded_by_task_id"
  ON "task"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_task_fact();

COMMIT;
