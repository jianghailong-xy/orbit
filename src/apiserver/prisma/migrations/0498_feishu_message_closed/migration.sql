-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F1-5): a card closed as its outcome.
-- docs/feishu-bot-design.md section 6.2 is the authority.
--
-- WHAT CHANGES
-- ------------
-- feishu_message.status gains CLOSED: the card was drawn in place as its outcome (`Allowed in Orbit · 10:32 UTC`,
-- no buttons) once its matter was settled elsewhere, and nothing draws it again (push/feishu-transport.ts
-- closeSettled). The CHECK feishu_message_status_chk is dropped and made again with the four values; no row is
-- written, and every row it held already passes the new one.
--
-- LOCKS
-- -----
-- ALTER TABLE takes feishu_message's ACCESS EXCLUSIVE lock for the moment the constraint is replaced, and the
-- re-made CHECK scans the table once under it (the table holds the cards of the last weeks: small). No other table
-- is named. No function, trigger or type is created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0498: the project line stood at 0495, 0496 is F3-1's (in flight), 0497 is held for project 34tXXUHZEcGeWeB0hp5YU,
-- and this project's next migrations start at 0498 (project instruction 6). Can run twice: DROP CONSTRAINT IF EXISTS,
-- then ADD.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "feishu_message" DROP CONSTRAINT IF EXISTS "feishu_message_status_chk";
ALTER TABLE "feishu_message"
  ADD CONSTRAINT "feishu_message_status_chk" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'CLOSED'));
