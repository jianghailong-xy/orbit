-- Denormalized preview of a session's most recent assistant reply, written on event
-- ingestion so the session list can show a last-reply line without scanning run_event.
-- NULL until the session's first assistant message.
ALTER TABLE "session" ADD COLUMN "last_assistant_text" TEXT;

-- One-time backfill so existing sessions show a preview immediately, not only after
-- their next reply. DISTINCT ON picks each session's highest-seq non-empty assistant
-- event, riding the (session_id, seq) index.
UPDATE "session" s
SET "last_assistant_text" = sub.text
FROM (
  SELECT DISTINCT ON (re."session_id")
         re."session_id" AS sid,
         (re."payload" ->> 'text') AS text
  FROM "run_event" re
  WHERE re."type" = 'assistant' AND (re."payload" ->> 'text') <> ''
  ORDER BY re."session_id", re."seq" DESC
) sub
WHERE s."id" = sub.sid;
