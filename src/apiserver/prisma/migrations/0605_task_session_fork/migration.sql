-- 0605 — a task forked from the session that created it (docs/task-fork-from-session-design.md §2.3, §2.4;
-- docs/project-source-contract.md SR55, row PF of §4.1; task P1 of project 34vgIh3m69UttihIN8M38). 0606
-- validates the CHECKs below.
--
-- WHAT IT ADDS
-- ============
--   1. Five task columns, the fork as facts of the task's creation:
--        fork_session_id            the session the task was forked from: the session that made the
--                                   create call, on that call's runner credential. No foreign key (a
--                                   reference into history): deleting or trashing that session leaves
--                                   the task's starting point what it was.
--        fork_runner_id             the machine that session ran on when it forked, which is where the
--                                   snapshot commit exists (the keep-alive ref is in that repository).
--                                   SR55's authority runner. No foreign key, for the same reason.
--        fork_sha                   the snapshot commit S, 40 lowercase hex.
--        fork_base_head             the forking session's HEAD at the snapshot, 40 lowercase hex.
--        fork_includes_uncommitted  whether S carries edits that were not committed: exactly when S is
--                                   not HEAD (design §2.2 step 2), and the CHECK holds it to that.
--      All five are NULL (no fork, every task there has been) or all five are set. Written only by the
--      create doors, in the task row's own INSERT, and never afterwards: the trigger below refuses an
--      UPDATE that would change one (SR12: a retry starts from the same S).
--   2. `SESSION_FORK`, SOURCE's seventh kind: `session_source_kind_chk` takes it,
--      `session_source_kind_selector_chk` allows it only as a SHA-valued selector, and
--      `session_source_snapshot_chk` gives it its own shape — no codebase, no configuration version,
--      no repository identity the control plane could vouch for, no ref, the snapshot commit as the
--      SHA, RUNNER_LOCAL authority and nothing it must contain.
--   3. The two fork refusal codes join `session_source_refusal_code_chk`, which 0231 keeps word for
--      word equal to §10.1's table. Neither can land on a row (both are decided before a session
--      exists, and the pin door refuses them), exactly as SOURCE_PROTOCOL_UNSUPPORTED cannot.
--   The CHECKs are added back NOT VALID, which every new and updated row is held to at once, and 0606
--   validates them. No row holds the new kind or a fork column before this migration, so every row
--   passes as it passed the CHECKs these replace.
--
-- TAKING THE LOCKS IN SHORT TRIES
-- ===============================
-- `session` and `task` are read by every runner call and every sweep, so waiting for a lock on either
-- is the danger, as in 0476: a statement waiting for a lock queues every later reader and writer of
-- the table behind it. With production's lock_timeout of 30 s a long wait also fails the migration,
-- and a failed migration stops the apiserver from starting (P3009).
--
-- `migrate deploy` sends a file containing a DO statement to the server whole, as one statement and
-- so one transaction, and every lock it takes is held until it ends. Hence:
--   - The guard's function first. Replacing a function writes pg_proc and locks no table.
--   - Then ONE DO, which takes both tables in each try: `session` first, then `task`, in the order
--     every transaction that takes both does (lock-order ranks 30 then 50), in ACCESS EXCLUSIVE mode,
--     which the ADD COLUMNs, the trigger and the CHECK swaps need. lock_timeout is 2 s per lock; a try
--     that cannot have both gives back what it had, waits 1 s and tries again; a deadlock is a failed
--     try too. At most 45 tries, each at most 5 s: under 4 minutes, inside statement_timeout's 300 s.
--   - Inside the try, catalog changes only: nullable columns with no default write no row, and NOT
--     VALID CHECKs scan none. The scans are 0606's, a file whose statements go one by one.
-- Every statement is safe to run twice (IF NOT EXISTS, IF EXISTS).
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing task reads NULL in all five columns, so no task is a fork and nothing any of them
-- does changes. An older apiserver writes none of them, and rolling the code back leaves them unread.

