-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution P2: the runner's repository operations.
-- contracts/wiki.contract.json `repoOps` is the authority for everything below,
-- docs/wiki-server-execution-design.md §7 is the design, and
-- src/apiserver/src/wiki-worker/wiki-repo-ops.pg.spec.ts holds it to the contract.
--
-- WHAT IS ADDED
-- -------------
--   wiki_repo_op            one repository operation a job asks for (design §7): the job it belongs to,
--                           the space and the workspace whose runner performs it, its kind (snapshot |
--                           read | diff | anchors), its input, its state, the claim a runner holds
--                           while it works (lease_owner, claim_generation, claimed_at, heartbeat_at),
--                           and what it answered (result, error). Claimed in the heartbeat response,
--                           the way the integration queue is: an UPDATE … FROM (SELECT … FOR UPDATE
--                           SKIP LOCKED) that gives each claimed row a new generation, with the result
--                           route a compare-and-set on that generation.
--   wiki_repo_op_fragment   the pieces of a snapshot that was too large for one request body, staged
--                           on the operation while it runs and removed with it (ON DELETE CASCADE).
--                           Staging rather than writing the cache directly: a cache is only ever
--                           written whole, so an upload that dies halfway leaves the space's snapshot
--                           as it was.
--   wiki_repo_snapshot      the space's snapshot index — the commit it was read at, its size, its
--                           sha256 and how many fragments hold it. ONE ROW PER SPACE: a newer snapshot
--                           replaces the last one whole, which is what "only the most recent one is
--                           kept" means (design §7, §9).
--   wiki_repo_snapshot_fragment  the index itself, in fragments. Deleted with the snapshot, which is
--                           deleted with the space (the composite foreign key into wiki_space).
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row, column or constraint of any existing table is written, altered or locked. `wiki_job`'s
-- waiting_for = 'repo' column and CHECK already exist (0401) — this phase is the first thing that
-- writes it. No trigger, function or type is created, replaced or dropped; `task`, `session` and
-- `task_list` are named nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0402: main stood at 0400_wiki_model_status and this project's line at 0401_wiki_job when this was
-- written (2026-10-08), and no other branch or worktree on this host held 0402. Every statement can run
-- twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE TABLE, and each
-- constraint added to a pre-existing table only when absent (there is none below).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_repo_op" (
  "id"               UUID NOT NULL,
  -- The job that asked for it. A repository operation is not a unit of work of its own: it exists to
  -- answer a step of a job, and a job that is deleted takes it.
  "job_id"           UUID NOT NULL,
  "owner_id"         UUID NOT NULL,
  "space_id"         UUID NOT NULL,
  -- The checkout: the workspace whose work directory is read, and the machine that workspace runs on.
  -- `runner_id` is written at the claim (and refreshed by a takeover): it says who is running this, and
  -- the result route's fence reads it. NULL while nobody has claimed it.
  "workspace_id"     UUID NOT NULL,
  "runner_id"        UUID,
  -- snapshot | read | diff | anchors (contract `repoOps.kinds`).
  "kind"             TEXT NOT NULL,
  -- What the kind reads: a read's paths and their limits, a diff's two commits, a snapshot's skip sha.
  -- Never the model's address or key — nothing here can hold one.
  "input"            JSONB NOT NULL DEFAULT '{}',
  "state"            TEXT NOT NULL DEFAULT 'queued',
  -- The claim: together exactly while running (`wiki_repo_op_lease_chk` holds it both ways). A runner
  -- renews heartbeat_at while it works; a claim silent for WIKI_REPO_OPS.staleSeconds may be taken over
  -- by another process on the same machine, under a new generation.
  "lease_owner"      UUID,
  "claim_generation" INTEGER NOT NULL DEFAULT 0,
  "claimed_at"       TIMESTAMPTZ(3),
  "heartbeat_at"     TIMESTAMPTZ(3),
  "result"           JSONB,
  "error"            TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at"         TIMESTAMPTZ(3),
  CONSTRAINT "wiki_repo_op_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_repo_op_job_fkey" FOREIGN KEY ("job_id") REFERENCES "wiki_job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_op_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_op_workspace_fkey"
    FOREIGN KEY ("workspace_id", "owner_id") REFERENCES "workspace" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_op_kind_chk" CHECK ("kind" IN ('snapshot', 'read', 'diff', 'anchors')),
  CONSTRAINT "wiki_repo_op_state_chk" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "wiki_repo_op_lease_chk" CHECK (("state" = 'running') = ("lease_owner" IS NOT NULL
    AND "claimed_at" IS NOT NULL AND "heartbeat_at" IS NOT NULL)),
  CONSTRAINT "wiki_repo_op_ended_chk" CHECK ("ended_at" IS NULL OR "state" IN ('succeeded', 'failed', 'cancelled')),
  CONSTRAINT "wiki_repo_op_error_chk" CHECK ("error" IS NULL OR "state" <> 'succeeded'),
  CONSTRAINT "wiki_repo_op_input_chk" CHECK (jsonb_typeof("input") = 'object'),
  CONSTRAINT "wiki_repo_op_result_chk" CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
  CONSTRAINT "wiki_repo_op_counts_chk" CHECK ("claim_generation" >= 0)
);
-- The claim: the oldest queued operation first, and the rows a machine may take over.
CREATE INDEX IF NOT EXISTS "wiki_repo_op_claim_idx" ON "wiki_repo_op" ("created_at", "id") WHERE "state" = 'queued';
CREATE INDEX IF NOT EXISTS "wiki_repo_op_stale_idx" ON "wiki_repo_op" ("heartbeat_at") WHERE "state" = 'running';
-- A job's operations, as its pipeline reads them.
CREATE INDEX IF NOT EXISTS "wiki_repo_op_job_idx" ON "wiki_repo_op" ("job_id", "created_at");

