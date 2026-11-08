-- 0474 — a finished session's checkout that still holds uncommitted work, made visible and
-- actionable instead of carried past every cap forever.
--
-- WHAT IT ADDS
-- ============
-- One table, `abandoned_checkout`: on a production host on 2026-11-05 there were 47 checkouts of
-- finished sessions whose `git status --porcelain` was non-empty (~4.4G), some from September.
-- `removeWorktree` refuses to remove one (its work exists on no branch), so `gcWorktrees` retried
-- it forever and nothing could act on it: not commit it, not throw it away, not even show it.
--
-- The runner now scans its checkouts and POSTs the whole set to `/runner/abandoned-checkouts`
-- (runner-go/abandoned_checkout.go); each row here is one entry of the latest report that belongs
-- to a FINISHED session. `files` and `patches` are the diff the scan computed, so the runner page
-- can show it without another round trip. The row is deleted when the work is committed or
-- discarded, and by the next report that no longer names the checkout.
--
-- WHY NOT A SESSION COLUMN
-- ========================
-- The diff (`patches`) can be hundreds of KB per checkout. The session row is read by every list
-- query in the product; a side table is the same reason `session_diff` exists.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A new table changes nothing any existing query reads. A runner too old to report leaves it
-- empty, and the UI section that lists it renders nothing. Rolling the code back leaves the table
-- in place, unread.

BEGIN;

CREATE TABLE "abandoned_checkout" (
  "id"          UUID NOT NULL,
  "owner_id"    UUID NOT NULL,
  "runner_id"   UUID NOT NULL,
  "session_id"  UUID NOT NULL,
  "files"       jsonb NOT NULL,
  "patches"     jsonb,
  "has_patches" BOOLEAN NOT NULL DEFAULT false,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "abandoned_checkout_pkey" PRIMARY KEY ("id")
);

-- One checkout per session: the report replaces a session's entry rather than adding to it.
CREATE UNIQUE INDEX "abandoned_checkout_session_id_key" ON "abandoned_checkout" ("session_id");
CREATE INDEX "abandoned_checkout_owner_id_runner_id_idx" ON "abandoned_checkout" ("owner_id", "runner_id");

ALTER TABLE "abandoned_checkout"
  ADD CONSTRAINT "abandoned_checkout_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "abandoned_checkout_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the commit relay does when it next runs for this session. NULL is the commit every
-- existing row means; 'discard' is the owner's Discard on an abandoned checkout.
ALTER TABLE "session" ADD COLUMN "commit_action" TEXT;

DO $$ BEGIN
  ALTER TABLE "session"
    ADD CONSTRAINT "session_commit_action_check"
    CHECK ("commit_action" IS NULL OR "commit_action" IN ('commit', 'discard'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
