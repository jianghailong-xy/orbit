-- D2-era: this reads or writes session.status, which deploy D4 (migration 1711) dropped. It runs on a database of
-- deploy D1 or D2 only, and is kept for the record of those deploys.
--
-- One batch of the turn_state / phase backfill (docs/session-status-retirement-plan.md §4.4; task T3 runs it on
-- production, with the owner's go, between deploy D1 and deploy D2). It writes production rows.
--
--   scripts/session-turn-state-backfill.sh            # runs this file until a batch writes 0 rows
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-turn-state-backfill.sql   # one batch
--
-- Needs migrations 1611 and 1612 (deploy D1) on the database, live on every replica. Every row whose stored
-- turn_state or phase is not what the stored word gives gets it: up to 500 rows a batch, oldest id first (UUIDv7),
-- in one transaction of its own. The UPDATE names turn_state, so session_zz_phase recomputes phase in the same
-- write, and it sets nothing else: no writer's column moves.
--
-- Locks: rows another transaction holds are skipped (SKIP LOCKED) and picked up by a later batch. The statement asks
-- for its table lock for 2 s at most; a batch that times out writes nothing and the next one tries again.
--
-- Each batch fires session_open_list_epoch_update once (the two columns are not in open_list_bump_session's skip
-- list), so every owner with a row in the batch gets one sessions.list_changed hint. About 25 batches for 12,201
-- sessions (2026-11-22).
--
-- Done when a batch reports UPDATE 0. Then run scripts/session-turn-state-census.sql: it must answer 0 in
-- turn_state_disagrees and phase_disagrees.

SET lock_timeout = '2s';

UPDATE "session" s
   SET "turn_state" = session_turn_state_of_status(s."status")
 WHERE s."id" IN (SELECT "id" FROM "session"
                   WHERE "turn_state" IS DISTINCT FROM session_turn_state_of_status("status")
                      OR "phase" IS DISTINCT FROM session_phase_of("finished_at", session_turn_state_of_status("status"),
                                                                    "engine_turn_active", "running_subagents",
                                                                    "running_bg_jobs", "retry_at")
                   ORDER BY "id" LIMIT 500
                   FOR UPDATE SKIP LOCKED);
