-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A runner heartbeat's directory and disk probe of its workspaces no longer moves the Open list's
-- version (0484/0487), and so no longer sends `sessions.list_changed` (realtime/open-list-hints.ts),
-- unless it changes what a list shows.
--
-- WHAT WAS WRONG
-- --------------
-- Every heartbeat writes every workspace row of its runner (runner-api/link-heartbeat.ts
-- `directoryProbesSql`, and the HTTPS heartbeat in runner-api.controller.ts): work_dir_exists,
-- work_dir_is_git, work_dir_free_bytes, work_dir_total_bytes, work_dir_probed_at (always now()) and,
-- once, repo_url. 0484's `workspace_open_list_epoch_update` bumped the account on each of them. On
-- 2026-11-22, with 8 runners beating, the workspace counter moved in 184 of 900 seconds, and the
-- owner's web tab read 183 Open lists that had nothing new.
--
-- WHAT AN OPEN LIST READS OF A WORKSPACE
-- --------------------------------------
-- The row (sessions.service.ts listRows, and openListProbe for a since= read): id, name, model,
-- effort, through the session's workspace_id. The queued gates of a PENDING row: clone_state
-- (workspace-clone-gate.ts), and work_dir_free_bytes against the floor of the session's assigned
-- runner (runner-disk-gate.ts `sessionDiskHoldSql`: never started, a reading, a floor > 0, and the
-- reading below it). Nothing else, and nothing of the probe but that comparison.
--
-- WHAT CHANGES
-- ------------
-- For UPDATE on `workspace` only, an owner is bumped for a row whose new and old versions differ in
-- anything but the probe columns (OPEN_LIST_UNDRAWN_WORKSPACE_COLUMNS in sessions/open-list-version.ts,
-- listed again below), or whose work_dir_free_bytes moved across the disk floor of the runner of a
-- PENDING session of that workspace that has never started — the one case in which the gate's verdict
-- for a queued row flips. A free-bytes change on either side of every such floor, or on a workspace
-- with no such session, bumps nothing; a session that becomes PENDING later bumps its own counter.
-- Every other column bumps as before — including one added after this migration — and so does every
-- INSERT and DELETE, every other table, and an owner change, which differs in a drawn column by itself.
--
-- A bump still waits for nobody (0487): the compare reads the statement's transition tables and, for
-- a free-bytes change, the workspace's PENDING sessions and their runners, plain reads that take no
-- row lock; only `open_list_bump` takes a lock, and it is unchanged.
--
-- WHY NO DDL
-- ----------
-- As in 0487 and 0512, only `open_list_bump_owner` is replaced; its name, arguments and every trigger
-- stay, so no table is locked. A statement already inside the old function finishes on it. 0512's
-- `project_integration_job` branch is carried over unchanged.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION open_list_bump_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'project_integration_job' THEN
    FOR o IN EXECUTE
      'SELECT DISTINCT n.owner_id
         FROM new_rows n JOIN old_rows d ON d.id = n.id
        WHERE n.state <> ''RUNNING'' OR d.state <> ''RUNNING''
           OR (to_jsonb(n) - ''heartbeat_at'' - ''updated_at'' - ''phase'' - ''round'' - ''step''
                - ''step_started_at'' - ''output_moved_at'' - ''current_check'')
              IS DISTINCT FROM
              (to_jsonb(d) - ''heartbeat_at'' - ''updated_at'' - ''phase'' - ''round'' - ''step''
                - ''step_started_at'' - ''output_moved_at'' - ''current_check'')
       UNION
       SELECT d.owner_id
         FROM new_rows n JOIN old_rows d ON d.id = n.id
        WHERE n.owner_id IS DISTINCT FROM d.owner_id'
    LOOP
      PERFORM open_list_bump(o, src);
    END LOOP;
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'workspace' THEN
    FOR o IN EXECUTE
      'WITH moved AS (
         SELECT n.owner_id AS new_owner, d.owner_id AS old_owner
           FROM new_rows n JOIN old_rows d ON d.id = n.id
          WHERE (to_jsonb(n) - $1) IS DISTINCT FROM (to_jsonb(d) - $1)
             OR (n.work_dir_free_bytes IS DISTINCT FROM d.work_dir_free_bytes AND EXISTS (
                  SELECT 1 FROM session s JOIN runner r ON r.id = s.assigned_runner_id
                   WHERE s.workspace_id = n.id AND s.status = ''PENDING'' AND s.started_at IS NULL
                     AND r.min_free_disk_mb > 0
                     AND (n.work_dir_free_bytes IS NOT NULL AND n.work_dir_free_bytes < r.min_free_disk_mb::bigint * 1048576)
                         IS DISTINCT FROM
                         (d.work_dir_free_bytes IS NOT NULL AND d.work_dir_free_bytes < r.min_free_disk_mb::bigint * 1048576))))
       SELECT new_owner FROM moved UNION SELECT old_owner FROM moved'
      USING ARRAY[
        'work_dir_exists', 'work_dir_is_git', 'work_dir_probed_at', 'work_dir_free_bytes', 'work_dir_total_bytes',
        'repo_url'
      ]::text[]
    LOOP
      PERFORM open_list_bump(o, src);
    END LOOP;
    RETURN NULL;
  END IF;

  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT owner_id FROM new_rows'
      WHEN 'DELETE' THEN 'SELECT DISTINCT owner_id FROM old_rows'
      ELSE 'SELECT owner_id FROM new_rows UNION SELECT owner_id FROM old_rows'
    END
  LOOP
    PERFORM open_list_bump(o, src);
  END LOOP;
  RETURN NULL;
END $$;
