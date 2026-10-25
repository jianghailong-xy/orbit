-- 0442 — the runner dispatch pause, in one row (docs/runner-link-design.md §11.1, §11.3, decision D8).
--
-- WHAT IT ADDS
-- ============
-- `dispatch_pause`, a table of at most one row (`id` = 1), which an administrator writes through
-- PUT /api/admin/dispatch-pause and which every apiserver replica reads in the statements that hand a
-- runner new work (queue/dispatch-pause.ts):
--   * `paused` — while true, no session is claimed, the inbox hands out no message, shell or reload, and
--     no queued integration job is claimed. Interrupt, end and the other control turns, a steer written
--     into the turn already running, and everything a running turn reports still go through;
--   * `updated_at` — when `paused` was last switched; a request for the state it is already in writes
--     nothing;
--   * `updated_by_id` — the administrator who switched it. An id rather than a foreign key, so deleting
--     that account writes nothing here.
-- No row is the same as a row that is off: a deployment that never paused reads exactly as before.
--
-- WHY A ROW
-- =========
-- The switch has to take effect on every replica at once and without a restart, and the statements it
-- governs already run in PostgreSQL: each reads this row inside the statement that would hand the work
-- out, so no replica holds a copy that can go stale.
--
-- 0442: the next number free on main, on every branch of origin and in every worktree on this host
-- (2026-10-25); 0443 is taken by the connection-token task of the same project. Every statement can run
-- twice — IF NOT EXISTS, and the CHECK inside a `duplicate_object` guard. Nothing that exists is
-- altered, no function, trigger or type is created, and no row is written.

CREATE TABLE IF NOT EXISTS "dispatch_pause" (
  "id"            SMALLINT NOT NULL DEFAULT 1,
  "paused"        BOOLEAN NOT NULL,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_id" UUID,
  CONSTRAINT "dispatch_pause_pkey" PRIMARY KEY ("id")
);

-- One row: the deployment has one switch.
DO $$ BEGIN
  ALTER TABLE "dispatch_pause" ADD CONSTRAINT "dispatch_pause_one_row_chk" CHECK ("id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
