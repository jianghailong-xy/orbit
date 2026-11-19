-- 0980 — a managed runner's home is /home/orbit, where its data volume is now mounted.
--
-- The managed runner image used to mount the volume at /var/lib/orbit with home in its `home` folder; it now mounts
-- it at /home/orbit, which is home itself (deploy/managed-runner/image). Existing volumes are discarded and rebuilt,
-- not migrated (owner 2026-11-17). What this moves is the folder a workspace on a managed runner names: one under
-- /var/lib/orbit/home (the Default workspace, a new folder) now names the same folder under /home/orbit, which is
-- where the rebuilt volume has it. Workspaces on any other runner are left as they are.
--
-- Runs twice safely: the second pass finds no workspace on a managed runner still under /var/lib/orbit/home.
UPDATE "workspace" w
SET "work_dir" = '/home/orbit' || substr(w."work_dir", length('/var/lib/orbit/home') + 1)
WHERE (w."work_dir" = '/var/lib/orbit/home' OR w."work_dir" LIKE '/var/lib/orbit/home/%')
  AND EXISTS (SELECT 1 FROM "managed_runner" m
              WHERE m."runner_id" = w."runner_id" OR m."runner_id" = w."target_runner_id");
