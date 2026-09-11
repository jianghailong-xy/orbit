-- Rollback for 0255. Not read by Prisma (which reads only `migration.sql`); it exists so a rollback is a
-- reviewed script rather than an improvised one. Re-runnable, in the reverse order.
--
-- WHAT ROLLING THIS BACK COSTS
-- ============================
--   * Every reset operation is deleted, active or settled, and with it the provider idempotency key each
--     one was bound to. Do not roll back while an operation is PENDING, CONSUMING or REFRESHING: a runner
--     holding its CONSUME command would report into a table that no longer exists, and the same reset
--     confirmed again afterwards would be sent to the provider under a NEW key, which the provider cannot
--     recognise as a retry.
--   * The two runner columns go too. They are rewritten by every heartbeat, so nothing is lost that the
--     next heartbeat of a rolled-forward apiserver does not write again.
--   * Like every other down.sql here, this leaves Prisma's `_prisma_migrations` row for 0255 in place.
--     Rolling forward again needs that row deleted first, or `prisma migrate deploy` skips 0255 against a
--     database that no longer has it:
--       DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0255_codex_rate_limit_reset_operation';
--     `scripts/test-codex-reset-operation.sh` rehearses exactly that sequence.

-- Dropping the table drops its indexes, constraints and trigger with it; the function is left behind
-- until it is dropped by name.
DROP TABLE IF EXISTS "codex_rate_limit_reset_operation";
DROP FUNCTION IF EXISTS "codex_rate_limit_reset_operation_guard"();

ALTER TABLE "runner" DROP COLUMN IF EXISTS "heartbeat_draining";
ALTER TABLE "runner" DROP COLUMN IF EXISTS "heartbeat_lease_owner";
