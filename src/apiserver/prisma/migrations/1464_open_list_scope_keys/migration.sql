-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- The Open list's counters (0484/0487) say WHICH workspace moved, so `sessions.list_changed` can name
-- it (docs/list-freshness-scope-hints.md §5.1, Option A) and a web tab showing one workspace's Open
-- list reads it only when that workspace, or the whole account, moved.
--
-- WHAT WAS WRONG
-- --------------
-- Every counter was the account's: a drawn write in any workspace moved the same sum, the hint poller
-- (realtime/open-list-hints.ts) told every stream, and every Open list on screen was read. On
-- 2026-11-22, 16:18:45–16:33Z, a tab showing a quiet workspace read its Open list 350 times in 14
-- minutes; 349 of those reads came back unchanged while 3 sessions ran in other workspaces.
--
-- WHAT CHANGES
-- ------------
-- The sources that hang on one session or one workspace bump a key that names it,
-- `<source>@w:<workspace uuid>` or `<source>@c:<workspace uuid>`, with 0487's shard suffix after it
-- (`session@w:…#12`):
--   * `session` (the row itself), `conversation_turn`, `approval`, `session_tag_link`,
--     `scheduled_wakeup` (through the row's session) and `watch` (through its observer session):
--     `w:` when the session is in an Open list on either side of the statement — a CONVERSATION,
--     neither completed, archived nor deleted, no Ask, no scheduled run and no schedule-change conversation (sessions.service.ts
--     listShape) — and `c:` otherwise;
--   * `workspace`: `w:` and the workspace row's own id, always;
--   * `session_request` (the request rule): both of its sessions' scopes, the asker's and the
--     recipient's, since an open request shows the peer on both rows.
-- A session with no workspace, or one a request or watch names but that is gone, bumps the plain
-- account key, as every write did before.
--
-- The root rule: an Open row reads its root session's kind and the projects of the root's tasks, and
-- the root can sit in another workspace. So a session UPDATE that changes `owner_id`, `kind`,
-- `task_id`, `context_task_id`, `root_session_id` or `workspace_id` also bumps the account-wide
-- `session` key, and so does a DELETE of a session another session names as its root (the column has
-- no foreign key, so the child's row reads differently without being written).
--
-- Every other source keeps its account key. 1420's, 1428's, 0512's and 0641's compares are carried
-- over unchanged: a write that changes no drawn column still bumps nothing.
--
-- A statement that writes rows of k scopes makes k bumps where it made one; a statement in one scope
-- (the ingest path's) still makes one.
--
-- WHAT READS THEM
-- ---------------
-- The version and the probe (sessions/open-list-version.ts) add the counters up per base source,
-- `split_part(split_part(source, '#', 1), '@', 1)`, so `epochs`, the version and
-- `openListMovesAreRowLocal` see what they saw before. The poller reads them per key. An apiserver
-- still on the old aggregation reads `session@w:…` as an unknown source: its `since=` reads build
-- whole until it stops, and its sums still move with every bump.
--
-- A bump still waits for nobody (0487): every compare and join below reads the statement's
-- transition tables and the session rows they name, plain reads that take no row lock; only
-- `open_list_bump` takes a lock, and it is unchanged — only the keys it is called with are new.
--
-- WHY NO DDL
-- ----------
-- As in 0487, 0512, 1420 and 1428, only functions are replaced: `open_list_bump_session` and
-- `open_list_bump_via_session` (1420), `open_list_bump_owner` (1428) and `open_list_bump_watch`
-- (0641), plus one new helper, `open_list_scope_key`. Their names, arguments and every trigger stay,
-- `open_list_epoch` and its primary key (owner_id, source) are untouched, so no table is locked. A
-- statement already inside an old function finishes on it.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- The key one bump of `src` takes for a row of workspace `ws`: the account's own when there is no
-- workspace to name. Pure, so the planner inlines it.
CREATE OR REPLACE FUNCTION open_list_scope_key(src text, ws uuid, listed boolean) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ws IS NULL THEN src
              WHEN listed THEN src || '@w:' || ws::text
              ELSE src || '@c:' || ws::text END
$$;

-- The session's own row: CONVERSATION rows only, as in 0484; an UPDATE only for a row that changed in
-- a column some Open list draws, as in 1420.
CREATE OR REPLACE FUNCTION open_list_bump_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o uuid;
  k text;
  -- OPEN_LIST_UNDRAWN_SESSION_COLUMNS (sessions/open-list-version.ts), as 1420 lists them.
  undrawn CONSTANT text[] := ARRAY[
      'updated_at',
      'context_tokens', 'context_window', 'agent_tools', 'engine_usage_totals',
      'coordinator_context_epoch', 'coordinator_context_ack_key',
      'isolation_status', 'base_sha', 'changed_files', 'worktree_dirty', 'worktree_branch', 'branch_sha',
      'branch_merged', 'merge_targets', 'branch_commits',
      'recap_claimed_at', 'recap_event_seq', 'alerted_approval_at', 'agent_notified_at',
      'inbox_lease_owner', 'inbox_lease_generation', 'inbox_request_id', 'inbox_request_turn_id', 'claim_request_id',
      'retry_attempts', 'retry_claimed_at'
    ]::text[];
BEGIN
  -- An UPDATE, the ingest path's statement, is static SQL so its plan is kept between statements; INSERT and
  -- DELETE stay behind EXECUTE, which keeps a transition table the event does not have out of the parse path.
  IF TG_OP = 'UPDATE' THEN
    FOR o, k IN
      WITH moved AS (
          SELECT n.owner_id AS new_owner, n.kind AS new_kind, n.workspace_id AS new_ws,
                 (n.completed_at IS NULL AND n.archived_at IS NULL AND n.deleted_at IS NULL
                  AND n.help_ask IS NULL AND n.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')) AS new_listed,
                 d.owner_id AS old_owner, d.kind AS old_kind, d.workspace_id AS old_ws,
                 (d.completed_at IS NULL AND d.archived_at IS NULL AND d.deleted_at IS NULL
                  AND d.help_ask IS NULL AND d.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')) AS old_listed,
                 (n.owner_id, n.kind, n.task_id, n.context_task_id, n.root_session_id, n.workspace_id)
                   IS DISTINCT FROM
                 (d.owner_id, d.kind, d.task_id, d.context_task_id, d.root_session_id, d.workspace_id) AS rerooted
            FROM new_rows n JOIN old_rows d ON d.id = n.id
           WHERE (to_jsonb(n) - undrawn) IS DISTINCT FROM (to_jsonb(d) - undrawn)),
        sides AS (
          SELECT new_owner AS owner_id, new_ws AS ws, new_listed AS listed FROM moved WHERE new_kind = 'CONVERSATION'
          UNION ALL
          SELECT old_owner, old_ws, old_listed FROM moved WHERE old_kind = 'CONVERSATION')
        SELECT owner_id, open_list_scope_key('session', ws, bool_or(listed)) FROM sides GROUP BY owner_id, ws
        UNION
        SELECT new_owner, 'session' FROM moved
         WHERE rerooted AND (new_kind = 'CONVERSATION' OR old_kind = 'CONVERSATION')
        UNION
        SELECT old_owner, 'session' FROM moved
         WHERE rerooted AND (new_kind = 'CONVERSATION' OR old_kind = 'CONVERSATION')
    LOOP
      PERFORM open_list_bump(o, k);
    END LOOP;
    RETURN NULL;
  END IF;

  FOR o, k IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN $q$
        SELECT n.owner_id, open_list_scope_key('session', n.workspace_id, bool_or(
                 n.completed_at IS NULL AND n.archived_at IS NULL AND n.deleted_at IS NULL
                 AND n.help_ask IS NULL AND n.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM new_rows n WHERE n.kind = 'CONVERSATION'
         GROUP BY n.owner_id, n.workspace_id $q$
      WHEN 'DELETE' THEN $q$
        SELECT d.owner_id, open_list_scope_key('session', d.workspace_id, bool_or(
                 d.completed_at IS NULL AND d.archived_at IS NULL AND d.deleted_at IS NULL
                 AND d.help_ask IS NULL AND d.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM old_rows d WHERE d.kind = 'CONVERSATION'
         GROUP BY d.owner_id, d.workspace_id
        UNION
        SELECT d.owner_id, 'session'
          FROM old_rows d
         WHERE d.kind = 'CONVERSATION'
           AND EXISTS (SELECT 1 FROM session c WHERE c.root_session_id = d.id AND c.id <> d.id) $q$
    END
  LOOP
    PERFORM open_list_bump(o, k);
  END LOOP;
  RETURN NULL;
END $$;

-- Tables whose owner is the session they belong to (approval, session_tag_link, conversation_turn,
-- session_scheduled_wakeup), keyed by that session's scope as it reads now. Only a turn's UPDATE
-- compares, as in 1420; a row whose session is gone bumps nothing, as before.
CREATE OR REPLACE FUNCTION open_list_bump_via_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
  k text;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'conversation_turn' THEN
    FOR o, k IN EXECUTE $q$
      WITH moved AS (
        SELECT n.session_id AS new_session, d.session_id AS old_session
          FROM new_rows n JOIN old_rows d ON d.id = n.id
         WHERE (to_jsonb(n) - $1) IS DISTINCT FROM (to_jsonb(d) - $1)),
      ids AS (SELECT new_session AS id FROM moved UNION SELECT old_session FROM moved)
      SELECT s.owner_id, open_list_scope_key($2, s.workspace_id, bool_or(
               s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
               AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
        FROM ids JOIN session s ON s.id = ids.id
       GROUP BY s.owner_id, s.workspace_id $q$
      USING ARRAY[
        'delivery_status', 'delivery_failure_code', 'delivery_failure_reason', 'delivery_terminal_at',
        'delivery_acknowledged_at', 'lease_deadline_at', 'lease_generation',
        'display_prompt', 'translation_state', 'translation_lang', 'translation_failure_reason', 'translation_http_status',
        'wiki_context', 'coordinator_context_key'
      ]::text[], src
    LOOP
      PERFORM open_list_bump(o, k);
    END LOOP;
    RETURN NULL;
  END IF;

  FOR o, k IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN $q$
        WITH ids AS (SELECT DISTINCT session_id AS id FROM new_rows)
        SELECT s.owner_id, open_list_scope_key($1, s.workspace_id, bool_or(
                 s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                 AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM ids JOIN session s ON s.id = ids.id
         GROUP BY s.owner_id, s.workspace_id $q$
      WHEN 'DELETE' THEN $q$
        WITH ids AS (SELECT DISTINCT session_id AS id FROM old_rows)
        SELECT s.owner_id, open_list_scope_key($1, s.workspace_id, bool_or(
                 s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                 AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM ids JOIN session s ON s.id = ids.id
         GROUP BY s.owner_id, s.workspace_id $q$
      ELSE $q$
        WITH ids AS (SELECT session_id AS id FROM new_rows UNION SELECT session_id FROM old_rows)
        SELECT s.owner_id, open_list_scope_key($1, s.workspace_id, bool_or(
                 s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                 AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM ids JOIN session s ON s.id = ids.id
         GROUP BY s.owner_id, s.workspace_id $q$
    END
    USING src
  LOOP
    PERFORM open_list_bump(o, k);
  END LOOP;
  RETURN NULL;
END $$;

-- Tables with an owner_id of their own. `workspace` is keyed by the workspace row and keeps 1428's
-- compare; `session_request` is keyed by both of its sessions (the request rule); 0512's
-- `project_integration_job` branch and every other table are carried over unchanged, on the account key.
CREATE OR REPLACE FUNCTION open_list_bump_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
  k text;
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

  IF TG_TABLE_NAME = 'workspace' THEN
    FOR o, k IN EXECUTE CASE TG_OP
        WHEN 'INSERT' THEN $q$
          SELECT DISTINCT owner_id, open_list_scope_key('workspace', id, true) FROM new_rows $q$
        WHEN 'DELETE' THEN $q$
          SELECT DISTINCT owner_id, open_list_scope_key('workspace', id, true) FROM old_rows $q$
        ELSE $q$
          WITH moved AS (
            SELECT n.id, n.owner_id AS new_owner, d.owner_id AS old_owner
              FROM new_rows n JOIN old_rows d ON d.id = n.id
             WHERE (to_jsonb(n) - $1) IS DISTINCT FROM (to_jsonb(d) - $1)
                OR (n.work_dir_free_bytes IS DISTINCT FROM d.work_dir_free_bytes AND EXISTS (
                     SELECT 1 FROM session s JOIN runner r ON r.id = s.assigned_runner_id
                      WHERE s.workspace_id = n.id AND s.status = 'PENDING' AND s.started_at IS NULL
                        AND r.min_free_disk_mb > 0
                        AND (n.work_dir_free_bytes IS NOT NULL AND n.work_dir_free_bytes < r.min_free_disk_mb::bigint * 1048576)
                            IS DISTINCT FROM
                            (d.work_dir_free_bytes IS NOT NULL AND d.work_dir_free_bytes < r.min_free_disk_mb::bigint * 1048576))))
          SELECT new_owner, open_list_scope_key('workspace', id, true) FROM moved
          UNION
          SELECT old_owner, open_list_scope_key('workspace', id, true) FROM moved $q$
      END
      USING ARRAY[
        'work_dir_exists', 'work_dir_is_git', 'work_dir_probed_at', 'work_dir_free_bytes', 'work_dir_total_bytes',
        'repo_url'
      ]::text[]
    LOOP
      PERFORM open_list_bump(o, k);
    END LOOP;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'session_request' THEN
    FOR o, k IN EXECUTE CASE TG_OP
        WHEN 'INSERT' THEN $q$
          WITH peers AS (SELECT owner_id, from_session_id AS id FROM new_rows
                         UNION SELECT owner_id, to_session_id FROM new_rows)
          SELECT p.owner_id, open_list_scope_key('session_request', s.workspace_id, bool_or(
                   s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                   AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
            FROM peers p LEFT JOIN session s ON s.id = p.id
           GROUP BY p.owner_id, s.workspace_id $q$
        WHEN 'DELETE' THEN $q$
          WITH peers AS (SELECT owner_id, from_session_id AS id FROM old_rows
                         UNION SELECT owner_id, to_session_id FROM old_rows)
          SELECT p.owner_id, open_list_scope_key('session_request', s.workspace_id, bool_or(
                   s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                   AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
            FROM peers p LEFT JOIN session s ON s.id = p.id
           GROUP BY p.owner_id, s.workspace_id $q$
        ELSE $q$
          WITH peers AS (SELECT owner_id, from_session_id AS id FROM new_rows
                         UNION SELECT owner_id, to_session_id FROM new_rows
                         UNION SELECT owner_id, from_session_id FROM old_rows
                         UNION SELECT owner_id, to_session_id FROM old_rows)
          SELECT p.owner_id, open_list_scope_key('session_request', s.workspace_id, bool_or(
                   s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                   AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
            FROM peers p LEFT JOIN session s ON s.id = p.id
           GROUP BY p.owner_id, s.workspace_id $q$
      END
    LOOP
      PERFORM open_list_bump(o, k);
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

-- A watch: only a RESUME_SESSION watch with an observer counts, and an UPDATE only when its state,
-- action or observer moved (0641), now keyed by the observer session's scope — the old observer's
-- and the new one's when it moved, the old owner's on an owner change.
CREATE OR REPLACE FUNCTION open_list_bump_watch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
  k text;
BEGIN
  FOR o, k IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN $q$
        SELECT w.owner_id, open_list_scope_key($1, s.workspace_id, bool_or(
                 s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                 AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM new_rows w LEFT JOIN session s ON s.id = w.observer_session_id
         WHERE w.action = 'RESUME_SESSION' AND w.observer_session_id IS NOT NULL
         GROUP BY w.owner_id, s.workspace_id $q$
      WHEN 'DELETE' THEN $q$
        SELECT w.owner_id, open_list_scope_key($1, s.workspace_id, bool_or(
                 s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                 AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM old_rows w LEFT JOIN session s ON s.id = w.observer_session_id
         WHERE w.action = 'RESUME_SESSION' AND w.observer_session_id IS NOT NULL
         GROUP BY w.owner_id, s.workspace_id $q$
      ELSE $q$
        WITH changed AS (
          SELECT n.owner_id, n.observer_session_id AS new_observer, p.observer_session_id AS old_observer
            FROM new_rows n JOIN old_rows p ON p.id = n.id
           WHERE (n.action = 'RESUME_SESSION' OR p.action = 'RESUME_SESSION')
             AND (n.state, n.action, n.observer_session_id)
                 IS DISTINCT FROM (p.state, p.action, p.observer_session_id)),
        moved AS (
          SELECT owner_id, new_observer AS id FROM changed
          UNION SELECT owner_id, old_observer FROM changed
          UNION SELECT p.owner_id, p.observer_session_id FROM new_rows n JOIN old_rows p ON p.id = n.id
                 WHERE n.owner_id IS DISTINCT FROM p.owner_id)
        SELECT m.owner_id, open_list_scope_key($1, s.workspace_id, bool_or(
                 s.kind = 'CONVERSATION' AND s.completed_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL
                 AND s.help_ask IS NULL AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE')))
          FROM moved m LEFT JOIN session s ON s.id = m.id
         GROUP BY m.owner_id, s.workspace_id $q$
    END
    USING src
  LOOP
    PERFORM open_list_bump(o, k);
  END LOOP;
  RETURN NULL;
END $$;
