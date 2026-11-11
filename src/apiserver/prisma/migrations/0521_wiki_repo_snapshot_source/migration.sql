-- 0521: what a space's snapshot was read from (docs/wiki-repo-tiers-design.md §4.2, contract `repoOps.folder`): `git`, the
-- commit origin/main named, as every snapshot before it was; or `folder`, a working directory that is not a git checkout,
-- whose `sha` is its tree hash. A defaulted column and its CHECK only: every existing row reads `git`, and no trigger,
-- fence or preserved function is touched.
ALTER TABLE "wiki_repo_snapshot" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'git';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_repo_snapshot_source_chk') THEN
    ALTER TABLE "wiki_repo_snapshot" ADD CONSTRAINT "wiki_repo_snapshot_source_chk" CHECK ("source" IN ('git', 'folder'));
  END IF;
END $$;
