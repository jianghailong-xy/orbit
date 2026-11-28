-- 1805 — the mode a session is actually running in, and every change of it.
--
-- `session.permission_mode` is the owner's intent: only an explicit pick writes it, never a normalization
-- (owner ruling, project 350NMcNDulzkqRAFFUsXZ). What the session's engine really runs in is a separate fact,
-- read from the engine where it says (Claude Code's init frame, a set_permission_mode acknowledgement) and
-- otherwise the mode the runner was handed. The mode ceiling rules compare it (owner ruling R3).
--
-- Both session columns are NULL until the session is next claimed; nothing is backfilled, since no record says
-- what an engine already running was in.

ALTER TABLE "session"
  ADD COLUMN IF NOT EXISTS "actual_permission_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "actual_permission_mode_at" TIMESTAMP(3);

-- One row per change of session.actual_permission_mode, naming what caused it. Append-only; goes with its session.
CREATE TABLE IF NOT EXISTS "session_permission_mode_change" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "from_mode" TEXT,
  "to_mode" TEXT NOT NULL,
  "cause" TEXT NOT NULL,
  "client" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_permission_mode_change_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "session_permission_mode_change_session_id_fkey" FOREIGN KEY ("session_id")
    REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "session_permission_mode_change_cause_chk" CHECK (
    "cause" IN ('CLAIM', 'OWNER_PICK', 'ENGINE_REPORT', 'RUNNER_CORRECTION', 'RESPAWN', 'ORBIT_CHANGE')
  )
);

CREATE INDEX IF NOT EXISTS "session_permission_mode_change_session_id_created_at_idx"
  ON "session_permission_mode_change" ("session_id", "created_at");
