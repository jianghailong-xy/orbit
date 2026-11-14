-- 0761 — a coordinator handoff: the outgoing coordinator writes a note, its successor opens with it.
--
-- "Start a new coordinator" (board 02, docs/coordinator-handoff.md) used to be one press: the
-- replacement in ProjectsService.coordinator(…, 'replace') completed the conversation and opened the
-- next one cold. A handoff puts a platform turn in front of it that asks the outgoing coordinator for
-- a note in four fixed sections, and only when that turn succeeds does the replacement run, with the
-- note appended to the successor's opening. A failed, timed-out or stopped note turn changes nothing.
--
-- ONE ROW PER HANDOVER
-- ====================
--   * `from_session_id` is the coordinator being handed over; `to_session_id` its successor, written
--     in the same transaction that swaps `project.coordinator_session_id` (state COMPLETED).
--   * `state`: WRITING (the note turn is queued or running), HANDING_OVER (the note is in, or was
--     skipped, and the replacement is running), FAILED (the note turn did not produce a note; nothing
--     changed), CANCELLED (the owner abandoned it), COMPLETED.
--   * `attempt` advances on Try again; the note turn's key carries it, so the end of an earlier
--     attempt's turn cannot settle a later one.
--   * One live row (WRITING, HANDING_OVER or FAILED) per outgoing coordinator, by the partial unique
--     index below: two presses of Hand over meet one row.
--
-- 0761: renumbered from 0614, then 0642, then 0721, then 0741 (2026-11-14) — main had shipped 0615–0618, 0641, 0720, 0740 and 0760, so this sits above them. Re-runnable.
-- `down.sql` beside this file reverses it.

CREATE TABLE IF NOT EXISTS "coordinator_handoff" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_session_id" UUID NOT NULL,
    "to_session_id" UUID,
    "state" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "client_turn_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failure_code" TEXT,
    "note" TEXT,
    "moved_waits" JSONB NOT NULL DEFAULT '[]',
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coordinator_handoff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coordinator_handoff_state_chk"
      CHECK ("state" IN ('WRITING', 'HANDING_OVER', 'FAILED', 'CANCELLED', 'COMPLETED')),
    CONSTRAINT "coordinator_handoff_failure_chk"
      CHECK (("state" = 'FAILED') = ("failure_code" IS NOT NULL)),
    CONSTRAINT "coordinator_handoff_successor_chk"
      CHECK (("state" = 'COMPLETED') = ("to_session_id" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "coordinator_handoff_one_live_idx"
  ON "coordinator_handoff"("from_session_id")
  WHERE "state" IN ('WRITING', 'HANDING_OVER', 'FAILED');

CREATE INDEX IF NOT EXISTS "coordinator_handoff_from_session_id_idx"
  ON "coordinator_handoff"("from_session_id", "created_at");

CREATE INDEX IF NOT EXISTS "coordinator_handoff_to_session_id_idx"
  ON "coordinator_handoff"("to_session_id");

CREATE INDEX IF NOT EXISTS "coordinator_handoff_project_id_idx"
  ON "coordinator_handoff"("project_id");

CREATE INDEX IF NOT EXISTS "coordinator_handoff_writing_idx"
  ON "coordinator_handoff"("started_at")
  WHERE "state" = 'WRITING';

DO $$ BEGIN
  ALTER TABLE "coordinator_handoff" ADD CONSTRAINT "coordinator_handoff_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "coordinator_handoff" ADD CONSTRAINT "coordinator_handoff_from_session_id_fkey"
    FOREIGN KEY ("from_session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "coordinator_handoff" ADD CONSTRAINT "coordinator_handoff_to_session_id_fkey"
    FOREIGN KEY ("to_session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
