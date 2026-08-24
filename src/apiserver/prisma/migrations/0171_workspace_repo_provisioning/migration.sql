-- Foundation for "create a workspace FROM a git repository": a workspace learns which repo it is,
-- and gets a provisioning lifecycle somebody can watch.
--
-- Nothing in this database has ever recorded a remote URL — before this migration a workspace was
-- a `runner_id` plus a `work_dir` that already existed on that machine, and the only way to answer
-- "which repo is this?" was to read a `.git/config` on a machine the control plane cannot see.
-- `repo_url` is the point of the feature; the clone is its side effect.
--
-- WHY THERE IS NO BACKFILL UPDATE, AND THEREFORE NO SECOND MIGRATION
-- ==================================================================
-- Every pre-existing workspace must read READY: its directory is already on disk, which is the
-- whole of what READY claims. The obvious way to write that is a full-table
-- `UPDATE workspace SET provision_state = 'READY'`, and this repo has learned to split such an
-- UPDATE into its own migration, because a Prisma migration file is ONE transaction and a
-- table-wide UPDATE inside it holds a row lock on every row until that transaction commits.
--
-- There is no UPDATE here to split. `provision_state` is added NOT NULL DEFAULT 'READY', and
-- Postgres 11+ records a non-volatile ADD COLUMN default in the catalog
-- (`pg_attribute.attmissingval`) rather than rewriting the heap: existing rows read 'READY' the
-- instant this statement commits, without the rows being touched. The backfill is the default.
--
-- ROLLING DEPLOY. Both directions are safe. Every column added here is nullable or defaulted, so a
-- replica still running the previous build inserts workspaces exactly as it does today and its
-- rows land READY — which is true of them, since that build has no way to clone anything.

-- The lifecycle of a workspace's directory. No UNKNOWN member and the column is NOT NULL: the one
-- "nobody told us" this model is allowed is `workspace.repo_url`'s NULL, and a second spelling of
-- it here would leave every reader guessing which of the two a row means.
CREATE TYPE "workspace_provision_state" AS ENUM ('READY', 'CLONING', 'FAILED');

ALTER TABLE "workspace"
  -- The git remote this workspace's `work_dir` was cloned from. NULL = nobody ever told us: a
  -- workspace `orbit register` minted from a directory that was already there, or one hand-made in
  -- the config form. Deliberately NOT backfilled from any checkout's own `origin` — a guessed
  -- remote and a recorded one are indistinguishable at every later read.
  ADD COLUMN "repo_url" TEXT,
  ADD COLUMN "provision_state" "workspace_provision_state" NOT NULL DEFAULT 'READY',
  -- Git's stderr from the clone that failed, verbatim. NULL unless provision_state = 'FAILED'.
  ADD COLUMN "provision_error" TEXT;

ALTER TABLE "runner"
  -- Root directory this machine clones into, reported each heartbeat: a clone of `<owner>/<repo>`
  -- lands at `<repos_root>/<owner>-<repo>`. NULL = this runner has never reported one (a build too
  -- old to send it), which withdraws the create-from-a-git-URL path for the machine rather than
  -- inventing a root and writing a checkout somewhere the user never agreed to put one.
  ADD COLUMN "repos_root" TEXT;
