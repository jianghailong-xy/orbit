-- The database's own half of §13.1 AG6: a task that only aggregation may complete is never a task
-- a Session may be started on.
--
-- Migration 0123 gave `completion_policy` its three values and made a parent's status a
-- RECOMPUTATION over its direct children. What it did not do is give that role any consequence for
-- dispatch. Every dispatch gate downstream asked `status`, `dispatch_hold`, dependencies and
-- authority — and an aggregate parent passes all of them: it is OPEN, unheld, has no prerequisites
-- of its own, and carries an assignee inherited from the tree.
--
-- What that cost, on this deployment: three pure roll-up parents (G, H, K) were selected by the
-- §7.8 pass, admitted by §9.2 and given real work Sessions. Each agent was handed a task whose
-- entire content is the summary of work its children were doing concurrently. They duplicated the
-- children's work, competed for the same branches, and could not report done — because the only
-- thing that may set those rows DONE is the recomputation, which watches the children and not the
-- Session. Nothing in the loop could end them.
--
-- The service-side gates are in this same change: §7.8's pass skips the shape, §9.2's commit-point
-- adapter refuses it, and `TasksService.execute` / `batchExecute` refuse every manual and legacy
-- door. This file is the half that survives the binary, for §2.4's literal reason — during a
-- rolling deploy the process WITHOUT those gates is still running, still holding a lease, and still
-- able to insert the Session this whole change exists to prevent. A hand-typed INSERT is the same
-- case with a person behind it.
--
--
-- WHY A SERVICE-SIDE RE-READ IS NOT ENOUGH, AND WHAT MAKES THIS LINEARIZABLE
-- =========================================================================
-- The obvious fix — re-read the children at the commit point, under the `FOR SHARE` the
-- authorization adapter already holds on the task row — does not close the race, and it is worth
-- writing down exactly why, because the shape recurs:
--
--   A row lock on a PARENT is not a predicate lock over its CHILDREN. Inserting a child names the
--   parent in an FK, which takes `FOR KEY SHARE` on the parent row — and `FOR KEY SHARE` conflicts
--   with `FOR UPDATE` and with nothing weaker. Under `FOR SHARE` the two proceed concurrently, so
--   a child can be inserted after the gate read "no children" and before the Session is written.
--
-- Two things together make it linearizable, and each closes a case the other cannot:
--
--   1. `session_aggregate_parent_guard` (below) takes `FOR UPDATE` on the task inside the SAME
--      transaction and statement sequence that inserts the Session. `FOR UPDATE` is the one mode a
--      child insert's FK `FOR KEY SHARE` conflicts with, and it is also what a write of
--      `completion_policy` or `is_foreman` on that row must wait for. So from the instant the guard
--      runs until the inserting transaction commits, the three facts this rule reads cannot change.
--      A child insert that arrives in that window BLOCKS until the Session commits — and is then
--      REFUSED by §3's guard, which is the other half of the same invariant. It has to be refused
--      rather than allowed through: the moment that child lands, the parent's policy activates and
--      the running Worker and `recompute` are both deciding that row's status. "The run was legal
--      when it started" does not survive the write that changes what the row means.
--
--   2. `task_aggregate_parent_shape_guard` (below) also makes a child write TOUCH its parent's row.
--      This is for the REPEATABLE READ reader, and it is the case (1) cannot see: the Project
--      control loop dispatches inside an RR transaction, so every SELECT it makes — including the
--      guard's own check — answers from the snapshot taken at that transaction's first statement.
--      A child committed AFTER that snapshot but BEFORE the guard takes its lock is invisible to
--      the guard, and takes no lock the guard would wait on. Touching the parent turns that
--      invisible commit into a row-version change on exactly the row the guard locks, so
--      `SELECT ... FOR UPDATE` raises `40001` instead of reading a stale answer. §8.6's bounded
--      retry then re-runs the whole dispatch against a fresh snapshot, which sees the child and
--      refuses it in the service, with a refusal code, before the database has to.
--
--      This is the technique migration 0122 already used for the same class of problem — its
--      `task_dependency_dispatch_touch` exists because an empty prerequisite SET cannot be locked
--      either. Same shape, same reason, second graph.
--
-- The two together leave no interleaving in which a Session is committed for a task that was an
-- aggregate parent at the moment it was committed:
--
--   * child commits before the reader's snapshot   -> the service gates see it and refuse;
--   * child commits between snapshot and lock      -> (2) forces 40001, retry, then refuse;
--   * child commits after the lock                 -> (1) blocks it until the Session commits, and
--                                                     §3 then refuses it: a live run may not have
--                                                     its completion handed to subtasks underneath
--                                                     it. Release directions stay open.
--
-- The invariant both halves enforce is one sentence: NO task is an aggregate parent AND holds a
-- live `starts_task_work` Session at the same time. Two writers, one row lock, either order.
--
--
-- LOCK ORDER
-- ==========
-- `task` before `session`, which is the order every writer of this pair already uses and the order
-- 0130 wrote down. Both new objects respect it:
--
--   * the session guard is a BEFORE INSERT trigger, so no `session` row exists yet when it takes
--     the `task` row. It is named to sort BEFORE `session_superseded_task_guard`, so on any one
--     insert the stronger `FOR UPDATE` is taken first and 0130's `FOR SHARE` on the same row is a
--     no-op that cannot become a lock upgrade.
--   * the touch trigger fires BEFORE INSERT, so the child row is not yet locked when the parent is
--     taken: the order is parent-then-child, matching the dispatcher's task-then-dependents. On the
--     re-parent branch (`UPDATE OF parent_task_id`) the child tuple IS already locked, so that one
--     branch can deadlock against a dispatcher holding the parent and waiting on the child — which
--     PostgreSQL reports as `40P01` and §8.6's bounded retry re-runs. Re-parenting a task that is
--     its own parent's prerequisite is the only shape that reaches it.
--   * when a re-parent touches TWO parents (old and new), they are taken in ascending id order, so
--     two transactions moving tasks between the same pair cannot each hold what the other wants.
--
-- The touch makes a subtask write bump its parent's `updated_at`, which migration 0117's
-- `project_task_event_source` turns into one `task.updated` signal for the parent. That is not an
-- accident of the mechanism, it is correct: the parent's aggregation state genuinely did change,
-- and the loop should look at it.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 0. Take both tables before reading anything.
-- ---------------------------------------------------------------------------------------------
-- Prisma's PostgreSQL migration executor commits each top-level statement unless the migration
-- supplies its own transaction, so this file has its own `BEGIN` (0113 and 0130 say the same thing
-- for the same reason). That alone is not enough: the preflights below prove a state absent, and
-- the DDL that makes it impossible comes AFTER them. Everything in between is a window.
--
-- It is not a theoretical one. `ADD CONSTRAINT` takes ACCESS EXCLUSIVE on `task`, which does stop
-- an insert, a status write or a re-parent — but the illegal state can also be reached WITHOUT
-- touching `task` at all: a single `UPDATE session SET starts_task_work = true` on an existing
-- PENDING row. 0130's UPDATE trigger is declared `UPDATE OF status, task_id, deleted_at`, so it
-- does not fire for that column, and nothing else in the old build reads `task`. Such a write can
-- therefore commit after the preflight has passed and before the replacement trigger's DDL takes
-- its lock, and the migration would report success over exactly the state it just certified absent.
--
-- So both tables are taken explicitly, up front, in 0130's order — `task`, then `session`. That is
-- the order every writer of this pair already uses, and taking `session` first would invert it
-- against the supersession-link path and deadlock. From here the preflights read a world nobody
-- can change until this transaction ends.
LOCK TABLE "task" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------------------------
-- 1. An effective Foreman is MANUAL.
-- ---------------------------------------------------------------------------------------------
-- `is_foreman` says "this task's SESSION is the work"; a non-MANUAL `completion_policy` says "the
-- children decide when this task is finished". A row asserting both has TWO completion owners — a
-- worker that runs it and writes DONE, and `planTaskAggregation`, which does not exempt Foremen and
-- will write DONE or drag it back OPEN from the children. They race, and AG3's reopen makes the
-- loser permanent.
--
-- Fail closed on data that already asserts both, and do NOT rewrite it. Which of the two owners a
-- person meant is not derivable from the row: clearing the policy silently changes when the task
-- completes, and clearing the flag silently changes what it is. Both are decisions somebody makes.
DO $$
DECLARE conflicting text;
BEGIN
  SELECT string_agg(format('  %s  (%s)', t."id", t."completion_policy"), E'\n' ORDER BY t."id")
    INTO conflicting
    FROM "task" t
   WHERE t."is_foreman" = true AND t."completion_policy" <> 'MANUAL';
  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION E'TASK_FOREMAN_AGGREGATION_CONFLICT: these tasks are marked as an explicit Foreman AND carry an aggregating completion policy, which this release refuses because it gives one task two completion owners:\n%\n\nThis migration changed nothing and has rolled back. For each row, decide which one it is and write that decision explicitly:\n  * it coordinates a list and its own run finishes it -> set completion_policy = MANUAL;\n  * it is a roll-up over its subtasks             -> set is_foreman = false.\nThen re-run. Nothing here is rewritten automatically: either edit silently changes when the task completes or what it is.', conflicting;
  END IF;
