-- 0457 — a machine with no workspace gets its first one from the conversation (docs/first-workspace-contract.md).
--
--   runner.register_dir        TEXT. The directory `orbit register` ran in, as the CLI reported it: written when a
--                              device registration is approved (deviceEnrollment.workDir) and by a token registration
--                              that carries a workDir, overwritten by the next registration that carries one. A
--                              suggestion the setup card probes before offering, never a default. NULL: registered
--                              before this column, or by a CLI that sent no directory.
--   runner.dir_probe_status,   One-slot "what is at this path on this machine?" relay, the shape of the
--   runner.dir_probe_path,     claude_history_* relay beside it (0275): NULL (nobody is asking) → pending (the next
--   runner.dir_probe_at,       heartbeat hands it over) → probing (handed to one heartbeat) → done (dir_probe_result
--   runner.dir_probe_result    answers dir_probe_path). The asked path is kept beside the answer so a late answer
--                              about a path the person has since retyped reads as stale, never as the verdict on the
--                              current one. The result is an advisory cache of that disk a moment ago.
--   workspace.auto_create_work_dir
--                              BOOLEAN NOT NULL DEFAULT false. True for a workspace POST /sessions made with a new
--                              folder under the runner's reposRoot: the claim then says createWorkDir, and the runner
--                              makes the directory before the engine starts.
--   session.created_workspace  BOOLEAN NOT NULL DEFAULT false. True for a session that made its own workspace in the
--                              transaction that created it, which is what lets a client draw "Created workspace …" as
--                              the conversation's first line.
--
-- Catalog-only ADD COLUMNs: the nullable ones have no default, and the two booleans a constant one, so no table is
-- rewritten and no row is read, written or backfilled. Every runner reads no register directory and no relay in
-- flight; every workspace and session reads false, which is what each of them is. No index, trigger, function or
-- constraint is created, replaced or dropped.
--
-- 0457: the next number free on main and on every ref of this repository (2026-10-31; 0456 is held by another
-- branch). Every statement can run twice.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "register_dir" TEXT;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "dir_probe_status" TEXT;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "dir_probe_path" TEXT;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "dir_probe_at" TIMESTAMP(3);
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "dir_probe_result" JSONB;

ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "auto_create_work_dir" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "created_workspace" BOOLEAN NOT NULL DEFAULT false;
