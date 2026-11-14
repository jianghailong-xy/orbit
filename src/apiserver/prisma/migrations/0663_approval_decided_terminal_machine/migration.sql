-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `orbit` in a terminal (docs/terminal-session-design.md, "The terminal credential"), task T3: an approval answered
-- with a TERMINAL credential is recorded with credential_kind = TERMINAL and the machine name, on the decision and on
-- its activity row, the way a Feishu card's answer is recorded as FEISHU (0499, 0500). 0661 let the decision say
-- TERMINAL; it had nowhere to say which machine, and activity_credential_chk refused a TERMINAL activity row.
--
-- WHAT CHANGES
-- ------------
--   approval.decided_terminal_machine_name   new, nullable: the machine name of the TERMINAL credential that decided
--                    the card (terminal_credential.machine_name, copied: the record outlives a revoked or expired
--                    credential, as activity.credential_id outlives a token).
--   approval_decided_via_chk   one clause more: the machine name is set on a TERMINAL decision, and only on one. The
--                    other clauses are 0661's, unchanged.
--   activity_credential_chk    credential_kind may also be TERMINAL: the `terminal.approval.decided` row. Like LOGIN and
--                    FEISHU it carries no credential_id (that stays the PAT's); the payload names the terminal.
--
-- LOCKS
-- -----
-- ADD COLUMN with no default is a catalog change. The CHECKs are dropped and added NOT VALID, then validated: the scan
-- of existing rows (every one passes: no row has the new column set, and no activity row says TERMINAL) runs under
-- SHARE UPDATE EXCLUSIVE. No function, trigger or type changes; no row is written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0663: above every migration on main and on every pushed branch (this project line holds up to 0662, main up to 0641).
-- Can run twice: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "approval" ADD COLUMN IF NOT EXISTS "decided_terminal_machine_name" TEXT;

ALTER TABLE "approval" DROP CONSTRAINT IF EXISTS "approval_decided_via_chk";
ALTER TABLE "approval"
  ADD CONSTRAINT "approval_decided_via_chk" CHECK (
    ("decided_credential_kind" IS NULL OR "decided_credential_kind" IN ('LOGIN', 'PAT', 'IMPERSONATION', 'FEISHU', 'COORDINATOR', 'TERMINAL'))
    AND ("decided_credential_kind" IS DISTINCT FROM 'FEISHU' OR "decided_feishu_open_id" IS NOT NULL)
    AND ("decided_credential_kind" = 'FEISHU' OR ("decided_feishu_open_id" IS NULL AND "decided_feishu_message_id" IS NULL))
    AND (("decided_credential_kind" IS NOT DISTINCT FROM 'TERMINAL') = ("decided_terminal_machine_name" IS NOT NULL))
  ) NOT VALID;
ALTER TABLE "approval" VALIDATE CONSTRAINT "approval_decided_via_chk";

ALTER TABLE "activity" DROP CONSTRAINT IF EXISTS "activity_credential_chk";
ALTER TABLE "activity"
  ADD CONSTRAINT "activity_credential_chk"
  CHECK (("credential_kind" IS NULL OR "credential_kind" IN ('LOGIN', 'PAT', 'FEISHU', 'GUEST', 'TERMINAL'))
     AND (("credential_kind" IS NOT DISTINCT FROM 'PAT') = ("credential_id" IS NOT NULL)))
  NOT VALID;
ALTER TABLE "activity" VALIDATE CONSTRAINT "activity_credential_chk";
