-- Codex earned rate-limit reset, contract v2 (docs/codex-rate-limit-reset-contract.md §12.4): the account
-- slot an operation resets in. `default` is Default; an added account is its runner slot's 8-hex id. The
-- runner reads, consumes and refreshes in that slot's CODEX_HOME, so the slot is as immutable as the
-- fingerprint beside it (I3): the guard trigger below refuses a change to it.
--
-- Every row written before this column existed is Default's, which is what the DEFAULT says, and an
-- apiserver that predates it (a rolling deploy) still writes Default's operations only. A constant default
-- is a catalog-only change in PostgreSQL 11+: nothing is rewritten.
--
-- THE IN-FLIGHT INDEX STAYS AS IT IS
-- ==================================
-- I1 is still one active operation per (runner_id, account_fingerprint), not per slot: one ChatGPT account
-- signed in to two slots has one set of credits, so it gets one operation in flight (§12.4). 0255's partial
-- unique index already says exactly that.
--
-- NUMBERING, RE-RUNNABILITY
-- =========================
-- 1668 is above every migration on main, project/* and the pushed orbit/* branches (2026-11-26). Re-runnable:
-- IF NOT EXISTS, the constraint inside a `duplicate_object` guard, the function replaced in place.

ALTER TABLE "codex_rate_limit_reset_operation" ADD COLUMN IF NOT EXISTS "account_slot" TEXT NOT NULL DEFAULT 'default';

DO $$ BEGIN
  ALTER TABLE "codex_rate_limit_reset_operation"
    ADD CONSTRAINT "codex_rate_limit_reset_operation_account_slot_check"
      CHECK ("account_slot" = 'default' OR "account_slot" ~ '^[0-9a-f]{8}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 0255's guard, with account_slot among the immutable columns. Everything else is unchanged.
CREATE OR REPLACE FUNCTION "codex_rate_limit_reset_operation_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR NEW."runner_id" IS DISTINCT FROM OLD."runner_id"
     OR NEW."account_fingerprint" IS DISTINCT FROM OLD."account_fingerprint"
     OR NEW."account_slot" IS DISTINCT FROM OLD."account_slot"
     OR NEW."client_request_id" IS DISTINCT FROM OLD."client_request_id"
     OR NEW."provider_idempotency_key" IS DISTINCT FROM OLD."provider_idempotency_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: id, owner_id, runner_id, account_fingerprint, account_slot, client_request_id, provider_idempotency_key and created_at are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD."consume_state" IN ('PENDING', 'CLAIMED')
          OR (OLD."consume_state" = 'CONFIRMED' AND OLD."refresh_state" = 'PENDING'))
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: a settled operation never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."consume_state" <> OLD."consume_state" AND NOT (
       (OLD."consume_state" = 'PENDING' AND NEW."consume_state" IN ('CLAIMED', 'NOT_ATTEMPTED'))
    OR (OLD."consume_state" = 'CLAIMED' AND NEW."consume_state" IN ('CONFIRMED', 'NOT_ATTEMPTED', 'UNRESOLVED'))
  ) THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: consume_state may not move from % to %',
      OLD."id", OLD."consume_state", NEW."consume_state"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."refresh_state" <> OLD."refresh_state" AND NOT (
       (OLD."refresh_state" = 'NONE' AND NEW."refresh_state" IN ('PENDING', 'NOT_REQUIRED'))
    OR (OLD."refresh_state" = 'PENDING' AND NEW."refresh_state" IN ('SUCCEEDED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: refresh_state may not move from % to %',
      OLD."id", OLD."refresh_state", NEW."refresh_state"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."consume_outcome" IS NOT NULL AND NEW."consume_outcome" IS DISTINCT FROM OLD."consume_outcome" THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: consume_outcome is immutable once recorded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."consume_confirmed_at" IS NOT NULL
     AND NEW."consume_confirmed_at" IS DISTINCT FROM OLD."consume_confirmed_at" THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: consume_confirmed_at is immutable once recorded', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."claim_generation" < OLD."claim_generation" THEN
    RAISE EXCEPTION 'codex rate-limit reset operation %: claim_generation never decreases', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
