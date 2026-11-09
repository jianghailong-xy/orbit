-- Owner-confirmation-review contract R4: platform run questions and notices share request outcomes.
--
-- LOCKS
-- -----
-- Each ALTER that adds columns or adds/replaces CHECKs takes ACCESS EXCLUSIVE briefly for catalogue
-- changes. On PostgreSQL >= 11, kind's constant DEFAULT 'MESSAGE' does not rewrite the table;
-- the nullable columns have no default and do not rewrite it either. All CHECKs are added NOT VALID,
-- so none of these ALTERs scans existing rows. Each replacement drops and re-adds its CHECK in ONE
-- statement: there is no committed window without enforcement for new/changed rows.
-- Each separate VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, allowing ordinary reads
-- and writes. There is no enclosing transaction retaining ACCESS EXCLUSIVE during validation.
-- CREATE UNIQUE INDEX takes SHARE on session_request and scans it; it runs separately, without
-- retaining the column ALTER's ACCESS EXCLUSIVE lock. No other tables are locked by these statements.
ALTER TABLE "session_request"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'MESSAGE',
  ADD COLUMN "approval_id" uuid,
  ADD COLUMN "escalated_item_id" uuid,
  ADD COLUMN "owner_alerted_at" timestamptz(3),
  ADD CONSTRAINT "session_request_kind_chk" CHECK ("kind" IN ('MESSAGE', 'RUN_QUESTION', 'RUN_NOTIFY')) NOT VALID;
ALTER TABLE "session_request" VALIDATE CONSTRAINT "session_request_kind_chk";
CREATE UNIQUE INDEX "session_request_approval_key" ON "session_request"("approval_id") WHERE "approval_id" IS NOT NULL;
ALTER TABLE "session_request"
  DROP CONSTRAINT "session_request_state_chk",
  ADD CONSTRAINT "session_request_state_chk" CHECK (
  "state" IN ('OPEN', 'REPLIED', 'NO_REPLY', 'RECIPIENT_ENDED', 'EXPIRED', 'UNDELIVERED')
  OR ("kind" = 'RUN_QUESTION' AND "state" = 'OWNER_ANSWERED')
  OR ("kind" = 'RUN_NOTIFY' AND "state" = 'READ')
) NOT VALID;
ALTER TABLE "session_request" VALIDATE CONSTRAINT "session_request_state_chk";
ALTER TABLE "approval"
  ADD COLUMN "coordinator_fallback" text,
  DROP CONSTRAINT "approval_decided_via_chk",
  ADD CONSTRAINT "approval_decided_via_chk" CHECK (
  ("decided_credential_kind" IS NULL OR "decided_credential_kind" IN ('LOGIN', 'PAT', 'IMPERSONATION', 'FEISHU', 'COORDINATOR'))
  AND ("decided_credential_kind" IS DISTINCT FROM 'FEISHU' OR "decided_feishu_open_id" IS NOT NULL)
  AND ("decided_credential_kind" = 'FEISHU' OR ("decided_feishu_open_id" IS NULL AND "decided_feishu_message_id" IS NULL))
) NOT VALID;
ALTER TABLE "approval" VALIDATE CONSTRAINT "approval_decided_via_chk";
