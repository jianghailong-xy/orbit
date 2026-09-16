-- Storage behind "take over a directory that already has Claude Code history in it".
--
-- Two unrelated pieces of state, added together because one feature needs both ends:
--
-- 1. `runner.claude_history_*` — a one-slot request/answer relay, the same shape as the sign-in,
--    install and checkout-repair relays beside it. The new-workspace form asks "what local Claude
--    Code conversations are under this path?" while the path is still being typed, so there is no
--    workspace row for the existing per-workspace `agentDirs` probe to key an answer to. Only the
--    runner can answer at all: ~/.claude/projects is on its disk and the control plane never sees
--    it. `claude_history_path` is stored beside the result so a late answer about a path the user
--    has since retyped reads as stale instead of as the verdict on the current one, and the result
--    itself is an advisory cache of that disk a moment ago — never the record of what was imported.
--
-- 2. `session.imported_at` — durable provenance for a session that came in as an imported
--    transcript. `import_source_cwd` (0274) cannot serve: it is the PENDING marker and is cleared
--    by import-result the moment the replay lands, so by the time anyone wants to undo an import
--    it is already NULL. This column is what "remove the conversations this directory's history
--    brought in" selects on, and it is never cleared.
--
-- Nothing to backfill on either. Sessions that predate this are not imports, and NULL is exactly
-- that; a runner with no request in flight is the NULL relay. Catalog-only: ADD COLUMN NULL does
-- not rewrite the heap.

ALTER TABLE "runner" ADD COLUMN "claude_history_status" TEXT;
ALTER TABLE "runner" ADD COLUMN "claude_history_path" TEXT;
ALTER TABLE "runner" ADD COLUMN "claude_history_at" TIMESTAMP(3);
ALTER TABLE "runner" ADD COLUMN "claude_history_result" JSONB;

ALTER TABLE "session" ADD COLUMN "imported_at" TIMESTAMP(3);
