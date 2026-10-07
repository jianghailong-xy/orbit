-- 0398 — the System model's state, in one row (docs/wiki-server-execution-design.md §5.3; contract
-- `systemModel.status`).
--
-- WHAT IT ADDS
-- ============
-- `wiki_model_status`, a table of exactly one row (`id` = 1), which the wiki-worker writes and the
-- apiserver reads:
--   * `state` — up | down | auth_failed | unconfigured: what the worker's last probe of the System model
--     found, or that its environment names no model;
--   * `model` — the model's name (ORBIT_WIKI_MODEL), NULL only while unconfigured;
--   * `since` — when that state began;
--   * `last_error` — why the state is not up, in words that name neither the endpoint's address nor its
--     key; NULL exactly while up;
--   * `checked_at` — the last probe, NULL while unconfigured: nothing is probed then;
--   * `worker_seen_at` — the worker's heartbeat, written with every probe (every 10 s). Older than 60 s,
--     the read answers worker_not_running.
--
-- WHY A ROW
-- =========
-- The worker serves no port, and the System model's address and key are in its environment alone, so the
-- apiserver learns the model's name and state from this row and from nothing else. That is also why no
-- column here can hold the address or the key.
--
-- 0398: the next number free on main, on every branch of origin and in every worktree on this host
-- (2026-10-07). Every statement can run twice — IF NOT EXISTS, and the CHECKs inside `duplicate_object`
-- guards. Nothing that exists is altered, no function, trigger or type is created, and no row is written:
-- the worker inserts the row on its first probe.

CREATE TABLE IF NOT EXISTS "wiki_model_status" (
  "id"             SMALLINT NOT NULL DEFAULT 1,
  "state"          TEXT NOT NULL,
  "model"          TEXT,
  "since"          TIMESTAMPTZ(3) NOT NULL,
  "last_error"     TEXT,
  "checked_at"     TIMESTAMPTZ(3),
  "worker_seen_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "wiki_model_status_pkey" PRIMARY KEY ("id")
);

-- One row: the deployment has one System model.
DO $$ BEGIN
  ALTER TABLE "wiki_model_status" ADD CONSTRAINT "wiki_model_status_one_row_chk" CHECK ("id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wiki_model_status"
    ADD CONSTRAINT "wiki_model_status_state_chk"
    CHECK ("state" IN ('up', 'down', 'auth_failed', 'unconfigured'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A model is named whenever one is configured, and a reason is given whenever the state is not up.
DO $$ BEGIN
  ALTER TABLE "wiki_model_status"
    ADD CONSTRAINT "wiki_model_status_model_chk" CHECK ("state" = 'unconfigured' OR "model" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wiki_model_status"
    ADD CONSTRAINT "wiki_model_status_last_error_chk" CHECK (("state" = 'up') = ("last_error" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
