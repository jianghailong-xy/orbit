-- A turn killed by the account's provider quota carries no information about the work: the
-- same message succeeds once the window rolls over. These two columns let the control plane
-- hold the message and re-send it then, instead of leaving the session parked with a reset
-- time that exists only inside the runtime's own sentence ("You've hit your session limit ·
-- resets 6:20pm (Europe/Berlin)").
--
-- Both are nullable/defaulted, so an older replica writing this table is unaffected: it
-- simply never arms a retry, and the sweeper in a newer replica finds nothing to do.
ALTER TABLE "session"
    ADD COLUMN "quota_retry_at" TIMESTAMP(3),
    ADD COLUMN "quota_retry_attempts" INTEGER NOT NULL DEFAULT 0;

-- The sweeper's only query is "armed and due", so the index carries just the armed rows —
-- a handful next to the whole table, and NULL entries would be the overwhelming majority.
CREATE INDEX "session_quota_retry_at_idx" ON "session" ("quota_retry_at")
    WHERE "quota_retry_at" IS NOT NULL;
