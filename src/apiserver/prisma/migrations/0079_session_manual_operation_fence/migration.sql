ALTER TABLE "session"
  ADD COLUMN "merge_operation_id" UUID,
  ADD COLUMN "merge_operation_owner" UUID,
  ADD COLUMN "commit_operation_id" UUID,
  ADD COLUMN "commit_operation_owner" UUID;

-- Deliberately do not backfill pending rows. An old runner may already be
-- executing such a command without an operation UUID. Its legacy result may
-- settle only a still-NULL attempt; every newly queued attempt is UUID-fenced.
