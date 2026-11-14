-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Renumbered 2026-11-13 by the coordinator to 0660–0662: main had reached 0641 before this project line was promoted.
-- `orbit` in a terminal (docs/terminal-session-design.md, "The terminal credential"), task T2: a TERMINAL credential
-- answers this machine's approval cards, and SessionsService.decideApproval records the credential the decider used
-- in approval.decided_credential_kind. approval_decided_via_chk (0500, widened by 0505) allowed LOGIN, PAT,
-- IMPERSONATION, FEISHU and COORDINATOR only, so a terminal's answer failed the CHECK and was answered 500.
--
-- WHAT CHANGES
-- ------------
-- approval_decided_via_chk also allows 'TERMINAL'. Its other two clauses (a FEISHU decision names its clicker; the
-- Feishu columns are set only on a FEISHU decision) are unchanged. Which machine answered, and the activity row, are
-- T3's.
--
-- LOCKS
-- -----
-- Dropped and added NOT VALID, then validated: the scan of existing rows (every one of them passes the narrower check
-- already) runs under SHARE UPDATE EXCLUSIVE. No column, function, trigger or type changes; no row is written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0661: right after 0660 (this project line's terminal_credential); free on main and every pushed branch (others hold up to 0610).
-- Can run twice: DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "approval" DROP CONSTRAINT IF EXISTS "approval_decided_via_chk";
ALTER TABLE "approval"
  ADD CONSTRAINT "approval_decided_via_chk" CHECK (
    ("decided_credential_kind" IS NULL OR "decided_credential_kind" IN ('LOGIN', 'PAT', 'IMPERSONATION', 'FEISHU', 'COORDINATOR', 'TERMINAL'))
    AND ("decided_credential_kind" IS DISTINCT FROM 'FEISHU' OR "decided_feishu_open_id" IS NOT NULL)
    AND ("decided_credential_kind" = 'FEISHU' OR ("decided_feishu_open_id" IS NULL AND "decided_feishu_message_id" IS NULL))
  ) NOT VALID;
ALTER TABLE "approval" VALIDATE CONSTRAINT "approval_decided_via_chk";
