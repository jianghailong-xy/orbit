-- 0572: a guest's daily message count (docs/session-guests-design.md §6 rule 5; project 34w3R8RqLVGZuT9prKihV, task G1b).
--
-- Each guest may send 50 messages to a session per UTC day. The count lives on the guest's own session_guest row and
-- is taken by one conditional UPDATE in the transaction that writes the turn, so two requests at 49 cannot both pass:
-- the second waits on the row the first updated and then reads the 50 it committed.
--
--   turn_day       the UTC day turns_on_day counts; NULL until the guest's first message.
--   turns_on_day   messages sent on turn_day. A message withdrawn afterwards still counts: it was sent.
--
-- Two added columns, one with a constant default: catalog-only, no table rewrite. Every statement can run twice.

ALTER TABLE "session_guest" ADD COLUMN IF NOT EXISTS "turn_day" DATE;
ALTER TABLE "session_guest" ADD COLUMN IF NOT EXISTS "turns_on_day" INTEGER NOT NULL DEFAULT 0;
