-- Renumbered to keep migration numbers unique. CREATE OR REPLACE permits replay
-- in environments that already applied this function under the earlier number.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A landing's lease renewal no longer moves the Open list's version (0484/0487).
--
-- WHAT WAS WRONG
-- --------------
-- A v2 integration claim renews its `project_integration_job` row every few seconds while a landing
-- runs (§2.2 J-T4). Before 0484 the version hashed a RUNNING job WITHOUT the columns only a renewal
-- writes, so a renewal left it alone. 0484's per-statement counter bumps on every UPDATE of the
-- table, so every renewal moved the version, failed every client's If-None-Match, and made each
-- poll build the whole list for as long as any landing of the account ran.
-- integration-job-progress-v2.pg.spec.ts (6) pins the old rule and has been red since 0484.
--
-- WHAT CHANGES
-- ------------
-- For UPDATE on `project_integration_job` only, the owner is bumped when one of its rows changed in
-- anything but the renewal columns, or was not RUNNING on either side of the statement (a finished
-- row's every write counts, and a state change counts by itself). The renewal columns are the ones
-- the old hash left out: heartbeat_at, updated_at, phase, round, step, step_started_at,
-- output_moved_at and current_check. Every other table and every other event is unchanged.
--
-- WHY NO DDL
-- ----------
-- As in 0487, only `open_list_bump_owner` is replaced; its name, arguments and every trigger stay,
-- so no table is locked. A statement already inside the old function finishes on it.
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
