-- 0617 — the files a fork's snapshot changed (docs/task-fork-from-session-design.md §2.5, §2.7 F4; task P3
-- of project 34vgIh3m69UttihIN8M38).
--
-- WHAT IT ADDS
-- ============
--   `task.fork_changed_files`: the paths the snapshot commit S changed relative to the forking session's
--   HEAD (`git diff --name-only <fork_base_head> <fork_sha>`), as `orbit mcp` read them when it took the
--   snapshot. The control plane has no copy of that repository, so this is the only place it can name
--   them from, and the task_await payload of a forked task does: an edit the forking session reverts after
--   the snapshot comes back through the merge without a conflict (F4), and these are the files where that
--   can happen. '{}' on a task that was not forked, on a fork of a clean checkout, and on one forked by a
--   runner too old to send them (`fork_includes_uncommitted` tells the first two apart). Written by the
--   create doors only, like 0615's five columns, so 0615's `task_fork_guard` is replaced to refuse a later
--   write of it as well.
--
-- LOCKS
-- =====
-- As 0615: one DO taking `task` in short tries (2 s each, at most 45), catalog changes only — a column
-- whose default is a constant is added without rewriting a row (PostgreSQL 11+). Replacing the function first locks no table. Safe to run twice.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing task reads '{}'. An older apiserver writes nothing to it; the trigger it does not know
-- about refuses only what that apiserver never does.

CREATE OR REPLACE FUNCTION task_fork_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."fork_session_id" IS DISTINCT FROM OLD."fork_session_id"
     OR NEW."fork_runner_id" IS DISTINCT FROM OLD."fork_runner_id"
     OR NEW."fork_sha" IS DISTINCT FROM OLD."fork_sha"
     OR NEW."fork_base_head" IS DISTINCT FROM OLD."fork_base_head"
     OR NEW."fork_includes_uncommitted" IS DISTINCT FROM OLD."fork_includes_uncommitted"
     OR NEW."fork_changed_files" IS DISTINCT FROM OLD."fork_changed_files" THEN
    RAISE EXCEPTION
      'TASK_FORK_IMMUTABLE: task % was forked or not when it was created; a different starting point is a new task',
      OLD."id" USING ERRCODE = 'raise_exception';
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
      LOCK TABLE "task" IN ACCESS EXCLUSIVE MODE;

      ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "fork_changed_files" TEXT[] NOT NULL DEFAULT '{}';

      DROP TRIGGER IF EXISTS "task_fork_guard" ON "task";
      CREATE TRIGGER "task_fork_guard"
        BEFORE UPDATE OF "fork_session_id", "fork_runner_id", "fork_sha", "fork_base_head",
          "fork_includes_uncommitted", "fork_changed_files" ON "task"
        FOR EACH ROW EXECUTE FUNCTION task_fork_guard();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '0617: "task" was not free in 45 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0617_task_fork_changed_files) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
