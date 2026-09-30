ALTER TABLE "session"
  ADD COLUMN "merge_recovery" jsonb,
  ADD COLUMN "merge_recovery_action" text;
