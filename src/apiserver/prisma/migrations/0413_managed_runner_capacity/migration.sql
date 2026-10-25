-- 0413 — managed runner capacity admission, wake and sleep (docs/managed-runner-design.md,
-- "Resource admission model supply and isolation" and "Provisioning retry wake and sleep").
--
-- One new table, `managed_runner_capacity`: the fixed budget of one managed runner environment (one
-- row per cluster key and namespace) — CPU and memory requests, ephemeral storage, Pod and volume
-- attach slots, managed users active at once, the storage pool's safe usable bytes and the headroom
-- kept free — beside what is reserved from each now. The manager writes the totals from its profile;
-- the reserved columns move only by a conditional UPDATE in the transaction that records a mapping's
-- share on `managed_runner.reservation` (0399), so two admissions racing for the last slot are
-- serialized on this row. CHECKs hold every reserved figure at zero or above.
--
-- Four nullable columns on `managed_runner`: `capacity_revision` (the pool revision an admission
-- was refused at), and for a drain to sleep `drain_demand_revision` (the demand it began at),
-- `stop_requested_at` (when the instance was asked to stop) and `stop_acknowledged_at` (when the
-- instance, idle, accepted — after which the drain can no longer be called off and the instance
-- exits on its own). One nullable JSONB column on `runner`,
-- `managed_workload`: what a managed runner's authorized instance last reported it was doing; a
-- self-managed runner's row is never written.
--
-- 0413: the first number free on every ref and every local worktree on 2026-10-09. Every statement
-- can run twice: IF NOT EXISTS, and constraints inside a `duplicate_object` guard. No existing
-- column, constraint, function, trigger or type is altered or dropped, every new column is nullable
-- without a default (catalog-only), and no row is written: a deployment without the feature has an
-- empty table and NULL columns.

CREATE TABLE IF NOT EXISTS "managed_runner_capacity" (
  "id"                        UUID NOT NULL,
  "cluster_key"               TEXT NOT NULL,
  "namespace"                 TEXT NOT NULL,
  "cpu_millis"                BIGINT NOT NULL,
  "memory_bytes"              BIGINT NOT NULL,
  "ephemeral_bytes"           BIGINT NOT NULL,
  "pods"                      INTEGER NOT NULL,
  "attachments"               INTEGER NOT NULL,
  "active_users"              INTEGER NOT NULL,
  "storage_usable_bytes"      BIGINT NOT NULL,
  "storage_headroom_bytes"    BIGINT NOT NULL,
  "cpu_millis_reserved"       BIGINT NOT NULL DEFAULT 0,
  "memory_bytes_reserved"     BIGINT NOT NULL DEFAULT 0,
  "ephemeral_bytes_reserved"  BIGINT NOT NULL DEFAULT 0,
  "pods_reserved"             INTEGER NOT NULL DEFAULT 0,
  "attachments_reserved"      INTEGER NOT NULL DEFAULT 0,
  "active_users_reserved"     INTEGER NOT NULL DEFAULT 0,
  "durable_bytes_reserved"    BIGINT NOT NULL DEFAULT 0,
  "revision"                  INTEGER NOT NULL DEFAULT 1,
  "created_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "managed_runner_capacity_pkey" PRIMARY KEY ("id")
);

-- One budget per environment.
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_capacity_pool_key"
  ON "managed_runner_capacity" ("cluster_key", "namespace");

DO $$ BEGIN
  ALTER TABLE "managed_runner_capacity"
    ADD CONSTRAINT "managed_runner_capacity_totals_chk"
    CHECK ("cpu_millis" >= 0 AND "memory_bytes" >= 0 AND "ephemeral_bytes" >= 0 AND "pods" >= 0
       AND "attachments" >= 0 AND "active_users" >= 0 AND "storage_usable_bytes" >= 0
       AND "storage_headroom_bytes" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A share given back twice would take a figure below zero: refused, so the release fails whole.
DO $$ BEGIN
  ALTER TABLE "managed_runner_capacity"
    ADD CONSTRAINT "managed_runner_capacity_reserved_chk"
    CHECK ("cpu_millis_reserved" >= 0 AND "memory_bytes_reserved" >= 0 AND "ephemeral_bytes_reserved" >= 0
       AND "pods_reserved" >= 0 AND "attachments_reserved" >= 0 AND "active_users_reserved" >= 0
       AND "durable_bytes_reserved" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "managed_runner_capacity"
    ADD CONSTRAINT "managed_runner_capacity_location_chk"
    CHECK ("cluster_key" <> '' AND "namespace" <> '' AND "revision" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "managed_runner" ADD COLUMN IF NOT EXISTS "capacity_revision" INTEGER;
ALTER TABLE "managed_runner" ADD COLUMN IF NOT EXISTS "drain_demand_revision" INTEGER;
ALTER TABLE "managed_runner" ADD COLUMN IF NOT EXISTS "stop_requested_at" TIMESTAMPTZ(3);
ALTER TABLE "managed_runner" ADD COLUMN IF NOT EXISTS "stop_acknowledged_at" TIMESTAMPTZ(3);

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "managed_workload" JSONB;
