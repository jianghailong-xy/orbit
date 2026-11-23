-- 1434 — a managed runner's Repos Folder is under /home/orbit, as 0980 made its workspaces' folders.
--
-- 0980 moved the folders workspaces on a managed runner name from /var/lib/orbit/home to /home/orbit, but not the
-- runner's own reported repos_root. A managed runner last heard from on the earlier image keeps
-- /var/lib/orbit/home/orbit-repos until it next reports, and while it sleeps or is being set up the new-folder card
-- shows that path and a new workspace is made under it. Its image now reports /home/orbit/orbit-repos, so this names
-- what it will report. Runners that are not managed are left as they are.
--
-- Runs twice safely: the second pass finds no managed runner still under /var/lib/orbit/home.
UPDATE "runner" r
SET "repos_root" = '/home/orbit' || substr(r."repos_root", length('/var/lib/orbit/home') + 1)
WHERE (r."repos_root" = '/var/lib/orbit/home' OR r."repos_root" LIKE '/var/lib/orbit/home/%')
  AND EXISTS (SELECT 1 FROM "managed_runner" m WHERE m."runner_id" = r."id");
