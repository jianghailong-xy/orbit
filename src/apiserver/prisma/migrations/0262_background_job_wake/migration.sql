-- Background job wakes: what a runner-hosted job reports when it wakes its session.
--
-- A job the agent started with `bg_run` can ask to wake its session when it exits, or when it writes
-- something new (runner-go background_job.go). The runner POSTs that to
-- /runner/sessions/:id/background-wake, and the control plane files it as a turn of the session: a
-- `message` turn with a `bg-wake:` client_turn_id and empty content, queued, claimed and delivered
-- like any other (runner-api/background-job-wake.ts).
--
-- WHAT A ROW IS
-- =============
-- One job's wake, kept beside the turn that will deliver it (`session_id`, `client_turn_id`) until
-- delivery writes it into what the runner is handed. The turn's own content stays empty, so nothing
-- here is ever recorded as the person's words. A later wake of the same job, while that turn is still
-- queued, replaces the earlier one on the same row: one row per (turn, job). Deleting the session
-- deletes its wakes.
--
-- NUMBERING, RE-RUNNABILITY
-- =========================
-- 0262 is the next number above every migration on main and in every open branch and worktree
-- (0259-0261 are Watch's). Nothing here writes a row. Every statement is re-runnable: IF NOT EXISTS,
-- and the constraints added inside a `duplicate_object` guard.

CREATE TABLE IF NOT EXISTS "background_job_wake" (
  "id"             UUID NOT NULL,
  "session_id"     UUID NOT NULL,
  "client_turn_id" TEXT NOT NULL,
  "job_id"         TEXT NOT NULL,
  "trigger"        TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "command"        TEXT NOT NULL,
  "description"    TEXT,
  "status"         TEXT NOT NULL,
  "exit_code"      INTEGER,
  "reason"         TEXT,
  "output_path"    TEXT NOT NULL,
  "output_offset"  BIGINT NOT NULL,
  "output_size"    BIGINT NOT NULL,
  "output_excerpt" TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "background_job_wake_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "background_job_wake"
    ADD CONSTRAINT "background_job_wake_trigger_check" CHECK ("trigger" IN ('exit', 'output'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "background_job_wake"
    ADD CONSTRAINT "background_job_wake_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "background_job_wake_session_id_client_turn_id_job_id_key"
  ON "background_job_wake" ("session_id", "client_turn_id", "job_id");
