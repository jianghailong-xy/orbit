-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.login_account` and `runner.login_account_name`: which Codex account the browser-less
-- sign-in relay is signing in.
--
-- A runner can hold more than one Codex account: Default is the CODEX_HOME its own environment
-- selects, and every other account is a slot it added under $ORBIT_HOME/codex-accounts
-- (`src/runner-go/codex_account_slot.go`). `POST /runners/:id/login` names the account to sign in —
-- an existing slot's id, or the name of a new one for the runner to add — and the heartbeat hands
-- it to the runner with the relay's `start`, redelivered until the runner's first report. The
-- account has to sit on the row between the POST and the heartbeat, next to the relay state it
-- belongs to, which is these two columns:
--
--   login_account       'default' or a slot id. For a new account it is NULL until the runner
--                       reports the slot it added — the only way the control plane learns the id.
--   login_account_name  the new account's name, so every redelivered start asks for the same one.
--
-- NULLABLE, and NULL is the old behaviour rather than a gap: a sign-in naming no account is the
-- runner's own login, which is all any row written before this migration ever was.
--
-- ADD COLUMN only: no default, no NOT NULL, so the ALTER is catalog-only and no stored row is
-- rewritten.

ALTER TABLE "runner" ADD COLUMN "login_account" TEXT;
ALTER TABLE "runner" ADD COLUMN "login_account_name" TEXT;
