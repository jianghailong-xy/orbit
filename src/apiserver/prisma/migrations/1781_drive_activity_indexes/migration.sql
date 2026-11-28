-- 1781 — the indexes GET /drive/activity reads an owner's drive work by time with (drive/drive-activity.ts): an
-- owner's versions by when they were written, and a Drive chat's changes by when they were made. Trash groups
-- (drive_trash_group_owner_created_idx), syncs (drive_sync_owner_started_idx) and moves (1780's drive_move_owner_at_idx)
-- have theirs already.
--
-- A file without a DO, so `migrate deploy` sends its statements one by one, outside any transaction (0479): each index is
-- built CONCURRENTLY, without blocking writes. A build that failed half way leaves an invalid index of that name, which
-- IF NOT EXISTS would keep, so each is dropped first (under a short lock_timeout: DROP INDEX takes ACCESS EXCLUSIVE on
-- its table for a moment). Safe to run twice. No row is written, no constraint or trigger changes.

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "drive_version_owner_created_idx";
DROP INDEX IF EXISTS "drive_chat_change_owner_created_idx";

SET lock_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "drive_version_owner_created_idx" ON "drive_version" ("owner_id", "created_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "drive_chat_change_owner_created_idx" ON "drive_chat_change" ("owner_id", "created_at");

RESET lock_timeout;
