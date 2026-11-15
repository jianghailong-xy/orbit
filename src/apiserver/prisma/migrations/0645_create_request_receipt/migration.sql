-- The receipt of one project_create or session_create request (docs/recovery-contract.md §6).
--
--   * `create_request_receipt` — one row per (owner, action kind, request id): what the request was
--     (a fingerprint of its payload and the session that sent it), where it stands (OPEN while a
--     delivery is creating, COMPLETED with the answer kept, UNKNOWN when that delivery failed in a way
--     that may have written), and the answer a repeat reads back. Deleting the owner deletes them.
--
-- A request with no X-Orbit-Request-Id writes no row and behaves as it always did.
--
-- Nothing existing is altered; no row is written at apply time.

-- CreateTable
CREATE TABLE "create_request_receipt" (
    "owner_id" UUID NOT NULL,
    "action_kind" TEXT NOT NULL,
    "request_token" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "result" JSONB,
    "lease_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "create_request_receipt_pkey" PRIMARY KEY ("owner_id", "action_kind", "request_token"),
    CONSTRAINT "create_request_receipt_status_check" CHECK ("status" IN ('OPEN', 'COMPLETED', 'UNKNOWN'))
);

-- AddForeignKey
ALTER TABLE "create_request_receipt" ADD CONSTRAINT "create_request_receipt_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
