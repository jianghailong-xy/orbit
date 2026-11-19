-- Which client sent a turn (sessions/turn-sender-client.ts): what `orbit` in a terminal draws "· from iPhone"
-- Renumbered 2026-11-13 by the coordinator to 0660–0662: main had reached 0641 before this project line was promoted.
-- with beside a message it did not send. Both nullable and without a default, so adding them rewrites nothing.
-- 0662: main's highest is 0613; 0615–0661 are held by branches in flight (2026-11-13). Either statement can run twice.
ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "sender_client" TEXT;
ALTER TABLE "conversation_turn" ADD COLUMN IF NOT EXISTS "sender_client_detail" TEXT;