END $$;

ALTER TABLE "task"
  ADD CONSTRAINT "task_foreman_manual_policy"
  CHECK ("is_foreman" = false OR "completion_policy" = 'MANUAL');

-- ---------------------------------------------------------------------------------------------
-- 2. A preflight for the state this invariant says cannot exist.
-- ---------------------------------------------------------------------------------------------
-- Fail closed, list them, write nothing. A parent that is ALREADY an aggregate parent AND already
-- holds a live work Session is the incident this migration exists to prevent, and the guards below
-- would not remove it: they stop the transition, and this state is past both transitions.
--
-- It is not repaired automatically, and not because that is hard. Ending somebody's live run is a
-- decision with a person's work in it — the Session may be mid-turn, and its transcript is the only
-- record of what that agent did — while clearing the parent's policy silently changes when the task
-- completes. Both are the operator's call, and this migration refuses to make it for them.
DO $$
DECLARE conflicting text;
BEGIN
  SELECT string_agg(format('  task %s (%s)  session %s (%s)', t."id", t."completion_policy",
                           s."id", s."status"), E'\n' ORDER BY t."id", s."id")
    INTO conflicting
    FROM "task" t
    JOIN "session" s ON s."task_id" = t."id" AND s."deleted_at" IS NULL
                    AND s."starts_task_work"
                    AND s."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
   WHERE t."completion_policy" <> 'MANUAL'
     AND EXISTS (SELECT 1 FROM "task" c
                  WHERE c."parent_task_id" = t."id" AND c."owner_id" = t."owner_id");
  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION E'TASK_AGGREGATE_PARENT_LIVE_SESSION: these tasks are completed by aggregating their subtasks AND are holding a live work session right now, which is the state this release exists to make impossible:\n%\n\nThis migration changed nothing and has rolled back. Each of these sessions is running against a task that has no completion condition of its own — it cannot report done, because only the recomputation over its subtasks may finish that row.\n\nFor each pair, decide which of the two is telling the truth and write THAT, explicitly:\n  * the run is doing real work that belongs to this task -> the task is not a roll-up: set completion_policy = MANUAL, and let the run finish and complete it normally;\n  * the task really is a roll-up and this run should never have started -> leave completion_policy alone, and let the mis-dispatched session reach a real terminal status of its own, or end/cancel it as an audited act with a reason recorded.\nNeither is done automatically. A live session''s transcript is the only record of what that agent did, and which of the two readings is right is not derivable from the row.', conflicting;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. The universal dispatch guard, inside the ONE function that already orders admission locks.
