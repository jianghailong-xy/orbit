-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A write that changes no field an Open list draws no longer moves the list's version (0484/0487),
-- and so no longer sends `sessions.list_changed` (realtime/open-list-hints.ts).
--
-- WHAT WAS WRONG
-- --------------
-- Every UPDATE of a session row or a conversation turn bumped the account's counter, whatever
-- column it touched. A running session writes its row on nearly every event batch and from every
-- heartbeat that carries a worktree snapshot, and much of that is the context gauge, the worktree
-- snapshot, `updated_at` and values written over themselves. On 2026-11-21, with 6 sessions
-- running, the owner's web tab was hinted about once a second and read its Open list 38 times a
-- minute. open-list-undrawn-writes.pg.spec.ts replays a running turn and lists, column by column,
-- what it writes.
--
-- WHAT CHANGES
-- ------------
-- For UPDATE on `session` and on `conversation_turn` only, an owner is bumped for a row whose new
-- and old versions differ in anything but the columns no Open list reads, the same compare 0512
-- makes for a landing's renewal and 0641 for a watch. Those columns are
-- OPEN_LIST_UNDRAWN_SESSION_COLUMNS and OPEN_LIST_UNDRAWN_TURN_COLUMNS in sessions/open-list-version.ts,
-- listed again below. Every other column bumps as before — including one added after this
-- migration — and so does every INSERT and DELETE, every other table, and an owner, kind or
-- session change, which differs in a drawn column by itself.
--
-- A bump still waits for nobody (0487): the compare reads the statement's transition tables and,
-- for a turn, the session row it already joined to find the owner; only `open_list_bump` takes a
-- lock, and it is unchanged.
--
-- WHY NO DDL
-- ----------
-- As in 0487 and 0512, only `open_list_bump_session` and `open_list_bump_via_session` are replaced;
-- their names, arguments and every trigger stay, so no table is locked. A statement already inside
-- the old function finishes on it.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- The session's own row: the flat list counts only CONVERSATION rows, as in 0484.
CREATE OR REPLACE FUNCTION open_list_bump_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o uuid;
BEGIN
  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT owner_id FROM new_rows WHERE kind = ''CONVERSATION'''
      WHEN 'DELETE' THEN 'SELECT DISTINCT owner_id FROM old_rows WHERE kind = ''CONVERSATION'''
      ELSE 'WITH moved AS (
              SELECT n.owner_id AS new_owner, n.kind AS new_kind, d.owner_id AS old_owner, d.kind AS old_kind
                FROM new_rows n JOIN old_rows d ON d.id = n.id
               WHERE (to_jsonb(n) - $1) IS DISTINCT FROM (to_jsonb(d) - $1))
            SELECT new_owner FROM moved WHERE new_kind = ''CONVERSATION''
            UNION SELECT old_owner FROM moved WHERE old_kind = ''CONVERSATION'''
    END
    USING ARRAY[
      'updated_at',
      'context_tokens', 'context_window', 'agent_tools', 'engine_usage_totals',
      'coordinator_context_epoch', 'coordinator_context_ack_key',
      'isolation_status', 'base_sha', 'changed_files', 'worktree_dirty', 'worktree_branch', 'branch_sha',
      'branch_merged', 'merge_targets', 'branch_commits',
      'recap_claimed_at', 'recap_event_seq', 'alerted_approval_at', 'agent_notified_at',
      'inbox_lease_owner', 'inbox_lease_generation', 'inbox_request_id', 'inbox_request_turn_id', 'claim_request_id',
      'retry_attempts', 'retry_claimed_at'
    ]::text[]
  LOOP
    PERFORM open_list_bump(o, 'session');
  END LOOP;
  RETURN NULL;
END $$;

-- Tables whose owner is the session they belong to. Only a turn's UPDATE compares; the approval,
-- tag-link and scheduled-wakeup sources bump as in 0487.
CREATE OR REPLACE FUNCTION open_list_bump_via_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'conversation_turn' THEN
    FOR o IN EXECUTE
      'WITH moved AS (
         SELECT n.session_id AS new_session, d.session_id AS old_session
           FROM new_rows n JOIN old_rows d ON d.id = n.id
          WHERE (to_jsonb(n) - $1) IS DISTINCT FROM (to_jsonb(d) - $1))
       SELECT s.owner_id FROM moved m JOIN session s ON s.id = m.new_session
       UNION SELECT s.owner_id FROM moved m JOIN session s ON s.id = m.old_session'
      USING ARRAY[
        'delivery_status', 'delivery_failure_code', 'delivery_failure_reason', 'delivery_terminal_at',
        'delivery_acknowledged_at', 'lease_deadline_at', 'lease_generation',
        'display_prompt', 'translation_state', 'translation_lang', 'translation_failure_reason', 'translation_http_status',
        'wiki_context', 'coordinator_context_key'
      ]::text[]
    LOOP
      PERFORM open_list_bump(o, src);
    END LOOP;
    RETURN NULL;
  END IF;

  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT s.owner_id FROM new_rows r JOIN session s ON s.id = r.session_id'
      WHEN 'DELETE' THEN 'SELECT DISTINCT s.owner_id FROM old_rows r JOIN session s ON s.id = r.session_id'
      ELSE 'SELECT s.owner_id FROM new_rows r JOIN session s ON s.id = r.session_id
            UNION SELECT s.owner_id FROM old_rows r JOIN session s ON s.id = r.session_id'
    END
  LOOP
    PERFORM open_list_bump(o, src);
  END LOOP;
  RETURN NULL;
END $$;
