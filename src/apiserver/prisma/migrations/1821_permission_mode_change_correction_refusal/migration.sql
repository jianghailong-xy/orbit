-- 1821 — a refused Auto correction rides on the mode change it answers, so the session detail can say so.
--
-- When Claude Code settles below the Auto it was asked for, the runner asks it for Auto, and Claude can refuse
-- (runner-go claude_mode_correction.go: a `permission_mode_correction_failed` system event carrying `mode`, `requested`
-- and the CLI's `reason`). That is no mode change: the mode recorded already is the one the engine reported. Until now
-- the refusal lived only as that event, which a long conversation pages out of what a client has loaded.
--
-- The refusal is now written onto the change it answers: the session's newest change, when it is Claude's own report
-- of the mode the engine stays in (ENGINE_REPORT or RESPAWN). A later change of the mode supersedes it by being newer;
-- the session detail carries the refusal only while its change is the newest (permissionModeCorrectionRefusal).
-- Nothing is backfilled: the clients still read the events they have loaded.

ALTER TABLE "session_permission_mode_change"
  ADD COLUMN IF NOT EXISTS "refusal_requested_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "refusal_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "refused_at" TIMESTAMP(3);

ALTER TABLE "session_permission_mode_change"
  ADD CONSTRAINT "session_permission_mode_change_refusal_chk" CHECK (
    ("refused_at" IS NULL AND "refusal_requested_mode" IS NULL AND "refusal_reason" IS NULL)
    OR (
      "cause" IN ('ENGINE_REPORT', 'RESPAWN')
      AND "refused_at" IS NOT NULL
      AND "refusal_requested_mode" IS NOT NULL
      AND "refusal_reason" IS NOT NULL
    )
  );
