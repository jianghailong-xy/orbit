-- Owner-confirmation-review contract R4: platform run questions and notices share request outcomes.
BEGIN;
ALTER TABLE "session_request"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'MESSAGE',
  ADD COLUMN "approval_id" uuid,
  ADD COLUMN "escalated_item_id" uuid,
  ADD COLUMN "owner_alerted_at" timestamptz(3),
  ADD CONSTRAINT "session_request_kind_chk" CHECK ("kind" IN ('MESSAGE', 'RUN_QUESTION', 'RUN_NOTIFY'));
CREATE UNIQUE INDEX "session_request_approval_key" ON "session_request"("approval_id") WHERE "approval_id" IS NOT NULL;
ALTER TABLE "session_request" DROP CONSTRAINT "session_request_state_chk";
ALTER TABLE "session_request" ADD CONSTRAINT "session_request_state_chk" CHECK (
  "state" IN ('OPEN', 'REPLIED', 'NO_REPLY', 'RECIPIENT_ENDED', 'EXPIRED', 'UNDELIVERED')
  OR ("kind" = 'RUN_QUESTION' AND "state" = 'OWNER_ANSWERED')
  OR ("kind" = 'RUN_NOTIFY' AND "state" = 'READ')
);
ALTER TABLE "approval" ADD COLUMN "coordinator_fallback" text;
ALTER TABLE "approval" DROP CONSTRAINT "approval_decided_via_chk";
ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_via_chk" CHECK (
  ("decided_credential_kind" IS NULL OR "decided_credential_kind" IN ('LOGIN', 'PAT', 'IMPERSONATION', 'FEISHU', 'COORDINATOR'))
  AND ("decided_credential_kind" IS DISTINCT FROM 'FEISHU' OR "decided_feishu_open_id" IS NOT NULL)
  AND ("decided_credential_kind" = 'FEISHU' OR ("decided_feishu_open_id" IS NULL AND "decided_feishu_message_id" IS NULL))
);
COMMIT;
