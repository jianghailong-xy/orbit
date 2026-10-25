-- 0446 — the runner link's cut-over switch, RUNNER_LINK_REQUIRED, in one row (docs/runner-link-design.md §11.3,
-- §11.4, decision D15).
--
-- WHAT IT ADDS
-- ============
-- `runner_link_switch`, a table of at most one row (`id` = 1), which an administrator writes through
-- PUT /api/admin/runner-link-required and which every apiserver replica reads (runner-api/runner-link-required.ts):
--   * `required` — while true, the runner daemon's routes answer a call that comes over HTTPS 426
--     UPGRADE_REQUIRED, and the link gateway tells every runner MODE_LINK, so runners move their work onto the
--     link; switched off, both go back to what they did before;
--   * `updated_at` — when `required` was last switched; a request for the state it is already in writes
--     nothing;
--   * `updated_by_id` — the administrator who switched it. An id rather than a foreign key, so deleting that
--     account writes nothing here.
-- No row is the same as a row that is off: a deployment that never switched serves exactly as before.
--
-- WHY A ROW
-- =========
-- The switch has to take effect on every replica without a restart or a deploy, and the cut-over and its
-- first rollback are this one switch (D15). Each replica reads the row again at most a second after its
-- last read; the gateway reads it through GET /api/runner/link/mode.
--
-- 0446: the next number free on main, on every branch of origin, in every commit of `git log --all` and in
-- every worktree on this host (2026-10-25); 0442 to 0445 are taken by other tasks of the same project.
-- Every statement can run twice — IF NOT EXISTS, and the CHECK inside a `duplicate_object` guard. Nothing
-- that exists is altered, no function, trigger or type is created, and no row is written.

CREATE TABLE IF NOT EXISTS "runner_link_switch" (
  "id"            SMALLINT NOT NULL DEFAULT 1,
  "required"      BOOLEAN NOT NULL,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_id" UUID,
  CONSTRAINT "runner_link_switch_pkey" PRIMARY KEY ("id")
);

-- One row: the deployment has one switch.
DO $$ BEGIN
  ALTER TABLE "runner_link_switch" ADD CONSTRAINT "runner_link_switch_one_row_chk" CHECK ("id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
