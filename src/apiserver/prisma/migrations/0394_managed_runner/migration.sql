-- 0394 — the managed runner mapping (docs/managed-runner-design.md, "Identity and durable mapping").
--
-- One row per user who has a managed runner: the owner, the stable runner row and default workspace
-- created with it, and the one data PVC's location (cluster key, namespace, `mr-data-<runner uuid>`)
-- with the PVC/PV/volume identity the manager observed. `desired_state` is what the owner asked for;
-- `management_state` is how far the manager got, and only the manager moves it. Both enums carry the
-- whole contract's state set; this version moves REQUESTED → PROVISIONING → STARTING → READY and to
-- FAILED, and leaves the capacity, sleep, fencing and deletion states to the work that follows.
--
-- Every foreign key is ON DELETE RESTRICT. Deleting the user, the runner or the default workspace
-- would discard the storage and fencing record, and `workspace.runner_id` cascades, so a deleted
-- runner would also take its workspaces with it. The runner and workspace keys are composite with
-- `owner_id` (0231's `runner_id_owner_id_key` and 0307's `workspace_id_owner_id_key`), so the mapping
-- cannot disagree with either about whose it is.
--
-- 0394: the first number free on every ref and every local worktree on 2026-10-07 (0393 is held by
-- an unlanded branch). Every statement can run twice: IF NOT EXISTS, and types and constraints inside
-- a `duplicate_object` guard. No existing table, column, constraint, function, trigger or type is
-- altered or dropped, and no row is written: a deployment without the feature has an empty table.

DO $$ BEGIN
  CREATE TYPE "managed_runner_desired_state" AS ENUM ('RUNNING', 'SLEEPING', 'DELETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "managed_runner_management_state" AS ENUM (
    'REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING',
    'SLEEPING', 'FENCING', 'FAILED', 'DELETING', 'DELETED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "managed_runner" (
  "id"                       UUID NOT NULL,
  "owner_id"                 UUID NOT NULL,
  "runner_id"                UUID NOT NULL,
  "default_workspace_id"     UUID NOT NULL,
  "desired_state"            "managed_runner_desired_state" NOT NULL DEFAULT 'RUNNING',
  "management_state"         "managed_runner_management_state" NOT NULL DEFAULT 'REQUESTED',
  "generation"               INTEGER NOT NULL DEFAULT 1,
  "revision"                 INTEGER NOT NULL DEFAULT 1,
  "cluster_key"              TEXT NOT NULL,
  "namespace"                TEXT NOT NULL,
  "pvc_name"                 TEXT NOT NULL,
  "pvc_uid"                  TEXT,
  "pv_uid"                   TEXT,
  "volume_handle"            TEXT,
  "pod_name"                 TEXT,
  "pod_uid"                  TEXT,
  "node_name"                TEXT,
  "node_uid"                 TEXT,
  "reservation"              JSONB,
  "demand_revision"          INTEGER NOT NULL DEFAULT 0,
  "last_demand_at"           TIMESTAMPTZ(3),
  "initial_provider"         TEXT,
  "resource_profile_id"      TEXT,
  "resource_operation_id"    TEXT,
  "resource_operation_kind"  TEXT,
  "resource_operation_state" TEXT,
  "attempt"                  INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"          TIMESTAMPTZ(3),
  "startup_deadline_at"      TIMESTAMPTZ(3),
  "last_error"               JSONB,
  "fencing_receipt"          JSONB,
  "lease_holder"             TEXT,
  "lease_expires_at"         TIMESTAMPTZ(3),
  "last_request_key"         TEXT,
  "state_entered_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"               TIMESTAMPTZ(3),
  "created_at"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "managed_runner_pkey" PRIMARY KEY ("id")
);

-- One mapping per owner, per runner and per default workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_owner_id_key" ON "managed_runner" ("owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_runner_id_key" ON "managed_runner" ("runner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_default_workspace_id_key"
  ON "managed_runner" ("default_workspace_id");
-- The composite twins Prisma requires on the defining side of the two owner-composite relations.
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_runner_id_owner_id_key"
  ON "managed_runner" ("runner_id", "owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_default_workspace_id_owner_id_key"
  ON "managed_runner" ("default_workspace_id", "owner_id");
-- One mapping per PVC location, and a recorded PVC UID or CSI volume handle cannot be adopted by a
-- second mapping. NULLs (not yet observed) do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_pvc_location_key"
  ON "managed_runner" ("cluster_key", "namespace", "pvc_name");
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_pvc_uid_key" ON "managed_runner" ("pvc_uid");
CREATE UNIQUE INDEX IF NOT EXISTS "managed_runner_volume_handle_key" ON "managed_runner" ("volume_handle");

DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_runner_fkey"
    FOREIGN KEY ("runner_id", "owner_id") REFERENCES "runner" ("id", "owner_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_default_workspace_fkey"
    FOREIGN KEY ("default_workspace_id", "owner_id") REFERENCES "workspace" ("id", "owner_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Kubernetes names are derived from the canonical runner UUID and nothing else, so a row cannot
-- point the manager at a PVC or Pod belonging to another runner.
DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_names_chk"
    CHECK ("pvc_name" = 'mr-data-' || "runner_id"::text
       AND ("pod_name" IS NULL OR "pod_name" = 'mr-' || "runner_id"::text));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_location_chk"
    CHECK ("cluster_key" <> '' AND "namespace" <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_counters_chk"
    CHECK ("generation" >= 1 AND "revision" >= 1 AND "attempt" >= 0 AND "demand_revision" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A lease names its holder and its expiry together, or neither.
DO $$ BEGIN
  ALTER TABLE "managed_runner"
    ADD CONSTRAINT "managed_runner_lease_chk"
    CHECK (("lease_holder" IS NULL) = ("lease_expires_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
