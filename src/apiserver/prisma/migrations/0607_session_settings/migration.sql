-- 0607: a session's own Settings (docs/mocks/session-settings): its env vars laid over the workspace's,
-- when they last changed and when an engine last started with them, and per-session notification
-- overrides plus a mute. Nullable or defaulted columns and their CHECKs only: every existing row reads
-- "no session env, follow the account, not muted", and no trigger, fence or preserved function is touched.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "env" jsonb;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "env_changed_at" timestamp(3);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "env_applied_at" timestamp(3);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "notify_turn_finished" text;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "notify_needs_you" text;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "notifications_muted" boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_notify_turn_finished_chk') THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_notify_turn_finished_chk"
      CHECK ("notify_turn_finished" IS NULL OR "notify_turn_finished" IN ('on', 'off'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_notify_needs_you_chk') THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_notify_needs_you_chk"
      CHECK ("notify_needs_you" IS NULL OR "notify_needs_you" IN ('on', 'off'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_env_object_chk') THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_env_object_chk"
      CHECK ("env" IS NULL OR jsonb_typeof("env") = 'object');
  END IF;
END $$;
