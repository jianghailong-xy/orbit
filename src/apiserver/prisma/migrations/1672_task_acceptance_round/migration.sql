-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1672: one record per EXECUTABLE acceptance round (project 'Task run sidebar', criterion "every EXECUTABLE
-- acceptance round is recorded"; docs/task-run-sidebar-design.md, "Data that does not exist yet"). Until now a round
-- left only its reserved shell turn (client_turn_id 'system:task-acceptance:v1:<turn>:<expected>') and, when it
-- disagreed, the session's error sentence 'acceptance command exited N; expected M'. The runner's /turn-complete
-- carries the exit code and the shell's output, and the output was dropped. The task's run column lists a run's rounds
-- with their exit code, the tree they ran on, when they finished and what they printed.
--
-- WHAT IT ADDS
-- ------------
-- task_acceptance_round   one row per acceptance shell turn, keyed by the turn: the task and session it belongs to,
--                         exit_code (null when the runner reported none), expected_exit_code (the code the turn was
--                         queued to expect, from its client_turn_id), branch_sha (the one reported with the completion,
--                         null when none or not a SHA), finished_at, and output_tail: the last 16 KB of the output,
--                         redacted as an integration check's outputTail is (runner-api/check-output-redaction.ts).
-- Written by POST /runner/sessions/:id/turn-complete, in the transaction of the first ACK and outside the exit-code
-- comparison, which stays one status write and no other database touch (executable-exit-code-judgment.spec.ts, by the
-- owner's direction). The row is a record of what ran; no state is derived from it. Nothing is backfilled: earlier
-- rounds kept no output to backfill from.
--
-- WHY A TABLE AND NOT COLUMNS ON conversation_turn
-- ------------------------------------------------
-- conversation_turn is every session's whole execution queue: every message, steer, withdraw, wakeup and shell turn is a
-- row of it, it is claimed and re-leased on every delivery, and its partial indexes and triggers read it on every
-- poll. An acceptance round is a few of those rows, and its 16 KB tail would widen the queue's rows (and its TOAST
-- reads) for a fact no queue reader asks for. Four columns that are null on every other kind would also say nothing
-- about which turns they belong to. A table of its own is written by one insert per round, keyed by the turn so a
-- retried completion cannot write a second row, read by task (the task detail), and cascades away with the turn
-- (which cascades with its session) and with the task.
--
-- GUARDS
-- ------
-- The (session_id, turn_id) foreign key references conversation_turn (session_id, id), so a round can only name a turn
-- of its own session. No trigger reads or writes the new table, and nothing in it decides any state.
--
-- LOCKS
-- -----
-- CREATE TABLE takes a SHARE ROW EXCLUSIVE lock on task and on conversation_turn for the foreign keys only, asked for
-- 2 s at a time, 1 s apart, up to 60 tries, in one DO statement, as 1070, 1080 and 1600 ask for theirs. No INSERT,
-- UPDATE or DELETE. At run time the insert's foreign-key checks take KEY SHARE on a task row the completion already
-- holds FOR UPDATE and on the turn row it has just updated, so they add no wait edge.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1672: production's _prisma_migrations stands at 1667 (read 2026-11-26), main at 1667, and other branches already
-- use 1668 and 1671. Can run twice: CREATE TABLE / INDEX IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      CREATE TABLE IF NOT EXISTS "task_acceptance_round" (
        "id"                 UUID           NOT NULL,
        "owner_id"           UUID           NOT NULL,
        "task_id"            UUID           NOT NULL,
        "session_id"         UUID           NOT NULL,
        "turn_id"            UUID           NOT NULL,
        "exit_code"          INTEGER,
        "expected_exit_code" INTEGER        NOT NULL,
        "branch_sha"         TEXT,
        "finished_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "output_tail"        TEXT           NOT NULL,
        CONSTRAINT "task_acceptance_round_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "task_acceptance_round_task_fkey" FOREIGN KEY ("task_id")
          REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "task_acceptance_round_turn_fkey" FOREIGN KEY ("session_id", "turn_id")
          REFERENCES "conversation_turn"("session_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "task_acceptance_round_turn_id_key" ON "task_acceptance_round"("turn_id");

CREATE INDEX IF NOT EXISTS "task_acceptance_round_task_id_finished_at_idx"
  ON "task_acceptance_round"("task_id", "finished_at" DESC);
