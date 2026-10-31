-- Wakeup loops: a session's "wake me every N seconds until T", held by the control plane
-- (docs/long-running-loop-contract.md §1).
--
-- A one-shot `schedule_wakeup` is renewed by the agent on every turn it wakes, so a loop that runs for days
-- breaks the first time a turn fails, the session fails or the renewal call itself times out: the relay
-- stops and nothing says so. With `recurring: true` the control plane holds the loop itself
-- (runner-api/scheduled-wakeup.ts). This table is the loop. Each tick is an ordinary
-- `session_scheduled_wakeup` row that names its loop, filed by the scheduled-wakeup worker the way a
-- one-shot wakeup is (runner-api/scheduled-wakeup.worker.ts), so everything that reads waiting wakeups
-- reads a waiting tick too.
--
-- WHAT A ROW IS
-- =============
-- One loop a session started. ACTIVE while it makes ticks: an ACTIVE loop has exactly one PENDING tick,
-- written in the transaction that settles the tick before it. ENDED for good once something ends it,
-- which `ended_reason` and `ended_at` record: REQUESTED (`stop: true`), REPLACED (a later recurring
-- request), OWNER_STOP (the owner's Stop in the composer), SESSION_ENDED (a tick found the session over)
-- or UNTIL_REACHED (its last tick). A failed turn or a FAILED session does not end it. At most one ACTIVE
-- loop per session. Deleting the session deletes its loops and their ticks.
--
--   every_seconds  the fixed rate: every tick is due a whole number of every_seconds after first_due_at,
--                  except the last, which is due at until_at.
--   first_due_at   the first tick's due time, which the ticks are numbered from.
--   until_at       when the loop ends by itself.
--   ticks_fired    ticks that became a run: filed as a turn, or onto a wake turn already queued.
--   ticks_missed   due times that did not: skipped while the worker was late, dropped (FAILED session,
--                  refused revive) or folded into a queued turn that already carried this loop's tick.
--   revive_streak  revives in a row: ticks that found the session FAILED with no retry armed and revived it
--                  through `sessions.resume`, with no tick finding it healthy in between. At 3 the loop holds
--                  and only counts its ticks missed. A tick skipped for an armed retry, a revive that was
--                  refused and a tick held at the limit leave it as it is, so an outage of any length does
--                  not spend it; a tick that finds the session healthy resets it to 0.
--   alerted_at     the failure the owner was last told about (the dead-man signal, contract §4).
--
-- `session_scheduled_wakeup.loop_id` names the loop a tick belongs to, and is NULL for a one-shot wakeup.
-- The one-waiting-wakeup key now holds one-shot wakeups only, and a second partial key holds one waiting
-- tick per loop, so a one-shot wakeup and a loop never replace each other.
--
-- NUMBERING, RE-RUNNABILITY
-- =========================
-- 0458: 0457 is first_workspace_in_conversation, and 0459 is reserved for the bg_run stall task of the same
-- project. Nothing here writes a row. Every statement is re-runnable: IF NOT EXISTS, constraints inside a
-- `duplicate_object` guard, and the narrowed key dropped IF EXISTS before it is created again.

CREATE TABLE IF NOT EXISTS "session_wakeup_loop" (
  "id"            UUID NOT NULL,
  "session_id"    UUID NOT NULL,
  "state"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "every_seconds" INTEGER NOT NULL,
  "prompt"        TEXT NOT NULL,
  "reason"        TEXT,
  "first_due_at"  TIMESTAMPTZ(3) NOT NULL,
  "until_at"      TIMESTAMPTZ(3) NOT NULL,
  "ticks_fired"   INTEGER NOT NULL DEFAULT 0,
  "ticks_missed"  INTEGER NOT NULL DEFAULT 0,
  "revive_streak" INTEGER NOT NULL DEFAULT 0,
  "ended_reason"  TEXT,
  "ended_at"      TIMESTAMPTZ(3),
  "alerted_at"    TIMESTAMPTZ(3),
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_wakeup_loop_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "session_wakeup_loop"
    ADD CONSTRAINT "session_wakeup_loop_state_check"
    CHECK ("state" IN ('ACTIVE', 'ENDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session_wakeup_loop"
    ADD CONSTRAINT "session_wakeup_loop_ended_reason_check"
    CHECK ("ended_reason" IN ('REQUESTED', 'REPLACED', 'OWNER_STOP', 'SESSION_ENDED', 'UNTIL_REACHED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An ENDED loop says why and when; an ACTIVE one says neither.
DO $$ BEGIN
  ALTER TABLE "session_wakeup_loop"
    ADD CONSTRAINT "session_wakeup_loop_ended_check"
    CHECK (("state" = 'ACTIVE' AND "ended_reason" IS NULL AND "ended_at" IS NULL)
        OR ("state" = 'ENDED' AND "ended_reason" IS NOT NULL AND "ended_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session_wakeup_loop"
    ADD CONSTRAINT "session_wakeup_loop_every_seconds_check"
    CHECK ("every_seconds" BETWEEN 60 AND 86400);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "session_wakeup_loop"
    ADD CONSTRAINT "session_wakeup_loop_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One loop runs per session: a later recurring request replaces it rather than running beside it.
CREATE UNIQUE INDEX IF NOT EXISTS "session_wakeup_loop_one_active_key"
  ON "session_wakeup_loop" ("session_id") WHERE "state" = 'ACTIVE';

-- The loop a wakeup is a tick of. NULL: a one-shot wakeup, every row written before this migration among them.
ALTER TABLE "session_scheduled_wakeup" ADD COLUMN IF NOT EXISTS "loop_id" UUID;

DO $$ BEGIN
  ALTER TABLE "session_scheduled_wakeup"
    ADD CONSTRAINT "session_scheduled_wakeup_loop_id_fkey"
    FOREIGN KEY ("loop_id") REFERENCES "session_wakeup_loop" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One one-shot wakeup waits per session, as 0264 made it; a loop's tick is not one of them. Every row
-- stored before this migration has `loop_id` NULL, so the narrowed key holds exactly what the old one did.
DROP INDEX IF EXISTS "session_scheduled_wakeup_one_pending_key";
CREATE UNIQUE INDEX IF NOT EXISTS "session_scheduled_wakeup_one_pending_key"
  ON "session_scheduled_wakeup" ("session_id") WHERE "state" = 'PENDING' AND "loop_id" IS NULL;

-- One tick waits per loop.
CREATE UNIQUE INDEX IF NOT EXISTS "session_scheduled_wakeup_loop_pending_key"
  ON "session_scheduled_wakeup" ("loop_id") WHERE "state" = 'PENDING';

-- A loop's ticks in the order they came due: the read a delivered tick makes to find the run before it.
CREATE INDEX IF NOT EXISTS "session_scheduled_wakeup_loop_due_idx"
  ON "session_scheduled_wakeup" ("loop_id", "due_at") WHERE "loop_id" IS NOT NULL;