-- A snapshot's fragments while they are still being uploaded, staged under the operation that is
-- uploading them. Deleted with the operation; `wiki_repo_op_fragment_content_chk` keeps an empty
-- fragment out, because a fragment that says nothing is a fragment the runner did not send.
CREATE TABLE IF NOT EXISTS "wiki_repo_op_fragment" (
  "op_id"   UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  CONSTRAINT "wiki_repo_op_fragment_pkey" PRIMARY KEY ("op_id", "ordinal"),
  CONSTRAINT "wiki_repo_op_fragment_op_fkey" FOREIGN KEY ("op_id") REFERENCES "wiki_repo_op" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_op_fragment_ordinal_chk" CHECK ("ordinal" >= 0),
  CONSTRAINT "wiki_repo_op_fragment_content_chk" CHECK ("content" <> '')
);

-- The space's snapshot index, one row per space: replaced whole by a newer one, deleted with the space.
CREATE TABLE IF NOT EXISTS "wiki_repo_snapshot" (
  "space_id"       UUID NOT NULL,
  "owner_id"       UUID NOT NULL,
  -- The commit the index was read at, its size in bytes and the sha256 of those bytes.
  "sha"            CHAR(40) NOT NULL,
  "digest"         CHAR(64) NOT NULL,
  "size_bytes"     BIGINT NOT NULL,
  "fragment_count" INTEGER NOT NULL,
  "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_repo_snapshot_pkey" PRIMARY KEY ("space_id"),
  CONSTRAINT "wiki_repo_snapshot_space_owner_key" UNIQUE ("space_id", "owner_id"),
  CONSTRAINT "wiki_repo_snapshot_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_snapshot_sha_chk" CHECK ("sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "wiki_repo_snapshot_digest_chk" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "wiki_repo_snapshot_counts_chk" CHECK ("size_bytes" >= 0 AND "fragment_count" >= 1)
);

-- The index itself, in fragments, in order. Concatenated by ordinal, they are exactly the bytes the
-- digest names.
CREATE TABLE IF NOT EXISTS "wiki_repo_snapshot_fragment" (
  "space_id" UUID NOT NULL,
  "ordinal"  INTEGER NOT NULL,
  "content"  TEXT NOT NULL,
  CONSTRAINT "wiki_repo_snapshot_fragment_pkey" PRIMARY KEY ("space_id", "ordinal"),
  CONSTRAINT "wiki_repo_snapshot_fragment_snapshot_fkey"
    FOREIGN KEY ("space_id") REFERENCES "wiki_repo_snapshot" ("space_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_snapshot_fragment_ordinal_chk" CHECK ("ordinal" >= 0)
);
