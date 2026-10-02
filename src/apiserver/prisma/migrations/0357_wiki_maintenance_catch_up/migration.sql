-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 3 revision 4: a maintenance run says whether it was made in catch-up,
-- and whether the provider it was pinned to is a local endpoint. contracts/wiki.contract.json
-- `maintenance.job.catchUp` is the authority for everything below, and
-- src/apiserver/src/wiki/wiki-maintenance.pg.spec.ts holds it to it.
--
-- WHY (2026-10-02, the owner's orbit space)
-- -----------------------------------------
--   The cursor stood at 2026-09-19 00:41, thirteen days behind, with 1,800–1,970 facts pending and not
--   falling: eight runs a day, failed ones counted, twenty sessions a run. The owner chose catch-up (06:36Z):
--   a run on a local endpoint, or one that failed, is not counted against the day while the space is behind.
--   What a run counts is decided when the trigger makes it, so the row keeps what it was made as.
--
-- WHAT IS ADDED, on wiki_maintenance_run
-- --------------------------------------
--   catch_up        'active' — made while the space was behind and catching up; 'paused' — made while it was
--                   behind and its last runs had all failed; NULL — made while it was not behind, or by no
--                   trigger at all.
--   local_endpoint  the provider the run was pinned to answers on this machine or a private network: a
--                   configured provider made from no vendor preset whose base URL's host is loopback or private.
--
-- Nothing is written to a stored row: a run made before this was made in no catch-up, as NULL and false say.
-- task, session and every other table are not named. Every statement can run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_maintenance_run"
  ADD COLUMN IF NOT EXISTS "catch_up"       TEXT,
  ADD COLUMN IF NOT EXISTS "local_endpoint" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_maintenance_run_catch_up_check') THEN
    ALTER TABLE "wiki_maintenance_run" ADD CONSTRAINT "wiki_maintenance_run_catch_up_check"
      CHECK ("catch_up" IS NULL OR "catch_up" IN ('active', 'paused'));
  END IF;
END $$;
