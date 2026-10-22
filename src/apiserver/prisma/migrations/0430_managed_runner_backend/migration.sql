-- 0430 — the run backend of each managed runner mapping (docs/managed-runner-design.md,
-- "Implementation record: Docker backend").
--
-- One column on `managed_runner` (0399's table): `backend`, the run backend that made the mapping's
-- volume and instances and alone drives them — 'kubernetes' (a Ceph RBD PVC and a bare Pod) or
-- 'docker' (a local volume and a container, through the restricted Docker channel). Every mapping
-- stored before it is a Kubernetes one, which the default says. A manager drives only its own
-- backend's mappings, so a deployment that changes backend leaves the other's as they are, as
-- turning the switch off does.
--
-- 0430: the first number free on every ref and every local worktree on 2026-10-17 (0429 is taken by
-- an unlanded branch). ADD COLUMN with a constant default is catalog-only; the CHECK reads the
-- table's rows once, and every stored row satisfies it. Only `managed_runner` is named; no index,
-- function, trigger or type is created, replaced or dropped, and no row is written. Every statement
-- can run twice: IF NOT EXISTS, and the constraint inside a `duplicate_object` guard.

ALTER TABLE "managed_runner" ADD COLUMN IF NOT EXISTS "backend" TEXT NOT NULL DEFAULT 'kubernetes';

DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_backend_chk" CHECK ("backend" IN ('kubernetes', 'docker'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
