-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.codex_account_remove_account` and the three columns beside it: the removal relay — the
-- one request that takes a Codex account slot away from a machine.
--
-- A runner can hold more than one Codex account (0296 added the sign-in relay that adds them), and
-- until now nothing could take one back: the Providers page could only say which directory to
-- delete by hand. `DELETE /runners/:id/codex-accounts/:account` names the slot, and the heartbeat
-- hands it to a runner that declares `codex-account-remove/v1` as the relay's `codexAccountRemove-
-- Request`, redelivered until the runner reports an outcome.
--
--   codex_account_remove_account  'default', or the id of a slot the runner added. Never removed:
--                                 a request naming `default` is refused before it is stored.
--   codex_account_remove_status   'pending' until the runner reports; then 'done' or 'failed'.
--   codex_account_remove_message  the runner's own words when it failed — the reason it gives is
--                                 the only thing that can explain a machine's refusal.
--   codex_account_remove_at       when the request was made: the identity a report answers (like
--                                 `login_at`), and what an abandoned request is swept by.
--
-- NULLABLE, and NULL is the old behaviour rather than a gap: a row written before this migration
-- has no removal in flight, which is what NULL means here.
--
-- ADD COLUMN only: no default, no NOT NULL, so the ALTER is catalog-only and no stored row is
-- rewritten.

ALTER TABLE "runner" ADD COLUMN "codex_account_remove_account" TEXT;
ALTER TABLE "runner" ADD COLUMN "codex_account_remove_status" TEXT;
ALTER TABLE "runner" ADD COLUMN "codex_account_remove_message" TEXT;
ALTER TABLE "runner" ADD COLUMN "codex_account_remove_at" TIMESTAMP(3);
