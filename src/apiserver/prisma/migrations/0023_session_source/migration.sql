-- Provenance flag: "user" = created by a person via the UI, "system" = auto-created
-- by Orbit (e.g. an @-mention comment reply). System sessions are listed under a
-- dedicated "System" tab instead of the Active list.
ALTER TABLE "session" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';

-- Backfill: existing comment-reply sessions were the only auto-created kind. They
-- are recognisable by the title prefix triggerMentionedAgent stamps on them.
UPDATE "session" SET "source" = 'system' WHERE "title" LIKE '回应评论：%';
