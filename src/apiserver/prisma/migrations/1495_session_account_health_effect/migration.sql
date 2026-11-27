-- 1495 — what account health did with a failed run (docs/routing-account-health-design.md §7.4).
--
-- session.account_health_effect  SUSPECT or BLOCKED: the run's failure struck or blocked the account it spent
--                                (the breaker, or a classified refusal); TRIAL: the run was that account's trial
--                                and was refused. NULL: health did nothing with it.
--
-- Written once, after the run's release, by the ingest that hands the failure to AccountHealthService. A run with a
-- value is not counted for tier escalation or the auto-run failure budget (common/run-not-counted.ts): its failure
-- was the account's, not the task's. It is the one record of that per run: the health row keeps only the newest run
-- that wrote it, and a streak spans several.
--
-- Additive only: one nullable column, no default, no backfill. The statements can run twice.
--
-- 1495: the highest number on every ref and session worktree was 1494 (1494_account_health) when this was written.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "account_health_effect" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_account_health_effect_check') THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_account_health_effect_check"
      CHECK ("account_health_effect" IS NULL OR "account_health_effect" IN ('SUSPECT', 'BLOCKED', 'TRIAL'));
  END IF;
END $$;
