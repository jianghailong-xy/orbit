/**
 * For a PG spec that needs a session row the backfill of session.turn_state and session.phase (task T3) had not reached:
 * run this once on the spec's own disposable database. It takes off what migrations 1651 to 1655 refuse such a row by
 * (docs/session-status-retirement-plan.md §4.1, D2). The server's reads stay NULL-safe, and these specs hold them to it.
 */
export const ALLOW_UNFILLED_SESSIONS =
  'ALTER TABLE "session" DROP CONSTRAINT "session_turn_state_agrees_chk", ALTER COLUMN "phase" DROP NOT NULL';