CREATE OR REPLACE FUNCTION task_fork_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."fork_session_id" IS DISTINCT FROM OLD."fork_session_id"
     OR NEW."fork_runner_id" IS DISTINCT FROM OLD."fork_runner_id"
     OR NEW."fork_sha" IS DISTINCT FROM OLD."fork_sha"
     OR NEW."fork_base_head" IS DISTINCT FROM OLD."fork_base_head"
     OR NEW."fork_includes_uncommitted" IS DISTINCT FROM OLD."fork_includes_uncommitted" THEN
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
      LOCK TABLE "session", "task" IN ACCESS EXCLUSIVE MODE;

      ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "fork_session_id" UUID;
      ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "fork_runner_id" UUID;
      ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "fork_sha" TEXT;
      ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "fork_base_head" TEXT;
      ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "fork_includes_uncommitted" BOOLEAN;

      -- All or nothing, two full SHAs, and "includes uncommitted" meaning exactly S != HEAD.
      ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_fork_shape_chk";
      ALTER TABLE "task" ADD CONSTRAINT "task_fork_shape_chk"
        CHECK (
          ("fork_session_id" IS NULL AND "fork_runner_id" IS NULL AND "fork_sha" IS NULL
             AND "fork_base_head" IS NULL AND "fork_includes_uncommitted" IS NULL)
          OR ("fork_session_id" IS NOT NULL AND "fork_runner_id" IS NOT NULL
             AND "fork_sha" ~ '^[0-9a-f]{40}$' AND "fork_base_head" ~ '^[0-9a-f]{40}$'
             AND "fork_includes_uncommitted" = ("fork_sha" <> "fork_base_head"))
        ) NOT VALID;

      DROP TRIGGER IF EXISTS "task_fork_guard" ON "task";
      CREATE TRIGGER "task_fork_guard"
        BEFORE UPDATE OF "fork_session_id", "fork_runner_id", "fork_sha", "fork_base_head",
          "fork_includes_uncommitted" ON "task"
        FOR EACH ROW EXECUTE FUNCTION task_fork_guard();

      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_kind_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_kind_chk"
        CHECK ("source_kind" IS NULL OR "source_kind" IN (
          'VERIFICATION_SUBJECT', 'PINNED_REVISION', 'TASK_KNOWN_GOOD',
          'DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM', 'CHAT_UPSTREAM', 'SESSION_FORK')) NOT VALID;

      -- §4.1's truth table, with row PF: the snapshot is a commit.
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_kind_selector_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_kind_selector_chk"
        CHECK ("source_kind" IS NULL
           OR ("source_kind" IN ('VERIFICATION_SUBJECT', 'TASK_KNOWN_GOOD', 'SESSION_FORK') AND "source_revision_sha" IS NOT NULL)
           OR ("source_kind" IN ('DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM', 'CHAT_UPSTREAM') AND "source_ref" IS NOT NULL)
           OR "source_kind" = 'PINNED_REVISION') NOT VALID;

      -- The shapes per state: 0231's two, the chat's (0476), and the fork's. A fork resolves against no
      -- `ProjectCodebase` (row PF needs `codebase == null`), so there is no binding, configuration version
      -- or repository identity to freeze; its authority is the forking session's machine.
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_snapshot_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_snapshot_chk"
        CHECK (CASE WHEN "source_state" = 'UNBOUND' THEN
                 "source_kind" IS NULL AND "source_codebase_id" IS NULL
                 AND "source_repo_url" IS NULL AND "source_root_commit_sha" IS NULL
                 AND "source_ref" IS NULL AND "source_revision_sha" IS NULL
                 AND "source_config_revision" IS NULL AND "source_ref_authority" IS NULL
                 AND "source_required_contains" = '{}'::CHAR(40)[]
                 AND "source_base_sha" IS NULL AND "source_resolved_at" IS NULL
                 AND "source_resolved_by_runner_id" IS NULL
                 AND "source_refusal_code" IS NULL AND "source_refusal_detail" IS NULL
               WHEN "source_kind" = 'CHAT_UPSTREAM' THEN
                 "source_codebase_id" IS NULL AND "source_config_revision" IS NULL
                 AND "source_repo_url" IS NOT NULL AND "source_ref_authority" IS NOT NULL
                 AND "source_ref" IS NOT NULL AND "source_revision_sha" IS NULL
                 AND "source_required_contains" = '{}'::CHAR(40)[]
               WHEN "source_kind" = 'SESSION_FORK' THEN
                 "source_codebase_id" IS NULL AND "source_config_revision" IS NULL
                 AND "source_repo_url" IS NULL AND "source_root_commit_sha" IS NULL
                 AND "source_ref_authority" = 'RUNNER_LOCAL'
                 AND "source_ref" IS NULL AND "source_revision_sha" IS NOT NULL
                 AND "source_required_contains" = '{}'::CHAR(40)[]
               ELSE
                 "source_kind" IS NOT NULL AND "source_codebase_id" IS NOT NULL
                 AND "source_repo_url" IS NOT NULL AND "source_config_revision" IS NOT NULL
                 AND "source_ref_authority" IS NOT NULL
                 AND (("source_ref" IS NULL) <> ("source_revision_sha" IS NULL))
               END) NOT VALID;

      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_source_refusal_code_chk";
      ALTER TABLE "session" ADD CONSTRAINT "session_source_refusal_code_chk"
        CHECK ("source_refusal_code" IS NULL OR "source_refusal_code" IN (
          'PROJECT_CODEBASE_UNBOUND', 'BASE_REPO_MISMATCH', 'SOURCE_AUTHORITY_UNREACHABLE',
          'BASE_REF_NOT_FOUND', 'BASE_SHA_UNAVAILABLE', 'DEPENDENCY_BASE_NOT_LANDED',
          'WORKTREE_REQUIRED', 'SOURCE_PROTOCOL_UNSUPPORTED', 'SOURCE_PIN_IMMUTABLE',
          'CODEBASE_AUTHORITY_INVALID', 'FORK_SOURCE_NOT_REACHABLE', 'FORK_IN_BOUND_PROJECT')) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE EXCEPTION '0605: "session" and "task" were not both free in 45 tries of 2 s each. Once what holds them has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0605_task_session_fork) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
