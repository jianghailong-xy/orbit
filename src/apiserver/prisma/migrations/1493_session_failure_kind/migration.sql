-- 1493 — a failed run's failure kind as its runner's engine adapter classified it
-- (docs/routing-account-health-design.md §5.1, §10 Migration).
--
-- session.failure_kind       the RunFailureKind the runner sent (USAGE_LIMIT, CAPACITY, ACCOUNT_ACTION_REQUIRED,
--                            CREDENTIAL_REFUSED, ACCESS_DENIED, TRANSPORT, REQUEST_REFUSED); NULL when the runner
--                            classified nothing or is older than the field, which is then read through the legacy
--                            text markers (runFailureKind in @orbit/shared).
-- session.failure_scope      account | model | runner | request; NULL is account.
-- session.failure_said       the provider's own words, at most 300 characters.
-- session.admission_failure  the failed run ended before its engine produced any reply, tool call or billed token;
--                            NULL when the runner did not say.
--
-- Written with `error`, in the same statement, by runner turn-complete and finalize; cleared with it when a failed
-- session is revived. No CHECK on the kind: the server writes only kinds it knows, and a newer kind must not need a
-- migration to be stored by a newer server beside an older replica.
--
-- Additive only: four nullable columns, no default, no backfill (history keeps reading through the markers, as
-- today). Every statement can run twice.
--
-- 1493: the highest number on every ref and session worktree was 1492 (1492_runner_account_sign_out); 1494 is taken
-- by the same project's phase 1b (account_health), which left 1493 for these columns.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "failure_kind" TEXT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "failure_scope" TEXT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "failure_said" TEXT;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "admission_failure" BOOLEAN;
