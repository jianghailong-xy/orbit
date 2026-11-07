-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- The Open list's version counters (0484), without the queue they put every writer of an account in.
--
-- WHAT WAS WRONG
-- --------------
-- 0484 kept one counter row per (owner, source) and bumped it with INSERT … ON CONFLICT DO UPDATE
-- inside the writing transaction. That takes the row's lock and keeps it until the writer commits:
--   * every write of one account to one source table waited for every other one still open, even
--     on rows the two never shared. The runner link's ingest writes its Session rows before its
--     run_event insert and commits after it, so the account's session counter was held for that
--     whole insert, and every other session write of the account (another runner's ingest, the
--     person's own actions) queued behind it;
--   * two transactions writing two source tables in opposite orders deadlocked on the counters.
--     They are taken in the order statements WRITE, which no rank in common/lock-order.ts governs,
--     so taking rows in rank order beforehand did not prevent it.
-- open-list-version.pg.spec.ts reproduces both, and passes only on the functions below.
--
-- WHAT CHANGES
-- ------------
-- One (owner, source) counter may now be spread over several rows: the one 0484 created, keyed
-- `<source>`, and any number keyed `<source>#<n>`. A bump takes whichever of them no other
-- transaction holds (FOR UPDATE SKIP LOCKED; a row this transaction already holds is not skipped)
-- and adds one to it. Only when every one of them is held by another transaction does it insert
-- another row, keyed by a sequence value no other transaction can be inserting. So a bump never
-- waits for another transaction and adds no edge to anyone's wait graph. A source keeps at most as
-- many rows as it ever had writers open at once, which the connection pools bound; none is deleted.
--
-- The probe (sessions/open-list-version.ts) reads sum(epoch) per source. Every committed bump adds
-- exactly one to exactly one row, so the sum moves with every committed write of the source and
-- with nothing else. 0484's guarantee is unchanged: it may move when the list did not; it cannot
-- lag a write.
--
-- An UPDATE now bumps each owner once per statement. 0484 bumped the new and then the old owner
-- set, so every UPDATE bumped its owner twice.
--
-- WHY NO DDL ON open_list_epoch
-- -----------------------------
-- The table, its primary key (owner_id, source) and every trigger stay as 0484 made them; only the
-- functions are replaced, which locks no table. Changing the key would queue every writer of the
-- 29 tables behind the ALTER, and a statement already inside 0484's function at that moment would
-- then fail on its `ON CONFLICT (owner_id, source)`. With the key unchanged that statement still
-- finds its arbiter, and an apiserver still running 0484's probe during the rollout reads every row,
-- the new ones included, so it sees every bump as well.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE "open_list_epoch_shard_seq";

-- One bump of one (owner, source) counter. It never waits for another transaction: the SELECT
-- skips every row another transaction holds, the UPDATE writes the row this one now holds, and the
-- INSERT's key is new. `picked` is the row's full key, `<source>` or `<source>#<n>`.
CREATE FUNCTION open_list_bump(o uuid, src text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  picked text;
BEGIN
  SELECT e.source INTO picked
    FROM open_list_epoch e
   WHERE e.owner_id = o
     AND (e.source = src OR starts_with(e.source, src || '#'))
   ORDER BY e.source
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE open_list_epoch SET epoch = epoch + 1 WHERE owner_id = o AND source = picked;
  ELSE
    INSERT INTO open_list_epoch (owner_id, source, epoch)
    VALUES (o, src || '#' || nextval('open_list_epoch_shard_seq'), 1);
  END IF;
END $$;

-- The four trigger functions keep their names, arguments and owner sets; each owner of the
-- statement's transition tables is bumped once, through open_list_bump. EXECUTE still keeps a
-- transition table the current event does not have out of the parse path.
CREATE OR REPLACE FUNCTION open_list_bump_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
BEGIN
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

CREATE OR REPLACE FUNCTION open_list_bump_via_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
BEGIN
  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT p.owner_id FROM new_rows r JOIN project p ON p.id = r.project_id'
      WHEN 'DELETE' THEN 'SELECT DISTINCT p.owner_id FROM old_rows r JOIN project p ON p.id = r.project_id'
      ELSE 'SELECT p.owner_id FROM new_rows r JOIN project p ON p.id = r.project_id
            UNION SELECT p.owner_id FROM old_rows r JOIN project p ON p.id = r.project_id'
    END
  LOOP
    PERFORM open_list_bump(o, src);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION open_list_bump_via_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  o uuid;
BEGIN
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

-- A session's own row: the flat list counts only CONVERSATION rows, as in 0484.
CREATE OR REPLACE FUNCTION open_list_bump_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o uuid;
BEGIN
  FOR o IN EXECUTE CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT DISTINCT owner_id FROM new_rows WHERE kind = ''CONVERSATION'''
      WHEN 'DELETE' THEN 'SELECT DISTINCT owner_id FROM old_rows WHERE kind = ''CONVERSATION'''
      ELSE 'SELECT owner_id FROM new_rows WHERE kind = ''CONVERSATION''
            UNION SELECT owner_id FROM old_rows WHERE kind = ''CONVERSATION'''
    END
  LOOP
    PERFORM open_list_bump(o, 'session');
  END LOOP;
  RETURN NULL;
END $$;
