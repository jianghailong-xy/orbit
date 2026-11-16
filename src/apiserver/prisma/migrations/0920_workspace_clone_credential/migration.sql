-- Which credential a GitHub workspace's clone used (docs/github-workspace-design.md §6 step 4): the machine's own
-- (`machine`) or Orbit's GitHub App (`github-app`), as the runner reports it with the clone. Settings → GitHub lists
-- it beside each workspace from GitHub (board 02, note 3). NULL until a report names one, and for every workspace that
-- is not from GitHub.
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "clone_credential" TEXT;

DO $$ BEGIN
  ALTER TABLE "workspace"
    ADD CONSTRAINT "workspace_clone_credential_chk"
    CHECK ("clone_credential" IS NULL OR "clone_credential" IN ('machine', 'github-app'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
