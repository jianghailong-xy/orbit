-- 1427: clear the retry arms the auto-retry sweep can never fire.
--
-- The sweep (sessions/auto-retry-eligibility.ts) requires completed_at and deleted_at NULL, so a
-- session completed or trashed with retry_at set kept that arm forever — and a due arm kept its
-- managed runner awake and un-rollable (found 2026-11-22). The code no longer writes or leaves
-- such an arm; this clears the ones already there.
UPDATE "session"
   SET "retry_at" = NULL, "retry_claimed_at" = NULL
 WHERE ("completed_at" IS NOT NULL OR "deleted_at" IS NOT NULL)
   AND ("retry_at" IS NOT NULL OR "retry_claimed_at" IS NOT NULL);
