-- 0443 — the runner link's connection tokens: which cell serves each tenant, and which runner
-- credentials no longer vouch for a token (docs/runner-link-design.md §5.4, §6.2).
--
-- A runner trades its long-lived runner token for an hour-long connection token over HTTPS
-- (POST /api/runner/link-token, runner-api/runner-link-token.controller.ts) and presents that token
-- to its cell's link gateway, which verifies the signature with the public key alone. Two tables
-- back that exchange.
--
-- tenant_cell: the cell directory
-- ===============================
-- Which cell serves each tenant (account). Global by intent: once there are several cells this is
-- the one table every cell consults to send a runner to its tenant's cell, so it holds nothing but
-- the placement. A tenant is placed on its runners' first link-token request (INSERT … ON CONFLICT
-- DO NOTHING, so two first requests at once place it once) and stays where it was placed. There is
-- one cell today, and the CHECK says so: a second cell is a decision, made in a migration of its own
-- that widens it, beside the address the deployment configures for that cell.
--
-- runner_link_revocation: credentials that stopped vouching for tokens
-- ====================================================================
-- A connection token names, in its `credential` claim, a fingerprint of the runner credential it was
-- minted with: the first 32 hex characters of sha256('orbit-runner-link:' || runner.token_hash)
-- (`runnerLinkCredential` in runner-api/runner-link-token.ts spells the same thing). A token is good
-- only while that credential is. When the runner is deleted (`orbit unregister`, the Runners page) or
-- its credential is replaced (a rotation, a re-registration under the same name, a managed runner's
-- credential being retired or adopted), the trigger below records the old credential's fingerprint
-- here, in the transaction that made the change. The link gateway reads the fingerprints revoked
-- within a token's lifetime (GET /api/runner/link-token/revocations) and refuses — and disconnects —
-- any token that carries one.
--
-- A trigger rather than a write beside each of those changes: there are ten of them across three
-- files, and one that forgot would leave a deleted runner's tokens connecting for the rest of their
-- hour. The trigger fires only when `token_hash` is in an UPDATE's SET list, so a heartbeat's write
-- of the same row never reaches it, and records nothing when the value did not change.
--
-- A credential that becomes the runner's credential again (a managed runner adopting the bootstrap
-- credential it already had) vouches again: the same trigger deletes its fingerprint's rows, so the
-- tokens minted with it are not refused for the hour after it was revoked.
--
-- No foreign key on either id: a revocation has to outlive the runner it is about. The rows carry the
-- runner and its owner for whoever reads the table; the gateway's answer carries fingerprints only.
-- A row older than a token's lifetime can refuse nothing — every token minted with that credential
-- has expired — and the reaper's hourly purge deletes it (realtime/reaper.service.ts).
--
-- Nothing is written to an existing row: both tables are new, and the trigger records only changes
-- made after this migration.

CREATE TABLE "tenant_cell" (
    "owner_id" UUID NOT NULL,
    "cell_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_cell_pkey" PRIMARY KEY ("owner_id"),
    CONSTRAINT "tenant_cell_cell_id_chk" CHECK ("cell_id" IN ('cell-1'))
);

ALTER TABLE "tenant_cell" ADD CONSTRAINT "tenant_cell_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "runner_link_revocation" (
    "id" BIGSERIAL NOT NULL,
    "credential" TEXT NOT NULL,
    "runner_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_link_revocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "runner_link_revocation_reason_chk" CHECK ("reason" IN ('RUNNER_DELETED', 'CREDENTIAL_REPLACED'))
);

-- The gateway's read (revoked within the window) and the purge (revoked before it).
CREATE INDEX "runner_link_revocation_revoked_at_idx" ON "runner_link_revocation"("revoked_at");
-- The trigger's own delete, when a credential vouches again.
CREATE INDEX "runner_link_revocation_credential_idx" ON "runner_link_revocation"("credential");

-- `clock_timestamp()` rather than the transaction's start: the moment the credential changed, so a
-- long transaction's revocation does not start its window early.
CREATE FUNCTION "runner_link_credential_revoke"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."token_hash" IS NOT DISTINCT FROM NEW."token_hash" THEN
    RETURN NULL;
  END IF;
  INSERT INTO "runner_link_revocation" ("credential", "runner_id", "owner_id", "reason", "revoked_at")
  VALUES (
    substr(encode(sha256(convert_to('orbit-runner-link:' || OLD."token_hash", 'UTF8')), 'hex'), 1, 32),
    OLD."id",
    OLD."owner_id",
    CASE WHEN TG_OP = 'DELETE' THEN 'RUNNER_DELETED' ELSE 'CREDENTIAL_REPLACED' END,
    clock_timestamp()
  );
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM "runner_link_revocation"
     WHERE "credential" = substr(encode(sha256(convert_to('orbit-runner-link:' || NEW."token_hash", 'UTF8')), 'hex'), 1, 32);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "runner_link_credential_revoke"
  AFTER DELETE OR UPDATE OF "token_hash" ON "runner"
  FOR EACH ROW EXECUTE FUNCTION "runner_link_credential_revoke"();
