BEGIN;

-- A long-lived credential for a headless process (launchd/cron) on one machine, minted by
-- `orbit token mint`. The token itself is a signed JWT whose `jti` is this row's id, so no
-- secret is stored here: this table is the revocation list, the scope record, and the audit
-- trail (last_used_at tells the owner whether a token is still in use before revoking it).
CREATE TABLE "service_token" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "agent_id" UUID,
    "label" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_token_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_token_runner_id_idx" ON "service_token"("runner_id");
CREATE INDEX "service_token_owner_id_idx" ON "service_token"("owner_id");

ALTER TABLE "service_token" ADD CONSTRAINT "service_token_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_token" ADD CONSTRAINT "service_token_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_token" ADD CONSTRAINT "service_token_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
