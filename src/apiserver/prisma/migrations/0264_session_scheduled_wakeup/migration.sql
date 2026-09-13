-- Scheduled wakeups: a session's own "wake me in N seconds", held by the control plane.
--
-- Claude Code's ScheduleWakeup keeps its timer inside the engine process. Orbit recycles engines (idle
-- TTL, LRU) and restarts runners, a resumed engine never re-arms the timer, and it does not fire while
-- the engine still has a Monitor or background shell running. So the agent asks for the wakeup here
-- instead (runner-go `schedule_wakeup` -> POST /runner/sessions/:id/scheduled-wakeup), the apiserver
-- keeps it, and when it is due the scheduled-wakeup worker files it as a turn of the session through the
-- same `bg-wake:` turn a background job's wake uses (runner-api/scheduled-wakeup.worker.ts): no runner
-- process has to be alive when it comes due.
--
-- WHAT A ROW IS
-- =============
-- One wakeup a session asked for. PENDING until it is due; then DELIVERED (filed onto the wake turn named
-- by `client_turn_id`) or DROPPED (the session had ended). A later request of the same session replaces
-- a PENDING one (SUPERSEDED), and a stop cancels it (CANCELLED). At most one PENDING row per session.
-- Deleting the session deletes its wakeups.
--
-- NUMBERING, RE-RUNNABILITY
-- =========================
-- 0264: 0262 is background_job_wake, and 0263 is taken by an open Watch branch. Nothing here writes a
-- row. Every statement is re-runnable: IF NOT EXISTS, and the constraints added inside a
-- `duplicate_object` guard.

CREATE TABLE IF NOT EXISTS "session_scheduled_wakeup" (
  "id"             UUID NOT NULL,
  "session_id"     UUID NOT NULL,
  "state"          TEXT NOT NULL DEFAULT 'PENDING',
  "delay_seconds"  INTEGER NOT NULL,
  "reason"         TEXT NOT NULL,
  "prompt"         TEXT,
  "due_at"         TIMESTAMPTZ(3) NOT NULL,
  "client_turn_id" TEXT,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at"     TIMESTAMPTZ(3),
  CONSTRAINT "session_scheduled_wakeup_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "session_scheduled_wakeup"
    ADD CONSTRAINT "session_scheduled_wakeup_state_check"
    CHECK ("state" IN ('PENDING', 'DELIVERED', 'DROPPED', 'SUPERSEDED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session_scheduled_wakeup"
    ADD CONSTRAINT "session_scheduled_wakeup_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One wakeup waits per session: a second request replaces the first rather than adding to it.
CREATE UNIQUE INDEX IF NOT EXISTS "session_scheduled_wakeup_one_pending_key"
  ON "session_scheduled_wakeup" ("session_id") WHERE "state" = 'PENDING';

-- The worker's read: what is waiting and due, the longest-due first.
CREATE INDEX IF NOT EXISTS "session_scheduled_wakeup_due_idx"
  ON "session_scheduled_wakeup" ("due_at") WHERE "state" = 'PENDING';
