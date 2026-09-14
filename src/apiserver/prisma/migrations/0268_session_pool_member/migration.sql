-- 0268 — which account-pool member a session runs on, and the transcript line a move between members
-- owes.
--
-- WHAT IT ADDS
-- ============
--   * `session.pool_member_provider_id` — the `model_provider` a session's last claim dispatched on when
--     the session's provider is an account pool (0265). The next claim reads it to stay on that member
--     until the member is spent or refused (queue.service.ts, providers/pool-select.ts). No foreign key:
--     a member that was deleted or taken out of its pool matches none of the pool's members, and the
--     claim simply chooses again. A key would also put `model_provider` into the lock set of the
--     session writes that re-check every session foreign key (common/lock-order.ts).
--   * `session.pool_switch_notice` — the transcript line owed for the last move between members, held
--     until the runner's next engine start event carries it (runner-api events). It is not written as
--     a run_event of its own: the runner numbers a session's events, and a row the control plane
--     inserted would take the seq the runner's next event is about to use.
--
-- Both nullable, with no default and no backfill: no existing session runs on a pool.

ALTER TABLE "session"
  ADD COLUMN "pool_member_provider_id" UUID,
  ADD COLUMN "pool_switch_notice" TEXT;
