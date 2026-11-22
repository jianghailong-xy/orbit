-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1422: the 0134 guards read the release fact, not the status (docs/session-three-state-plan.md §7 step 4.4,
-- appendix A of docs/session-three-state-read-sites.md; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT CHANGES
-- ---------------
-- Two functions, each replaced with its live body and only the lines below changed:
--
--   session_admission_lock_order (0134; triggers session_admission_lock_order_insert_delete, ..._update)
--     was  AND OLD."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED');   (and NEW.)
--     now  AND OLD."finished_at" IS NULL;                                                  (and NEW.)
--   task_aggregate_parent_shape_guard (0134; trigger on task)
--     was  AND s."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
--     now  AND s."finished_at" IS NULL
--
-- One trigger column list gains "finished_at", re-created in place with CREATE OR REPLACE TRIGGER (same name,
-- table, timing and function):
--   session_admission_lock_order_update   BEFORE UPDATE OF status, task_id, deleted_at, starts_task_work,
--                                         finished_at
--
-- WHY EVERY STORED ROW GETS THE SAME ANSWER
-- -----------------------------------------
-- As 1421: session_release_fact_chk (1401/1402) makes "status is terminal" and "finished_at is set" the same
-- test for every row, and no row holds the unused PARKED label (0071), so "one of the four held statuses" and
-- "finished_at is null" are the same test too.
--
-- WHY THE COLUMN LIST
-- -------------------
-- As 1421, and as this function's own comment on starts_task_work says: a trigger declared UPDATE OF a column
-- set does not fire at all for a write that touches none of them. Every release and revive today writes status
-- and finished_at together, so nothing is missed now; the list names the column the function reads so that
-- stays true. An extra firing reaches the function's no-change early return before it takes any lock.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE FUNCTION takes no table lock. CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on
-- session: asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries, as 1261 does. No column,
-- constraint, index or type; no INSERT, UPDATE or DELETE.
-- How it is sent: the file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction:
-- the function replacements and the triggers commit together, and the trigger locks are held until that one
-- commit. Nothing in it COMMITs. sessions/session-release.pg.spec.ts (12) applies it that way, with deployAgain,
-- on a database holding rows.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1422: after 1421 (rescanned 2026-11-21). Not a multiple of 10. Can run twice: CREATE OR REPLACE throughout.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.session_admission_lock_order()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE old_live boolean; new_live boolean; new_work_live boolean; ordered UUID;
        scope_before UUID[]; scope_after UUID[];
        policy text; child_id uuid; task_owner uuid;
BEGIN
  -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
  old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
    AND OLD."deleted_at" IS NULL
    AND OLD."finished_at" IS NULL;
  new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
    AND NEW."deleted_at" IS NULL
    AND NEW."finished_at" IS NULL;
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
$function$;

CREATE OR REPLACE FUNCTION public.task_aggregate_parent_shape_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
       -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
       AND s."finished_at" IS NULL
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
$function$;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE OR REPLACE TRIGGER "session_admission_lock_order_update"
        BEFORE UPDATE OF "status", "task_id", "deleted_at", "starts_task_work", "finished_at"
        ON "session"
        FOR EACH ROW EXECUTE FUNCTION "session_admission_lock_order"();
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
