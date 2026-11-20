-- 1250 — what the Secrets page reads of a grant and a saved secret (project "Secrets management page",
-- design docs/design/owner-request-secrets.md §3.4).
--
-- owner_request_secret.saved_secret_id: the saved secret a grant was made from by "Use saved", so the page can count a
-- saved secret's live copies and Delete can revoke them. ON DELETE SET NULL: deleting the saved secret keeps the
-- grant's record (its copy may still be on a machine) and only forgets where it came from.
-- owner_request_secret.runner_name: the runner's name when the grant was made, so a copy left on a runner deleted
-- since (runner_id SET NULL by 0506's key) is still named.
-- account_secret.last_used_at: when "Use saved" last made a grant from it.
--
-- No value, nor anything derived from one, is added. Existing rows keep NULL in all three. No UPDATE or DELETE.
-- Every statement can run twice.

ALTER TABLE "owner_request_secret" ADD COLUMN IF NOT EXISTS "saved_secret_id" UUID;
ALTER TABLE "owner_request_secret" ADD COLUMN IF NOT EXISTS "runner_name" TEXT;
ALTER TABLE "account_secret" ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMPTZ(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_request_secret_saved_secret_id_fkey') THEN
    ALTER TABLE "owner_request_secret" ADD CONSTRAINT "owner_request_secret_saved_secret_id_fkey"
      FOREIGN KEY ("saved_secret_id") REFERENCES "account_secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- A saved secret's live copies, and the SET NULL when it is deleted, read grants by it.
CREATE INDEX IF NOT EXISTS "owner_request_secret_saved_secret_idx"
  ON "owner_request_secret" ("saved_secret_id") WHERE "saved_secret_id" IS NOT NULL;
