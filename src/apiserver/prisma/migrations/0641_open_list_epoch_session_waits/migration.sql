-- The Open list row now says what a parked session is still doing (`activity`,
-- sessions/task-work-carrier.ts sessionActivitySql), and two of the wake sources it reads live in
-- tables of their own: the watches a session observes and its scheduled wake-ups. Every table the
-- row reads is a source of the list's version (open-list-version.ts), or a wake-up armed on a
-- parked session would be answered 304 over a row still saying "Waiting for your reply".

-- A scheduled wake-up belongs to its session: armed, delivered, cancelled — each moves the row.
CREATE TRIGGER "session_scheduled_wakeup_open_list_epoch_insert" AFTER INSERT ON "session_scheduled_wakeup"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('scheduled_wakeup');

CREATE TRIGGER "session_scheduled_wakeup_open_list_epoch_update" AFTER UPDATE ON "session_scheduled_wakeup"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('scheduled_wakeup');

CREATE TRIGGER "session_scheduled_wakeup_open_list_epoch_delete" AFTER DELETE ON "session_scheduled_wakeup"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_via_session('scheduled_wakeup');

-- A watch is evaluated on a clock and writes `last_evaluated_at` / `next_evaluate_at` every time,
-- which the row never shows: bumping on those would turn every poll of an account with a live
-- watch into a 200. So only a RESUME_SESSION watch with an observer counts, and an update only when
-- what the row reads of it — its state, its action, its observer — moved. (A column-list UPDATE
-- trigger cannot carry transition tables, hence the comparison here.)
CREATE OR REPLACE FUNCTION open_list_bump_watch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
BEGIN
  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT owner_id FROM new_rows
                           WHERE action = ''RESUME_SESSION'' AND observer_session_id IS NOT NULL'
      WHEN 'DELETE' THEN 'SELECT DISTINCT owner_id FROM old_rows
                           WHERE action = ''RESUME_SESSION'' AND observer_session_id IS NOT NULL'
      ELSE 'SELECT n.owner_id FROM new_rows n JOIN old_rows p ON p.id = n.id
             WHERE (n.action = ''RESUME_SESSION'' OR p.action = ''RESUME_SESSION'')
               AND (n.state, n.action, n.observer_session_id)
                   IS DISTINCT FROM (p.state, p.action, p.observer_session_id)
            UNION SELECT p.owner_id FROM new_rows n JOIN old_rows p ON p.id = n.id
             WHERE n.owner_id IS DISTINCT FROM p.owner_id'
    END
  LOOP
    PERFORM open_list_bump(o, src);
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER "watch_open_list_epoch_insert" AFTER INSERT ON "watch"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_watch('watch');

CREATE TRIGGER "watch_open_list_epoch_update" AFTER UPDATE ON "watch"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_watch('watch');

CREATE TRIGGER "watch_open_list_epoch_delete" AFTER DELETE ON "watch"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_watch('watch');
