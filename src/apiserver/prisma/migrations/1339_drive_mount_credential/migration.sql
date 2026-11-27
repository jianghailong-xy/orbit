-- 1339 — Orbit Files drive: the mount credential (docs/orbit-files-drive-technical-design.md §4.3, §8.2).
--
--   drive_mount_credential  what the mount daemon of one managed-runner generation presents at /runner/drive/*
--
-- Issued per managed-runner generation beside that generation's runner credential, and refused by every route outside
-- /runner/drive/*. Only the sha256 of the token is kept. A credential works only while its generation is the mapping's
-- and its instance is the one the manager recorded (the runner guard's rules, managed-runner-instance.ts); a newer
-- generation's credential revokes the older ones of its runner when it is issued.

CREATE TABLE IF NOT EXISTS "drive_mount_credential" (
  "id"          UUID           NOT NULL,
  "owner_id"    UUID           NOT NULL,
  "runner_id"   UUID           NOT NULL,
  "generation"  INTEGER        NOT NULL,
  "token_hash"  TEXT           NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "revoked_at"  TIMESTAMPTZ(3),
  CONSTRAINT "drive_mount_credential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "drive_mount_credential_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "drive_mount_credential_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_mount_credential_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "drive_mount_credential_generation_chk" CHECK ("generation" >= 1)
);

CREATE INDEX IF NOT EXISTS "drive_mount_credential_runner_idx" ON "drive_mount_credential" ("runner_id", "generation");