-- ---------------------------------------------------------------------------------------------
-- Every door reaches this one statement — Run Now, batch Run, `task_start`, `orbit task start`, the
-- dependency-unlock trigger, the auto-run sweep, the scheduled sweep, the foreman sweep, the
-- verification filer and the Project dispatcher. Five of those keep their own copy of "is this task
-- eligible"; this is the copy none of them can disagree with, and the one a binary that predates
-- this release still obeys.
--
-- WHY THIS IS A `CREATE OR REPLACE` OF 0130'S FUNCTION AND NOT A SECOND TRIGGER
-- ============================================================================
-- The check needs `FOR UPDATE` on the task, because `FOR UPDATE` is the one mode a child insert's
-- FK `FOR KEY SHARE` conflicts with — that conflict is the entire linearization. But
-- `session_admission_lock_order` already takes that row `FOR SHARE NOWAIT`, and it sorts FIRST
-- (per-row triggers fire in name order, and `session_admission_lock_order` is 0130's chosen first).
-- A separate trigger would therefore be asking to UPGRADE a lock this transaction already holds —
-- and two transactions that both hold SHARE and both want UPDATE deadlock on each other, which is
-- the one failure mode 0130's whole NOWAIT protocol was written to avoid.
--
-- So there is no second acquisition: the existing function takes the STRONGER mode in the first
-- place, for exactly the rows that need it, and asks the new question while it holds it. Its
-- `FOR SHARE NOWAIT` stays for every other row, so nothing that is not a dispatch pays for this.
--
-- `NOWAIT`, like every other acquisition in this function after the first, and for 0130's reason
-- verbatim: each is taken with something already held, and waiting is what builds a cycle. A
-- transaction that cannot have the row gets `SESSION_TASK_BUSY` with nothing written, and retries.
CREATE OR REPLACE FUNCTION "session_admission_lock_order"() RETURNS trigger AS $$
DECLARE old_live boolean; new_live boolean; new_work_live boolean; ordered UUID;
        scope_before UUID[]; scope_after UUID[];
        policy text; child_id uuid; task_owner uuid;
BEGIN
  old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
    AND OLD."deleted_at" IS NULL
    AND OLD."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');
  new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL
    AND NEW."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');
  -- §13.1 AG6's scope: a row that is live AND claims to be doing the task's work. Reading it here
  -- rather than at the check keeps one definition of "this session occupies its task as work".
  new_work_live := new_live AND NEW."starts_task_work";

  -- The early return has to know about `starts_task_work` too, or every transition that turns it on
  -- — a terminal row revived, a soft-deleted row restored, a session rebound to another task, a
  -- conversation promoted to a work run — would skip the whole function while entering the exact
  -- state it guards. This is why the UPDATE trigger below lists that column: a trigger declared
  -- `UPDATE OF` a column set does not fire at all for a write that touches none of them.
  IF TG_OP = 'UPDATE' AND old_live = new_live
     AND OLD."task_id" IS NOT DISTINCT FROM NEW."task_id"
     AND OLD."starts_task_work" IS NOT DISTINCT FROM NEW."starts_task_work" THEN
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
    -- §13.1 AG6's linearization point, at 0130's mode and NOT a stronger one.
    --
    -- An earlier draft upgraded this to `FOR UPDATE` when the session starts task work, reasoning
    -- that admission has to exclude a child arriving and a `completion_policy` write landing. It
    -- does — but the exclusion is already provided from the OTHER side, and taking it from here as
    -- well cost something unrelated.
    --
    -- `task_aggregate_parent_shape_guard` (this migration, §4) fires on exactly those two writes
    -- and takes the parent `FOR UPDATE` itself. `FOR SHARE` conflicts with `FOR UPDATE`, so a
    -- child insert and a policy flip still cannot interleave with an admission: whichever arrives
    -- second waits or is refused, which is all the linearization needs.
    --
    -- What `FOR UPDATE` here DID do is conflict with `FOR KEY SHARE`, which is the mode an edge
    -- write's foreign keys take on the very same rows. Since 0132 an edge write holds those FK
    -- locks while it queues on `task_dependency_revision`, so a Coordinator dispatch inserting its
    -- Session mid-decision was refused `SESSION_TASK_BUSY` by a lock it did not need — measured,
    -- not argued: `dependency-revision.pg.spec.ts` is 10/10 with `FOR SHARE` and 7/10 with
    -- `FOR UPDATE`, and the two it loses are the dispatch-versus-edge barriers.
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

  -- §13.1 AG6, asked under the `FOR UPDATE` taken above and therefore an answer that stays true
  -- until this transaction commits. Only for a row ENTERING live work: an @-mention conversation, a
  -- child session and an explicit `session_create` against a roll-up node are not dispatch, and
  -- reading a parent or asking it a question is a thing a person may legitimately do. 0130 draws
  -- the same line in the same place and for the same reason.
  IF new_work_live THEN
    -- Both facts off the row this transaction now holds `FOR UPDATE`, and the OWNER comes from the
    -- TASK, never from `NEW."owner_id"`. Nothing in the schema forces a session's owner to equal
    -- its task's — a raw insert, or a bug in an older writer, can produce a cross-owner row — and
    -- scoping the child lookup by the session's owner would let such a row read a genuine aggregate
    -- parent as childless and start work on it. The task's identity is what this rule is about.
    SELECT t."completion_policy", t."owner_id" INTO policy, task_owner
      FROM "task" t WHERE t."id" = NEW."task_id";
    IF FOUND AND policy <> 'MANUAL' THEN
      -- AG4 read forwards: the policy is inert on a childless task, so a childless task carrying
      -- one is an ordinary leaf and stays dispatchable. Existence, not a count. Owner-scoped and
      -- NOT project-scoped, because that is the scope `collectAggregationScope` walks — it runs for
      -- every task, including one in no project at all, and follows `parent_task_id` across a
      -- project boundary. The API refuses a cross-project parent (`assertParentEligible`), so the
      -- two scopes differ only for rows raw SQL produced, and there the wider one fails closed.
      SELECT c."id" INTO child_id
        FROM "task" c
       WHERE c."parent_task_id" = NEW."task_id" AND c."owner_id" = task_owner
       LIMIT 1;
      IF child_id IS NOT NULL THEN
        RAISE EXCEPTION
          'TASK_AGGREGATE_PARENT: task % is completed by aggregating its subtasks (%), so it has no work of its own to run. Run its subtasks, or set its completion policy to MANUAL.',
          NEW."task_id", policy
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-created only to add `starts_task_work` to the UPDATE trigger's column set. A trigger declared
-- `UPDATE OF <cols>` does not fire for a write that touches none of them, so without this line a
-- statement that flips `starts_task_work` on an existing row would enter the guarded state without
-- the guard ever running. The INSERT/DELETE trigger is unchanged and is left alone.
DROP TRIGGER IF EXISTS "session_admission_lock_order_update" ON "session";
CREATE TRIGGER "session_admission_lock_order_update"
  BEFORE UPDATE OF "status", "task_id", "deleted_at", "starts_task_work" ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_admission_lock_order"();

-- ---------------------------------------------------------------------------------------------
-- 4. The same invariant from the task side: nothing may turn a RUNNING task into an aggregate parent.
-- ---------------------------------------------------------------------------------------------
-- §3 stops a Session being started on a task that is ALREADY an aggregate parent. It says nothing
-- about the other order, and the other order reaches the same illegal state:
--
--   a childless `ALL_CHILDREN_DONE` task is an ordinary leaf, so it is dispatched, correctly, and a
--   Worker is now running it and will write DONE when it finishes. File a subtask under it and the
--   policy activates in that instant — `recompute` starts deciding that row's status from its
--   children while the Worker is still working towards writing it too. Two completion owners, and
--   AG3's reopen makes whichever loses permanent.
--
-- Three writes reach that shape, and all three are covered:
--
--   * a child gains this task as its parent (INSERT, or UPDATE of `parent_task_id`);
--   * this task's own `completion_policy` goes MANUAL -> aggregating while it has children;
--   * `is_foreman` changes on a row where that would matter (§1's constraint already forbids the
--     conflicting pair outright, so this is the belt to its braces).
--
-- The RELEASE directions are all allowed, deliberately: delete a child, move a child OUT, switch
-- back to MANUAL. Every one of them ENDS the two-owner state, and refusing them would close the
-- only exits from a wedge. That is why the activation check runs against the NEW parent only — the
-- old parent of a moved child is losing a child, which can only make it more dispatchable, and it
-- is touched but never refused.
--
-- Both this and §3 take `FOR UPDATE` on the SAME task row, which is what makes the pair
-- linearizable rather than merely careful: whichever transaction gets the lock first commits its
-- side, and the second reads the first's committed effect and refuses. There is no interleaving in
-- which both succeed.
--
-- The touch at the end is the REPEATABLE READ half described at the top of this file: refusing the
-- child write only helps if the writer arrives while the dispatcher HOLDS the lock. A child that
-- committed before the dispatcher's lock but after its snapshot took no lock at all, and bumping
-- the parent's row version is what turns that into a `40001` on the dispatcher's own `FOR UPDATE`
-- instead of a stale read. It also produces one `task.updated` signal for the parent through 0117,
-- which is correct — the parent's aggregation state genuinely did change.
-- LOCK ORDER: PROJECT, THEN TASK — the same total order 0130 and 0127 already impose
-- ==================================================================================
-- This guard takes a PARENT TASK row. Everything that writes a task then reaches 0127's
-- `project_acceptance_task_fact` on the AFTER side, which calls `project_acceptance_reopen` and
-- takes that task's `project` row `FOR NO KEY UPDATE`. So a child INSERT is inherently
-- **task → project**, while `applyDecisionAction` is **project → task**: it locks the project row
-- first (§9.6 AU1) and only then reaches the authorization adapter's task lock. Forced to
-- interleave —
--
--   T_child:    holds parent task   -> waits for project
--   T_dispatch: holds project       -> waits for parent task
--
-- — that is a native `40P01`, and PostgreSQL kills one of them at random. Sorting the old and new
-- parent UUIDs does nothing about it: the cycle is across two TABLES, and no order within one of
-- them is a total order over both.
--
-- The answer is the one already in this database, taken from `task_supersession_project_lock_order`
-- verbatim, and it has two halves:
--
--   * on INSERT, no task row is held when a BEFORE ROW trigger runs, so the projects can genuinely
--     be pre-acquired and this path becomes project → task like everything else;
--   * on UPDATE, PostgreSQL locks the task row before any BEFORE ROW trigger fires, so
--     pre-acquisition is not available — the write is already task → project by the time anything
--     of ours executes. **NOWAIT converts it**: waiting is what makes a cycle, and refusing
--     immediately cannot. Every acquisition below is NOWAIT for that reason, including the first,
--     so no acquisition order can close a loop even against a writer following no rule at all.
--
-- Each refusal is typed, names itself, and leaves nothing written, so the caller retries rather
-- than reading a random deadlock victim. `taskFenceConflictMessage` turns all three into a 409.
CREATE OR REPLACE FUNCTION "task_aggregate_parent_shape_guard"() RETURNS trigger AS $$
DECLARE
  activations uuid[];      -- parents this write could ACTIVATE; each is checked
  touching uuid[];         -- parents whose row version must move; a superset of the above
  parent_id uuid;
  policy text;
  task_owner uuid;
  live_session uuid;
  child_id uuid;
  joining boolean;
  scope_before uuid[];
  scope_after uuid[];
  ordered uuid;
  owner_changed boolean;
  needs_project_lock boolean;
  old_parent uuid;
  new_parent uuid;
  candidates uuid[];
  self_activating boolean;
BEGIN
  owner_changed := TG_OP = 'UPDATE' AND NEW."owner_id" IS DISTINCT FROM OLD."owner_id";
  activations := ARRAY[]::uuid[];
  touching := ARRAY[]::uuid[];
  self_activating := false;

  IF TG_OP = 'INSERT' THEN
    new_parent := NEW."parent_task_id";
  ELSE
    -- (a) The row's PARENT LINK moved, or the row moved between owner sets. Both change which
    --     children a parent has, and `owner_id` is the one that does it without naming the parent:
    --     a task whose owner becomes its parent's owner JOINS that parent's children, and this migration's
    --     child lookup is owner-scoped because `collectAggregationScope` is. Without this branch a
    --     raw `UPDATE task SET owner_id = ...` walks a task into a running parent's subtree with
    --     no guarded column touched at all.
    IF NEW."parent_task_id" IS DISTINCT FROM OLD."parent_task_id" OR owner_changed THEN
      old_parent := OLD."parent_task_id";
      new_parent := NEW."parent_task_id";
    END IF;
    -- (b) The row's OWN shape changed, which makes it its own subject. Three ways in: the policy
    --     leaves MANUAL, the foreman flag moves, or — again — the OWNER moves, because a parent's
    --     children are the ones sharing its owner, so re-owning a parent can hand it a subtree it
    --     did not have a moment ago.
    --
    --     Read from NEW, never re-read from the table: in a BEFORE UPDATE trigger the stored row
    --     still holds the OLD values, so asking the database here would answer MANUAL for the very
    --     write that is leaving MANUAL — the transition would be invisible to its own guard.
    IF (NEW."completion_policy" IS DISTINCT FROM OLD."completion_policy"
        OR NEW."is_foreman" IS DISTINCT FROM OLD."is_foreman"
        OR owner_changed)
       AND NEW."completion_policy" <> 'MANUAL' THEN
      self_activating := true;
    END IF;
  END IF;

  -- Membership is DIRECTIONAL, and it is decided AFTER the lock, never before it.
  --
  -- The predicate counts children that share the parent's owner, so whether this row counts towards
  -- a parent depends on which side of the write is asked about: the OLD parent by the owner this
  -- row HAD, the NEW one by the owner it now has. Both matter — an owner move A -> B makes the old
  -- parent (owner A) lose its last counted child, and that release has to be published or a
  -- REPEATABLE READ reader goes on believing it is still an aggregate parent.
  --
  -- What must NOT happen is deciding membership from an UNLOCKED read and skipping the lock when it
  -- says "different owner". That is not a safe exclusion, and the interleaving is exact:
  --
  --   T1 inserts a child (owner B) under a parent owned by A. Unlocked, it reads "not my owner",
  --      drops the candidate, and takes NO lock.
  --   T2 changes that parent's owner A -> B. Its own self-check reads the children from its
  --      statement snapshot, which cannot see T1's uncommitted row, and concludes childless.
  --   Both commit. The parent is now owner B, the child is owner B, and it counts — next to a live
  --      work Session that neither transaction was in a position to notice.
  --
  -- The FK's `FOR KEY SHARE` does not close it either: `owner_id` is not a key column, so an UPDATE
  -- of it takes `FOR NO KEY UPDATE`, which that mode does not conflict with. So every candidate is
  -- LOCKED first and its owner is read fresh underneath, below.
  candidates := ARRAY(
    SELECT DISTINCT u FROM unnest(ARRAY[old_parent, new_parent]) AS u
     WHERE u IS NOT NULL AND u <> NEW."id" ORDER BY u);

  -- What is deliberately NOT done here is an early out on the parent's CURRENT policy. Reading it
  -- unlocked and returning when it says MANUAL looks free and is not: a child INSERT that reads
  -- MANUAL takes no lock, so it does not serialize against a concurrent MANUAL -> aggregating
  -- UPDATE on that same parent. Both then read a world without the other — the policy write sees no
  -- children, the child write sees a MANUAL parent — both commit, and the result is precisely the
  -- state this guard exists to make unreachable: aggregating, with a child, with a live Session.
  -- Locking IS the check; anything that skips the lock skips the check.
  --
  -- The cost that early out was trying to avoid is paid by the TG_OP split below instead: on INSERT
  -- the acquisition can WAIT, so filing an ordinary subtask waits briefly behind a reconcile rather
  -- than being refused.

  -- 0127's `project_acceptance_task_fact_update` runs on the AFTER side of EVERY write this trigger
  -- is declared on, and it calls `project_acceptance_reopen`, which takes the task's `project` row.
  -- So a write this guard has nothing to say about STILL ends up task -> project — and the release
  -- directions are exactly those writes: aggregating -> MANUAL, or one aggregating policy to
  -- another, leave both arrays empty. Left to fall through, such an UPDATE holds its task row and
  -- then blocks on a project a reconcile is holding while that reconcile waits on this very task.
  -- That is a `40P01` reached by the one path that is entirely legitimate.
  needs_project_lock := TG_OP <> 'INSERT'
    AND (NEW."completion_policy" IS DISTINCT FROM OLD."completion_policy" OR owner_changed);

  IF array_length(candidates, 1) IS NOT NULL OR self_activating OR needs_project_lock THEN
    -- ---- 1. PROJECTS FIRST, in UUID order ---------------------------------------------------
    SELECT array_agg(DISTINCT pid ORDER BY pid) INTO scope_before FROM (
      SELECT t."project_id" AS pid FROM "task" t WHERE t."id" = ANY (candidates)
      UNION SELECT CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."project_id" END
      UNION SELECT NEW."project_id"
    ) scope WHERE pid IS NOT NULL;

    IF scope_before IS NOT NULL THEN
      FOREACH ordered IN ARRAY scope_before LOOP
        IF TG_OP = 'INSERT' THEN
          -- WAITING is safe here, and only here. On INSERT this transaction holds no task row when
          -- a BEFORE ROW trigger runs — the row does not exist yet and the FK checks are AFTER — so
          -- taking the project first makes this path project -> task like every other writer, and a
          -- waiter that holds nothing cannot be part of a cycle. It is also what a subtask filed
          -- under a roll-up node deserves: a short wait behind a reconcile, not a refusal.
          PERFORM 1 FROM "project" p WHERE p."id" = ordered FOR NO KEY UPDATE;
        ELSE
          -- On UPDATE, PostgreSQL locked the task row before this trigger ran, so this transaction
          -- is ALREADY task -> project and waiting here is exactly the edge that closes the cycle
          -- against a Coordinator holding the project and reaching for the task. NOWAIT converts
          -- it: a typed refusal with nothing written, which the caller retries, instead of a
          -- `40P01` victim chosen at random.
          BEGIN
            PERFORM 1 FROM "project" p WHERE p."id" = ordered FOR NO KEY UPDATE NOWAIT;
          EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION
              'TASK_AGGREGATE_PROJECT_BUSY: project % is being reconciled right now, so this task write cannot be checked in this transaction — nothing was written; retry',
              ordered
              USING ERRCODE = 'lock_not_available';
          END;
        END IF;
      END LOOP;
    END IF;

    -- ---- 2. THEN THE PARENT TASK ROWS, in UUID order ----------------------------------------
    -- `FOR UPDATE` is the mode, and it is the same one `session_admission_lock_order` takes on the
    -- same row: that shared conflict is what linearizes "start a Session on this parent" against
    -- "make this parent an aggregate parent".
    IF array_length(candidates, 1) IS NOT NULL THEN
      IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM "task" t WHERE t."id" = ANY (candidates) ORDER BY t."id" FOR UPDATE;
      ELSE
        BEGIN
          PERFORM 1 FROM "task" t WHERE t."id" = ANY (candidates) ORDER BY t."id" FOR UPDATE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
          RAISE EXCEPTION
            'TASK_AGGREGATE_PARENT_BUSY: this task''s parent is being written right now, so this write cannot be checked in this transaction — nothing was written; retry'
            USING ERRCODE = 'lock_not_available';
        END;
      END IF;
    END IF;

    -- ---- 3. CONFIRM THE SCOPE DID NOT MOVE --------------------------------------------------
    -- Which projects to take was read before those task rows were held, so a parent moved between
    -- the two reads would leave this transaction holding P1 while the AFTER trigger reaches for P2
    -- — the same inversion, one step later. Fail closed, exactly as 0130 does.
    SELECT array_agg(DISTINCT pid ORDER BY pid) INTO scope_after FROM (
      SELECT t."project_id" AS pid FROM "task" t WHERE t."id" = ANY (candidates)
      UNION SELECT CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."project_id" END
      UNION SELECT NEW."project_id"
    ) scope WHERE pid IS NOT NULL;
    IF scope_after IS DISTINCT FROM scope_before THEN
      RAISE EXCEPTION
        'TASK_AGGREGATE_SCOPE_MOVED: a task involved in this write changed project while it was being checked — nothing was written; retry'
        USING ERRCODE = 'lock_not_available';
    END IF;
  END IF;

  -- ---- 3b. MEMBERSHIP, ON FRESH READS TAKEN UNDER THE LOCK ---------------------------------
  -- Now the owners cannot move. A candidate that is still cross-owner counts for nothing and is
  -- neither checked nor bumped; one whose owner has come to match is a genuine counted transition
  -- and is treated as such.
  IF old_parent IS NOT NULL AND old_parent <> NEW."id"
     AND NOT EXISTS (SELECT 1 FROM "task" p
                      WHERE p."id" = old_parent AND p."owner_id" = OLD."owner_id") THEN
    old_parent := NULL;
  END IF;
  IF new_parent IS NOT NULL AND new_parent <> NEW."id"
     AND NOT EXISTS (SELECT 1 FROM "task" p
                      WHERE p."id" = new_parent AND p."owner_id" = NEW."owner_id") THEN
    new_parent := NULL;
  END IF;
  activations := ARRAY(
    SELECT DISTINCT u FROM unnest(ARRAY[
      CASE WHEN self_activating THEN NEW."id" ELSE NULL END, new_parent
    ]) AS u WHERE u IS NOT NULL ORDER BY u);
  touching := ARRAY(
    SELECT DISTINCT u FROM unnest(ARRAY[old_parent, new_parent]) AS u
     WHERE u IS NOT NULL AND u <> NEW."id" ORDER BY u);

  -- ---- 4. CHECK EACH ACTIVATION -------------------------------------------------------------
  FOREACH parent_id IN ARRAY activations LOOP
    IF parent_id = NEW."id" THEN
      policy := NEW."completion_policy";
      task_owner := NEW."owner_id";
      -- Normally a row is not its own child, so only its EXISTING children count and `joining` is
      -- false. A SELF-PARENT is the exception, and it is a real bypass rather than a curiosity:
      -- `UPDATE task SET parent_task_id = id` on a childless aggregating task with a live run makes
      -- that task its own direct child, so it becomes an aggregate parent — while the child lookup
      -- below excludes `NEW."id"` and would find nothing to object to. The service refuses a parent
      -- cycle (`assertNoParentCycle`), so this arrives only by raw SQL, which is exactly the writer
      -- this file exists for. Fail closed: the row IS arriving in its own counted set.
      -- `IS NOT DISTINCT FROM`, not `=`: a childless task has a NULL parent, and `NULL = id` is
      -- NULL rather than false — which then makes `NOT joining` NULL too, so the guard would fall
      -- through to the live-session check and refuse an ordinary childless policy flip.
      joining := NEW."parent_task_id" IS NOT DISTINCT FROM NEW."id";
    ELSE
      -- The PARENT's owner, off the row already held `FOR UPDATE` — not the child's. Whose subtree
      -- this is is a fact about the parent, and scoping by the writer's owner is what let an
      -- `owner_id` UPDATE walk a task into a running parent unnoticed.
      SELECT t."completion_policy", t."owner_id" INTO policy, task_owner
        FROM "task" t WHERE t."id" = parent_id;
      CONTINUE WHEN NOT FOUND;
      -- Is THIS row arriving in that parent's counted set? On INSERT and on a re-parent, yes. On an
      -- owner move it depends which way: becoming the parent's owner is joining, leaving it is a
      -- release and must not be refused.
      joining := NEW."owner_id" = task_owner;
    END IF;
    CONTINUE WHEN policy = 'MANUAL';

    -- A RELEASE is never refused, and this is where that promise is kept for the external-parent
    -- branch. When `joining` is false this row is LEAVING that parent's counted set — an owner
    -- move out, or a re-parent onto a parent with a different owner — and leaving cannot create the
    -- state this guard is about. Asking about the parent's other children here would refuse a
    -- release whenever a sibling happened to exist, which contradicts the whole release direction:
    -- the parent's own situation is not this write's doing and is not made worse by it.
    --
    -- The parent's OWN shape changing is a different question and is checked on its own iteration,
    -- through the `parent_id = NEW."id"` branch above, where `joining` means "this row is its own
    -- child" (a self-parent) rather than "this row is arriving".
    IF parent_id <> NEW."id" THEN
      CONTINUE WHEN NOT COALESCE(joining, false);
    ELSE
      -- AG4 read forwards: the policy is inert on a childless task, so a childless task carrying
      -- one is an ordinary leaf and stays dispatchable. Existence, not a count. This row is
      -- excluded so a self-parent is answered by `joining` and not by its own half-written row.
      SELECT c."id" INTO child_id
        FROM "task" c
       WHERE c."parent_task_id" = parent_id AND c."owner_id" = task_owner AND c."id" <> NEW."id"
       LIMIT 1;
      CONTINUE WHEN child_id IS NULL AND NOT COALESCE(joining, false);
    END IF;

    SELECT s."id" INTO live_session
      FROM "session" s
     WHERE s."task_id" = parent_id AND s."deleted_at" IS NULL AND s."starts_task_work"
       AND s."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
     LIMIT 1;
    IF live_session IS NOT NULL THEN
      RAISE EXCEPTION
        'TASK_AGGREGATE_PARENT_ACTIVATION: task % is running work session % right now, and this write would hand its completion to its subtasks (%) instead. Let that run reach a terminal status of its own first, or set the completion policy to MANUAL.',
        parent_id, live_session, policy
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- The REPEATABLE READ half described at the top of this file: refusing the child write only helps
  -- if the writer arrives while the dispatcher HOLDS the lock. A child that committed before the
  -- dispatcher's lock but after its snapshot took no lock at all, and bumping the parent's row
  -- version turns that into a `40001` on the dispatcher's own `FOR UPDATE` instead of a stale read.
  -- It also produces one `task.updated` signal for the parent through 0117, which is correct — the
  -- parent's aggregation state genuinely did change.
  --
  -- Already locked, in ascending id order, by the pass above. Cannot recurse: this UPDATE writes
  -- none of the columns the trigger below is declared on.
  -- No owner filter here: `touching` already holds only parents this row counts towards, each
  -- judged on its own side of the write, so bumping them is exactly the set of wakeups owed.
  FOREACH parent_id IN ARRAY touching LOOP
    UPDATE "task" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = parent_id;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `owner_id` is in the column set for the reason branch (a) gives: a parent's children are the
-- tasks that share its owner, so re-owning either end changes the subtree with no other column
-- touched. Leaving it out was a hole a raw writer could walk straight through.
-- ---------------------------------------------------------------------------------------------
-- 5. A DELETED child is a release too, and it has to take the same lock.
-- ---------------------------------------------------------------------------------------------
-- §4's trigger is declared on INSERT and on UPDATE of four columns, so DELETING a child does not
-- fire it — and deleting the LAST same-owner child is a release direction: the parent stops being
-- an aggregate parent at that instant. Left uncovered it breaks the one property the settle in
-- `AutoRetryService` and the gate in `ProjectAuthorizationService` both rest on, which is that
-- every change to the predicate serializes against a `FOR UPDATE` of the parent. A reader holding
-- that lock would otherwise still see a stale answer, because nothing took the lock to change it.
--
-- Only the lock and the touch: a delete is never REFUSED here. Losing a child can only make a
-- parent more dispatchable, and refusing deletes would close an exit rather than a door.
CREATE OR REPLACE FUNCTION "task_aggregate_parent_child_delete_touch"() RETURNS trigger AS $$
DECLARE
  scope uuid;
  locked_scope uuid;
  parent_owner uuid;
BEGIN
  -- A self-parented row (raw SQL only; `assertNoParentCycle` refuses it) IS its own parent, so the
  -- "parent" this would lock and touch is the very tuple being deleted. Updating it inside a BEFORE
  -- DELETE trigger is an error, and there is nothing to serialize against anyway: the parent is
  -- disappearing in this same statement, so no reader can be holding a predicate about it that
  -- outlives the delete.
  IF OLD."parent_task_id" IS NULL OR OLD."parent_task_id" = OLD."id" THEN
    RETURN OLD;
  END IF;
  -- The parent is ALWAYS a candidate, and whether this row counts towards it is decided under the
  -- lock — never before it. Standing down here on an unlocked owner read looks like a free
  -- optimisation and is the same hole §4 describes, reached from the delete side:
  --
  --   T1 deletes a cross-owner child. Unlocked, it reads "not my owner", returns, takes NO lock.
  --   T2 re-owns the parent to that child's owner and commits.
  --   T3's settle now holds the parent, sees the child (T1 has not committed), and disarms a retry.
  --   T1 commits. The child is gone, the parent never got locked or bumped, and the leaf's retry
  --     was thrown away on evidence that no longer exists.
  --
  -- Taking the lock is what serializes this delete against both of the others, so it is taken
  -- first and the owner is re-read underneath it. The unlocked read below is only a GUESS about
  -- which project to take, and it is re-confirmed after the lock like every other one in this file.
  --
  -- project -> task, the same order as everywhere else. NOWAIT: a DELETE already holds this row,
  -- so waiting here is the task -> project edge that closes a cycle against a reconcile.
  SELECT t."project_id" INTO scope FROM "task" t WHERE t."id" = OLD."parent_task_id";
  IF NOT FOUND THEN
    RETURN OLD;                       -- no parent row at all; there is nothing to serialize against
  END IF;
  IF scope IS NOT NULL THEN
    BEGIN
      PERFORM 1 FROM "project" p WHERE p."id" = scope FOR NO KEY UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION
        'TASK_AGGREGATE_PROJECT_BUSY: project % is being reconciled right now, so this task write cannot be checked in this transaction — nothing was written; retry',
        scope
        USING ERRCODE = 'lock_not_available';
    END;
  END IF;
  BEGIN
    -- The lock a reader of the predicate holds, so "this parent lost its last child" cannot commit
    -- underneath one. The UPDATE below is also the row-version bump the RR reader needs.
    SELECT t."project_id", t."owner_id" INTO locked_scope, parent_owner
      FROM "task" t WHERE t."id" = OLD."parent_task_id" FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'TASK_AGGREGATE_PARENT_BUSY: this task''s parent is being written right now, so this write cannot be checked in this transaction — nothing was written; retry'
      USING ERRCODE = 'lock_not_available';
  END;
  IF NOT FOUND THEN
    RETURN OLD;                       -- the parent went away between the two reads; nothing to hold
  END IF;
  -- The project taken above was chosen from an UNLOCKED read. If the parent has since been re-filed
  -- this transaction is holding the OLD project while the touch below — and 0127's acceptance
  -- trigger behind it — reaches for the new one: the task -> project inversion, one step late.
  -- Fail closed and let the caller retry rather than take a second project out of order.
  IF locked_scope IS DISTINCT FROM scope THEN
    RAISE EXCEPTION
      'TASK_AGGREGATE_SCOPE_MOVED: a task involved in this write changed project while it was being checked — nothing was written; retry'
      USING ERRCODE = 'lock_not_available';
  END IF;
  -- NOW the owner decides, on a value read under the lock. A child that still does not share its
  -- parent's owner counts for nothing, so the parent is released untouched — a cross-owner bump
  -- would wake another tenant's project over a change that means nothing to it. The lock was still
  -- worth taking: it is what stopped the owner moving while this was being decided.
  IF parent_owner IS DISTINCT FROM OLD."owner_id" THEN
    RETURN OLD;
  END IF;
  UPDATE "task" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = OLD."parent_task_id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_aggregate_parent_child_delete_touch"
  BEFORE DELETE ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_aggregate_parent_child_delete_touch"();

CREATE TRIGGER "task_aggregate_parent_shape_guard"
  BEFORE INSERT OR UPDATE OF "parent_task_id", "completion_policy", "is_foreman", "owner_id"
  ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_aggregate_parent_shape_guard"();

COMMIT;
