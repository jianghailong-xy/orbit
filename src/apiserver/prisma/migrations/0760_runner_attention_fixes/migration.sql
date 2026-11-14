-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.attention_fixes`: the sessions Fix with an agent started on this runner, one per warning.
--
--   attention_fixes   { "<kind>[:<engine>]": { "sessionId": "<uuid>", "at": "<iso>" } }, e.g.
--                     { "engineNotUpdating:codex": { "sessionId": "…", "at": "2026-11-14T08:00:00.000Z" } }
--
-- Written by POST /runners/:id/attention/:kind/fix (RunnerAttentionFixService.fix) while it holds the
-- runner row, before it creates the session with that id, and never by the runner. While the named
-- session is open (not ended, completed or deleted), every client shows "An agent is fixing this"
-- in place of the button and the endpoint refuses a second start for the same warning. The warning
-- itself still leaves only when the runner reports success.
--
-- ADD COLUMN only, nullable with no default: catalog-only, no stored row rewritten. NULL is no agent
-- ever started here. No trigger on "runner" names it.

ALTER TABLE "runner" ADD COLUMN "attention_fixes" JSONB;
