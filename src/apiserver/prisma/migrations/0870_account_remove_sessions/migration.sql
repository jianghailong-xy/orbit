-- 0870 — a refused account removal names the sessions in the account.
--
-- `runner.codex_account_remove_sessions`: the session ids a runner reports when it refuses to remove an
-- account because sessions it is running are in it. The runner's page lists them by title, so the person
-- who pressed Remove knows which sessions to end. Empty for every other outcome.
--
-- BACKWARD COMPATIBLE: a new column with a default; an older apiserver neither reads nor writes it.
ALTER TABLE "runner" ADD COLUMN "codex_account_remove_sessions" UUID[] NOT NULL DEFAULT '{}';
