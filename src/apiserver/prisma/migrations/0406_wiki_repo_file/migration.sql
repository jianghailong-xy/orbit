-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution: the read cache — whole files read at a commit, kept by (space, sha, path).
-- contracts/wiki.contract.json `repoOps.read` and `.cache` are the authority for everything below,
-- docs/wiki-server-execution-design.md §7 is the design, and
-- src/apiserver/src/wiki-worker/wiki-repo-ops.pg.spec.ts holds it to the contract.
--
-- WHY (owner 2026-10-08)
-- ----------------------
-- A read now answers with the WHOLE file at the sha, not the first 22,000 characters of it: the server's
-- pipelines cut a design document's section, a code symbol and a contract's paragraphs out of the whole
-- text, and find a footnote's quote anywhere in it — the same answers the runner's own path gives. A file
-- over 2 MB is not read at all: it is missing with the reason `too_large`.
--
-- WHAT IS ADDED
-- -------------
--   wiki_repo_file   one file's text at (space, sha, path), as the space's runner answered it. The same
--                    text is never read twice: a pipeline asks for what it needs, the server serves what
--                    it holds and asks the runner only for the rest. `state` says what the answer was —
--                    found (the whole file), cut (the bounded window an older runner answers with; a
--                    whole-file runner treats it as a miss and reads again), missing, or too_large.
--                    Owner-scoped and deleted with the space (the composite foreign key into wiki_space);
--                    a new snapshot landing drops every row of another sha, so what is kept is the files
--                    of the commit the space's snapshot names.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row, column or constraint of any existing table is written, altered or locked. `wiki_repo_op_fragment`
-- already stages a read's answer when it is too large for one request body (0402) and needs no change.
-- No trigger, function or type is created, replaced or dropped; `task`, `session` and `task_list` are named
-- nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0406: main stood at 0404_wiki_plan_server_draft and this project's line at 0405_wiki_plan_job_server_maker
-- when this was written (2026-10-08), and no other branch or worktree on this host held 0406. Every statement
-- can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE TABLE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_repo_file" (
  "id"         UUID NOT NULL,
  "owner_id"   UUID NOT NULL,
  "space_id"   UUID NOT NULL,
  -- The commit the file was read at, and its path in that tree.
  "sha"        CHAR(40) NOT NULL,
  "path"       TEXT NOT NULL,
  -- found | cut | missing | too_large (contract `repoOps.read`, design §7).
  "state"      TEXT NOT NULL,
  -- The text, for found and cut; empty otherwise. At most the file cap (2 MB), so one row is one file.
  "content"    TEXT NOT NULL DEFAULT '',
  -- The file's size in bytes at the sha: the whole file's, even when only its head was answered.
  "size_bytes" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_repo_file_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_repo_file_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_repo_file_sha_chk" CHECK ("sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "wiki_repo_file_path_chk" CHECK ("path" <> ''),
  CONSTRAINT "wiki_repo_file_state_chk" CHECK ("state" IN ('found', 'cut', 'missing', 'too_large')),
  CONSTRAINT "wiki_repo_file_content_chk" CHECK ("state" IN ('found', 'cut') OR "content" = ''),
  CONSTRAINT "wiki_repo_file_size_chk" CHECK ("size_bytes" >= 0)
);

-- One row per file at a commit: what a cache hit is, and what a later answer replaces.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_repo_file_space_sha_path_key"
  ON "wiki_repo_file" ("space_id", "sha", "path");
-- The files of a commit, as the snapshot's replacement reads them to drop another sha's.
CREATE INDEX IF NOT EXISTS "wiki_repo_file_space_sha_idx" ON "wiki_repo_file" ("space_id", "sha");
