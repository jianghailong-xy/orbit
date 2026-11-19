-- 1150: a guest's daily ✦ Optimize count (project 3504qZwKVUy7ccEQYo3HR, decision D4 of 2026-11-19).
--
-- A guest may optimize 100 drafts in one session per UTC day, on the owner's server key. The count lives on the
-- guest's own session_guest row beside the 50-messages-a-day count (0572) and is taken by one conditional UPDATE
-- before the optimizer is called, so two requests at 99 cannot both pass.
--
--   optimizer_day           the UTC day optimizer_uses_on_day counts; NULL until the guest's first use.
--   optimizer_uses_on_day   optimizations started on optimizer_day. One that then fails still counts: it was run.
--
-- Two added columns, one with a constant default: catalog-only, no table rewrite. Every statement can run twice.

ALTER TABLE "session_guest" ADD COLUMN IF NOT EXISTS "optimizer_day" DATE;
ALTER TABLE "session_guest" ADD COLUMN IF NOT EXISTS "optimizer_uses_on_day" INTEGER NOT NULL DEFAULT 0;
