-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F2-1): which door an approval's decision came in by.
-- docs/feishu-bot-design.md sections 7.2 and 7.4 are the authority.
--
-- WHAT CHANGES
-- ------------
-- approval gains three nullable columns beside decided_by_id, written once by the decision that lands
-- (SessionsService.decideApproval):
--
--   decided_credential_kind    the credential the decider used: LOGIN, PAT, IMPERSONATION, or FEISHU for a click on a
--                              Feishu card (docs/feishu-bot-design.md section 7.2). NULL on a row nobody decided, on a
--                              row a standing grant allowed, and on every row decided before this migration.
--   decided_feishu_open_id     the clicker's open_id, when decided_credential_kind is FEISHU, and only then.
--   decided_feishu_message_id  the card's message_id, when decided_credential_kind is FEISHU, and only then.
--
-- approval_decided_via_chk holds the shape: the kind is one of the four or NULL; a FEISHU decision names its clicker;
-- the two Feishu columns are set only on a FEISHU decision. Added NOT VALID and then validated, so the scan of the
-- existing rows (all NULL in the new columns, so all pass) runs under SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE.
--
-- LOCKS
-- -----
-- ADD COLUMN without a default is a catalogue change: approval's ACCESS EXCLUSIVE lock for a moment, no rewrite. No
-- other table is named. No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0500: the project line stands at 0499 (F2-3, feishu_thread); 0496 is F3-1's, 0497 is held for project
-- 34tXXUHZEcGeWeB0hp5YU (project instruction 6). Can run twice: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "approval"
  ADD COLUMN IF NOT EXISTS "decided_credential_kind" TEXT,
  ADD COLUMN IF NOT EXISTS "decided_feishu_open_id" TEXT,
  ADD COLUMN IF NOT EXISTS "decided_feishu_message_id" TEXT;

ALTER TABLE "approval" DROP CONSTRAINT IF EXISTS "approval_decided_via_chk";
ALTER TABLE "approval"
  ADD CONSTRAINT "approval_decided_via_chk" CHECK (
    ("decided_credential_kind" IS NULL OR "decided_credential_kind" IN ('LOGIN', 'PAT', 'IMPERSONATION', 'FEISHU'))
    AND ("decided_credential_kind" IS DISTINCT FROM 'FEISHU' OR "decided_feishu_open_id" IS NOT NULL)
    AND ("decided_credential_kind" = 'FEISHU' OR ("decided_feishu_open_id" IS NULL AND "decided_feishu_message_id" IS NULL))
  ) NOT VALID;
ALTER TABLE "approval" VALIDATE CONSTRAINT "approval_decided_via_chk";
