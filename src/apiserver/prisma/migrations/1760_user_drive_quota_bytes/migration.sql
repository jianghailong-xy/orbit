-- 1760 — user.drive_quota_bytes: one account's own storage quota, set by the operator in SQL
-- (files/files.service.ts quotaFor, docs/self-hosting.md "File retention and quota").
--
-- ORBIT_DRIVE_QUOTA_BYTES set one limit for every account (production: 50 GiB) and nothing let one account have
-- another. NULL, every row's value after this migration: the account has the deployment's quota, or none when the
-- deployment sets none. A positive number: that account's quota in bytes, in place of the deployment's, whether or not
-- the deployment sets one. Read on each upload and each usage read, so a change takes effect at once, no restart.
--
--   UPDATE "user" SET drive_quota_bytes = 107374182400 WHERE email = 'someone@example.com';  -- 100 GiB
--   UPDATE "user" SET drive_quota_bytes = NULL WHERE email = 'someone@example.com';          -- back to the default
--
-- Nullable, no default: catalog-only, no row is rewritten. The CHECK refuses zero and negatives, which would read as no
-- quota to a reader that tests truthiness. Can run twice.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "drive_quota_bytes" BIGINT;
DO $$ BEGIN
  ALTER TABLE "user" ADD CONSTRAINT "user_drive_quota_bytes_positive" CHECK ("drive_quota_bytes" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
