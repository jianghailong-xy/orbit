-- 1790 — drive_sync.handled_at, fix_session_id, fix_requested_at: a failed Drive sync is kept until it is handled
-- (drive/drive-syncs.service.ts).
--
-- Ended syncs were deleted, and dropped from the owner's list, 24 h after they ended, failures included. The Drive
-- page now keeps a sync that ended with failures (failed_count > 0 or status FAILED) under "Needs you" until someone
-- deals with it, so such a row outlives that window while handled_at is null. handled_at is set by the owner's Clear
-- (POST /drive/syncs/:id/handled) or by a later clean sync of the same source and destination. fix_session_id and
-- fix_requested_at record a hand-off of the failures to a session: the session is history read by id, not a key, like
-- session_id.
--
-- Nullable, no default: catalog only, no row is rewritten, no trigger, no index (the list reads by owner, as before).
--
-- 1790: the highest number on main was 1750 (1750_runner_presence_last_heard_at), and 1781 on the project branch
-- (1781_drive_activity_indexes) and in any worktree, when this
-- was written. Can run twice.

ALTER TABLE "drive_sync" ADD COLUMN IF NOT EXISTS "handled_at" TIMESTAMPTZ(3);
ALTER TABLE "drive_sync" ADD COLUMN IF NOT EXISTS "fix_session_id" UUID;
ALTER TABLE "drive_sync" ADD COLUMN IF NOT EXISTS "fix_requested_at" TIMESTAMPTZ(3);
