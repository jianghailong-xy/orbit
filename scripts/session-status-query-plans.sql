-- The query plans of docs/session-status-retirement-plan.md §4.5: every query it names, spelled on the stored word
-- (`word`, what the code before deploy D2 sends) and on the facts (`facts`, the plan's §2.1 translation), run with
-- EXPLAIN (ANALYZE, BUFFERS) for the runner with the most sessions.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-status-query-plans.sql
--
-- Options:
--   -v plans=1        also print each query's text plan
--   -v without_old=1  first drop the six indexes on session.status that go with the column in D4, so the `facts`
--                     queries are measured on the end state (the `word` queries are then meaningless)
--   -v writes=1       also measure the write cost of session_zz_phase and the share of HOT updates
--
-- It needs migrations up to 1612 (the columns), and measures whatever indexes the database holds: run it before and
-- after the D2 index migrations to compare. Everything runs in one transaction that is ROLLED BACK, and every
-- statement that writes is undone as soon as it has been measured. `without_old` and `writes` take table locks on
-- session: use those two on a rehearsal copy or a throwaway database only, never on a database that serves.
-- scripts/session-status-query-plans-seed.sql seeds a throwaway one.
-- docs/session-status-query-plans.md records what it showed.
--
-- Reading the summary: `buffers` is shared blocks hit + read by the whole statement (the second of two runs);
-- `intended` names the indexes the plan means this query to use, and `uses_intended` says whether the plan used one.
-- A `facts` row with no intended index is measured for its buffers only: the batch cap re-stamp, and
-- ?status=SUCCEEDED and CANCELLED, which no index answers (most of an owner's released rows are theirs).

\set QUIET 1
\if :{?plans}
\else
  \set plans 0
\endif
\if :{?writes}
\else
  \set writes 0
\endif
\if :{?without_old}
\else
  \set without_old 0
\endif
\pset pager off

BEGIN;
SET LOCAL statement_timeout = '120s';
-- The claim UPDATE passes the engine guards as the current claim does.
SELECT set_config('orbit.claim_reads_session_engine', '1', true) \gset ignored_

\if :without_old
  SET LOCAL lock_timeout = '2s';
  DROP INDEX IF EXISTS "session_status_idx", "session_assigned_runner_id_status_idx", "session_batch_id_status_idx",
    "session_owner_status_task_idx", "session_root_session_id_status_idx", "session_over_capacity_pending_idx";
\endif

-- ── What is measured ────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE plan_target ON COMMIT DROP AS
WITH busy AS (
  SELECT s."assigned_runner_id" AS runner FROM "session" s
   WHERE s."assigned_runner_id" IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1
), mine AS (
  SELECT s.* FROM "session" s, busy WHERE s."assigned_runner_id" = busy.runner
)
SELECT
  (SELECT runner FROM busy) AS runner,
  (SELECT r."owner_id" FROM "runner" r, busy WHERE r."id" = busy.runner) AS owner,
  (SELECT "batch_id" FROM mine WHERE "batch_id" IS NOT NULL AND "finished_at" IS NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS batch,
  (SELECT "root_session_id" FROM mine WHERE "root_session_id" IS NOT NULL AND "finished_at" IS NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS root,
  (SELECT COALESCE("claim_request_id", 'none') FROM mine WHERE "finished_at" IS NULL
    ORDER BY ("claim_request_id" IS NULL) LIMIT 1) AS claim_request,
  (SELECT COALESCE(array_agg("id"), '{}') FROM (SELECT "id" FROM mine WHERE "finished_at" IS NULL ORDER BY "id" LIMIT 40) x)
    AS supervised,
  (SELECT COALESCE(array_agg("task_id"), '{}') FROM (SELECT DISTINCT "task_id" FROM mine WHERE "task_id" IS NOT NULL
    ORDER BY 1 LIMIT 50) x) AS tasks,
  (SELECT "task_id" FROM mine WHERE "task_id" IS NOT NULL AND "finished_at" IS NULL LIMIT 1) AS task,
  (SELECT t."list_id" FROM mine m JOIN "task" t ON t."id" = m."task_id" WHERE t."list_id" IS NOT NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS list;

\echo '== the target =='
SELECT (SELECT count(*) FROM "session") AS sessions,
       (SELECT count(*) FROM "session" WHERE "finished_at" IS NULL) AS held,
       (SELECT count(*) FROM "session" s WHERE s."assigned_runner_id" = t.runner) AS runner_sessions,
       (SELECT count(*) FROM "session" s WHERE s."assigned_runner_id" = t.runner AND s."finished_at" IS NULL) AS runner_held
  FROM plan_target t;
\echo '== indexes on session that name a state column =='
SELECT indexname, regexp_replace(indexdef, '^.* USING btree ', '') AS definition
  FROM pg_indexes WHERE tablename = 'session' AND indexdef ~ '\m(status|turn_state|finished_at)\M' ORDER BY 1;

-- ── The measuring function ──────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE plan_result (
  seq serial, item text, query text, form text, intended text, used text, uses_intended text, buffers bigint,
  ms numeric, plan text
) ON COMMIT DROP;

-- {runner}, {owner}, … in the query are the target's values, written in as constants: the server's driver sends them as
-- parameters of an unnamed statement, which PostgreSQL plans with their values, as here.
CREATE FUNCTION pg_temp.measure(item text, label text, form text, intended text, q text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  t record;
  sql text;
  j jsonb;
  line text;
  body text := '';
  used text[];
  seq_scan boolean;
BEGIN
  SELECT * INTO t FROM plan_target;
  -- A target the data does not have (no held session with a batch, a tree, a task or a list) is the nil uuid, which
  -- matches no row: quote_literal(NULL) would turn the whole statement into NULL.
  sql := replace(q, '{runner}', quote_literal(t.runner) || '::uuid');
  sql := replace(sql, '{owner}', quote_literal(t.owner) || '::uuid');
  sql := replace(sql, '{batch}', quote_literal(COALESCE(t.batch, '00000000-0000-0000-0000-000000000000'::uuid)) || '::uuid');
  sql := replace(sql, '{root}', quote_literal(COALESCE(t.root, '00000000-0000-0000-0000-000000000000'::uuid)) || '::uuid');
  sql := replace(sql, '{claim_request}', quote_literal(t.claim_request));
  sql := replace(sql, '{supervised}', quote_literal(t.supervised) || '::uuid[]');
  sql := replace(sql, '{tasks}', quote_literal(t.tasks) || '::uuid[]');
  sql := replace(sql, '{task}', quote_literal(COALESCE(t.task, '00000000-0000-0000-0000-000000000000'::uuid)) || '::uuid');
  sql := replace(sql, '{list}', quote_literal(COALESCE(t.list, '00000000-0000-0000-0000-000000000000'::uuid)) || '::uuid');
  -- Twice, the first to warm the cache; each run is undone (the claim and the cap re-stamp write).
  FOR i IN 1..2 LOOP
    BEGIN
      EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || sql INTO j;
      RAISE EXCEPTION USING ERRCODE = 'P0099';
    EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
    END;
  END LOOP;
  BEGIN
    FOR line IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ' || sql LOOP
      body := body || line || E'\n';
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  SELECT COALESCE(array_agg(DISTINCT n #>> '{}' ORDER BY n #>> '{}'), '{}') INTO used
    FROM jsonb_path_query(j, 'strict $.**."Index Name"') n;
  seq_scan := jsonb_path_exists(j, 'strict $.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "session")');
  INSERT INTO plan_result (item, query, form, intended, used, uses_intended, buffers, ms, plan)
  VALUES (
    item, label, form, intended,
    concat_ws(' ', array_to_string(ARRAY(SELECT u FROM unnest(used) u WHERE u LIKE 'session%'), ' '),
              CASE WHEN seq_scan THEN 'SEQSCAN(session)' END),
    CASE WHEN intended IS NULL THEN ''
         WHEN used && string_to_array(intended, ' ') THEN 'yes' ELSE 'NO' END,
    (j -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::bigint + (j -> 0 -> 'Plan' ->> 'Shared Read Blocks')::bigint,
    round((j -> 0 ->> 'Execution Time')::numeric, 2),
    body);
END
$fn$;

-- The held statuses, as sessionHeldIndexedSql states them beside the release column.
\set held_word '(s.finished_at IS NULL AND s.status IN (''PENDING'', ''RUNNING'', ''AWAITING_INPUT'', ''INTERRUPTED''))'

-- ── 1. The claim (queue/queue.service.ts) ───────────────────────────────────────────────────────
-- The statement's session-side shape: the candidate, the three caps and the fair order. The credential, capability
-- and disk gates read other tables by the candidate's own columns and do not choose its access path.
SELECT pg_temp.measure('1', 'claim, caps off (candidate and order)', 'word', NULL, $q$
  UPDATE "session" SET status = 'RUNNING', updated_at = now() WHERE id = (
    SELECT s.id FROM "session" s
     WHERE s.status = 'PENDING' AND s.kind = 'CONVERSATION' AND s.cancel_requested_at IS NULL
       AND s.assigned_runner_id = {runner}
     ORDER BY (SELECT count(*) FROM "session" busy
                WHERE busy.root_session_id = s.root_session_id AND busy.status = 'RUNNING') ASC, s.created_at ASC
     FOR UPDATE NOWAIT LIMIT 1)
  RETURNING id $q$) \g /dev/null
SELECT pg_temp.measure('1', 'claim, caps off (candidate and order)', 'facts',
  'session_runner_turn_state_idx session_root_in_flight_idx', $q$
  UPDATE "session" SET status = 'RUNNING', turn_state = 'IN_FLIGHT', updated_at = now() WHERE id = (
    SELECT s.id FROM "session" s
     WHERE s.turn_state = 'QUEUED' AND s.kind = 'CONVERSATION' AND s.cancel_requested_at IS NULL
       AND s.assigned_runner_id = {runner}
     ORDER BY (SELECT count(*) FROM "session" busy
                WHERE busy.root_session_id = s.root_session_id AND busy.turn_state = 'IN_FLIGHT') ASC, s.created_at ASC
     FOR UPDATE NOWAIT LIMIT 1)
  RETURNING id $q$) \g /dev/null

SELECT pg_temp.measure('1', 'claim with the runner, batch and tree caps', 'word', NULL, $q$
  UPDATE "session" SET status = 'RUNNING', updated_at = now() WHERE id = (
    SELECT s.id FROM "session" s
     WHERE s.status = 'PENDING' AND s.kind = 'CONVERSATION' AND s.cancel_requested_at IS NULL
       AND s.assigned_runner_id = {runner}
       AND s.owner_id = (SELECT r.owner_id FROM "runner" r WHERE r.id = {runner})
       AND (SELECT count(*) FROM "session" active WHERE active.assigned_runner_id = {runner} AND active.status = 'RUNNING')
             < (SELECT r.max_concurrent FROM "runner" r WHERE r.id = {runner})
       AND (s.batch_id IS NULL OR (SELECT count(*) FROM "session" ba
              WHERE ba.batch_id = s.batch_id AND ba.status = 'RUNNING') < s.batch_max_concurrent)
       AND (s.root_session_id IS NULL OR (SELECT count(*) FROM "session" tree
              WHERE tree.root_session_id = s.root_session_id AND tree.status = 'RUNNING'
                AND NOT EXISTS (SELECT 1 FROM "session" child
                                 WHERE child.parent_session_id = tree.id AND child.status IN ('PENDING', 'RUNNING')))
              < GREATEST(1, (SELECT r.max_concurrent FROM "runner" r WHERE r.id = {runner}) - 1))
     ORDER BY (SELECT count(*) FROM "session" busy
                WHERE busy.root_session_id = s.root_session_id AND busy.status = 'RUNNING') ASC, s.created_at ASC
     FOR UPDATE NOWAIT LIMIT 1)
  RETURNING id $q$) \g /dev/null
SELECT pg_temp.measure('1', 'claim with the runner, batch and tree caps', 'facts',
  'session_runner_turn_state_idx session_batch_in_flight_idx session_root_in_flight_idx', $q$
  UPDATE "session" SET status = 'RUNNING', turn_state = 'IN_FLIGHT', updated_at = now() WHERE id = (
    SELECT s.id FROM "session" s
     WHERE s.turn_state = 'QUEUED' AND s.kind = 'CONVERSATION' AND s.cancel_requested_at IS NULL
       AND s.assigned_runner_id = {runner}
       AND s.owner_id = (SELECT r.owner_id FROM "runner" r WHERE r.id = {runner})
       AND (SELECT count(*) FROM "session" active WHERE active.assigned_runner_id = {runner} AND active.turn_state = 'IN_FLIGHT')
             < (SELECT r.max_concurrent FROM "runner" r WHERE r.id = {runner})
       AND (s.batch_id IS NULL OR (SELECT count(*) FROM "session" ba
              WHERE ba.batch_id = s.batch_id AND ba.turn_state = 'IN_FLIGHT') < s.batch_max_concurrent)
       AND (s.root_session_id IS NULL OR (SELECT count(*) FROM "session" tree
              WHERE tree.root_session_id = s.root_session_id AND tree.turn_state = 'IN_FLIGHT'
                AND NOT EXISTS (SELECT 1 FROM "session" child
                                 WHERE child.parent_session_id = tree.id AND child.turn_state IN ('QUEUED', 'IN_FLIGHT')))
              < GREATEST(1, (SELECT r.max_concurrent FROM "runner" r WHERE r.id = {runner}) - 1))
     ORDER BY (SELECT count(*) FROM "session" busy
                WHERE busy.root_session_id = s.root_session_id AND busy.turn_state = 'IN_FLIGHT') ASC, s.created_at ASC
     FOR UPDATE NOWAIT LIMIT 1)
  RETURNING id $q$) \g /dev/null

SELECT pg_temp.measure('1', 'claim replay', 'word', NULL, $q$
  SELECT id FROM "session" WHERE assigned_runner_id = {runner} AND claim_request_id = {claim_request}
     AND status = 'RUNNING' $q$) \g /dev/null
SELECT pg_temp.measure('1', 'claim replay', 'facts', 'session_runner_turn_state_idx', $q$
  SELECT id FROM "session" WHERE assigned_runner_id = {runner} AND claim_request_id = {claim_request}
     AND turn_state = 'IN_FLIGHT' $q$) \g /dev/null

SELECT pg_temp.measure('1', 'Run now overflow probe', 'word', NULL, $q$
  SELECT EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner}
                    AND s.over_capacity_turn_id IS NOT NULL AND s.status = 'PENDING') $q$) \g /dev/null
SELECT pg_temp.measure('1', 'Run now overflow probe', 'facts',
  'session_over_capacity_queued_idx session_runner_turn_state_idx', $q$
  SELECT EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner}
                    AND s.over_capacity_turn_id IS NOT NULL AND s.turn_state = 'QUEUED') $q$) \g /dev/null

-- ── 2. The slot counts (common/session-tree-sql.ts) ─────────────────────────────────────────────
SELECT pg_temp.measure('2', 'runnerActiveTurns', 'word', NULL, $q$
  SELECT count(*) FROM "session" active WHERE active.assigned_runner_id = {runner} AND active.status = 'RUNNING' $q$) \g /dev/null
SELECT pg_temp.measure('2', 'runnerActiveTurns', 'facts', 'session_runner_turn_state_idx', $q$
  SELECT count(*) FROM "session" active WHERE active.assigned_runner_id = {runner} AND active.turn_state = 'IN_FLIGHT' $q$) \g /dev/null

SELECT pg_temp.measure('2', 'batchActiveTurns', 'word', NULL, $q$
  SELECT count(*) FROM "session" ba WHERE ba.batch_id = {batch} AND ba.status = 'RUNNING' $q$) \g /dev/null
SELECT pg_temp.measure('2', 'batchActiveTurns', 'facts', 'session_batch_in_flight_idx', $q$
  SELECT count(*) FROM "session" ba WHERE ba.batch_id = {batch} AND ba.turn_state = 'IN_FLIGHT' $q$) \g /dev/null

SELECT pg_temp.measure('2', 'treeActiveTurns', 'word', NULL, $q$
  SELECT count(*) FROM "session" tree WHERE tree.root_session_id = {root} AND tree.status = 'RUNNING'
     AND NOT EXISTS (SELECT 1 FROM "session" child WHERE child.parent_session_id = tree.id
                       AND child.status IN ('PENDING', 'RUNNING')) $q$) \g /dev/null
SELECT pg_temp.measure('2', 'treeActiveTurns', 'facts', 'session_root_in_flight_idx', $q$
  SELECT count(*) FROM "session" tree WHERE tree.root_session_id = {root} AND tree.turn_state = 'IN_FLIGHT'
     AND NOT EXISTS (SELECT 1 FROM "session" child WHERE child.parent_session_id = tree.id
                       AND child.turn_state IN ('QUEUED', 'IN_FLIGHT')) $q$) \g /dev/null

SELECT pg_temp.measure('2', 'runnerBackgroundHeldSessions', 'word', NULL, $q$
  SELECT count(*) FROM "session" held WHERE held.assigned_runner_id = {runner}
     AND held.status IN ('PENDING', 'AWAITING_INPUT', 'INTERRUPTED')
     AND held.id = ANY(SELECT unnest(p.background_job_session_ids) FROM "runner_presence" p
                        WHERE p.runner_id = {runner}) $q$) \g /dev/null
SELECT pg_temp.measure('2', 'runnerBackgroundHeldSessions', 'facts',
  'session_pkey session_runner_held_idx', $q$
  SELECT count(*) FROM "session" held WHERE held.assigned_runner_id = {runner}
     AND held.finished_at IS NULL AND held.turn_state IS DISTINCT FROM 'IN_FLIGHT'
     AND held.id = ANY(SELECT unnest(p.background_job_session_ids) FROM "runner_presence" p
                        WHERE p.runner_id = {runner}) $q$) \g /dev/null

-- ── 3. Every sessionHeldIndexedSql reader (common/session-release.ts) ───────────────────────────
-- The case of the earlier plan's step 4.3: one runner's held sessions, 73 of 44,000.
SELECT pg_temp.measure('3', 'held sessions of one runner (step 4.3 case)', 'word', NULL,
  'SELECT count(*) FROM "session" s WHERE s.assigned_runner_id = {runner} AND ' || :'held_word') \g /dev/null
SELECT pg_temp.measure('3', 'held sessions of one runner (step 4.3 case)', 'facts', 'session_runner_held_idx', $q$
  SELECT count(*) FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.finished_at IS NULL $q$) \g /dev/null

SELECT pg_temp.measure('3', 'managed sleep: BACKGROUND_WORK', 'word', NULL,
  'SELECT EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner} AND ' || :'held_word' || $q$
     AND (s.engine_turn_active = true OR cardinality(s.running_subagents) > 0 OR cardinality(s.running_bg_jobs) > 0
          OR cardinality(s.running_bg_shells) > 0)) $q$) \g /dev/null
SELECT pg_temp.measure('3', 'managed sleep: BACKGROUND_WORK', 'facts', 'session_runner_held_idx', $q$
  SELECT EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.finished_at IS NULL
     AND (s.engine_turn_active = true OR cardinality(s.running_subagents) > 0 OR cardinality(s.running_bg_jobs) > 0
          OR cardinality(s.running_bg_shells) > 0)) $q$) \g /dev/null

SELECT pg_temp.measure('3', 'managed sleep: ACTIVE_TURN and QUEUED_TURN', 'word', NULL, $q$
  SELECT EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.status = 'RUNNING'),
         EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.status = 'PENDING'
                    AND s.cancel_requested_at IS NULL) $q$) \g /dev/null
SELECT pg_temp.measure('3', 'managed sleep: ACTIVE_TURN and QUEUED_TURN', 'facts', 'session_runner_turn_state_idx', $q$
  SELECT EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.turn_state = 'IN_FLIGHT'),
         EXISTS (SELECT 1 FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.turn_state = 'QUEUED'
                    AND s.cancel_requested_at IS NULL) $q$) \g /dev/null

SELECT pg_temp.measure('3', 'dispatch pause: turns still running', 'word', NULL,
  'SELECT t.id FROM "session" s JOIN "conversation_turn" t ON t.session_id = s.id AND t.status = ''IN_FLIGHT''
    WHERE ' || :'held_word' || ' AND t.kind IN (''message'', ''shell'')') \g /dev/null
SELECT pg_temp.measure('3', 'dispatch pause: turns still running', 'facts',
  'session_runner_held_idx session_owner_held_task_idx', $q$
  SELECT t.id FROM "session" s JOIN "conversation_turn" t ON t.session_id = s.id AND t.status = 'IN_FLIGHT'
   WHERE s.finished_at IS NULL AND t.kind IN ('message', 'shell') $q$) \g /dev/null

SELECT pg_temp.measure('3', 'dispatch resume: inboxes to wake', 'word', NULL,
  'SELECT DISTINCT s.id FROM "session" s JOIN "conversation_turn" t ON t.session_id = s.id AND t.status = ''PENDING''
    WHERE ' || :'held_word' || ' AND t.kind IN (''message'', ''shell'', ''reload'')') \g /dev/null
SELECT pg_temp.measure('3', 'dispatch resume: inboxes to wake', 'facts',
  'session_runner_held_idx session_owner_held_task_idx', $q$
  SELECT DISTINCT s.id FROM "session" s JOIN "conversation_turn" t ON t.session_id = s.id AND t.status = 'PENDING'
   WHERE s.finished_at IS NULL AND t.kind IN ('message', 'shell', 'reload') $q$) \g /dev/null

SELECT pg_temp.measure('3', 'dispatch resume: runners to hint', 'word', NULL, $q$
  SELECT DISTINCT s.assigned_runner_id FROM "session" s WHERE s.status = 'PENDING' AND s.assigned_runner_id IS NOT NULL $q$) \g /dev/null
SELECT pg_temp.measure('3', 'dispatch resume: runners to hint', 'facts',
  'session_runner_turn_state_idx session_over_capacity_queued_idx', $q$
  SELECT DISTINCT s.assigned_runner_id FROM "session" s WHERE s.turn_state = 'QUEUED' AND s.assigned_runner_id IS NOT NULL $q$) \g /dev/null

SELECT pg_temp.measure('3', 'draining runner: waiting work', 'word', NULL,
  'SELECT count(*) FROM "session" s
     CROSS JOIN LATERAL (SELECT count(*) AS turns FROM "conversation_turn" t
                          WHERE t.session_id = s.id AND t.status = ''PENDING'' AND t.kind = ''message'') m
    WHERE s.assigned_runner_id = {runner} AND s.owner_id = {owner} AND ' || :'held_word' || '
      AND s.cancel_requested_at IS NULL AND s.deleted_at IS NULL') \g /dev/null
SELECT pg_temp.measure('3', 'draining runner: waiting work', 'facts', 'session_runner_held_idx', $q$
  SELECT count(*) FROM "session" s
    CROSS JOIN LATERAL (SELECT count(*) AS turns FROM "conversation_turn" t
                         WHERE t.session_id = s.id AND t.status = 'PENDING' AND t.kind = 'message') m
   WHERE s.assigned_runner_id = {runner} AND s.owner_id = {owner} AND s.finished_at IS NULL
     AND s.cancel_requested_at IS NULL AND s.deleted_at IS NULL $q$) \g /dev/null

SELECT pg_temp.measure('3', 'runner link: approvals decided', 'word', NULL,
  'SELECT a.id FROM "session" s JOIN "approval" a ON a.session_id = s.id AND a.status IN (''ALLOWED'', ''DENIED'')
    WHERE s.assigned_runner_id = {runner} AND ' || :'held_word' || '
      AND (s.status = ''RUNNING'' OR (s.status = ''AWAITING_INPUT'' AND s.engine_turn_active)
           OR cardinality(s.running_bg_shells) > 0)') \g /dev/null
SELECT pg_temp.measure('3', 'runner link: approvals decided', 'facts', 'session_runner_held_idx', $q$
  SELECT a.id FROM "session" s JOIN "approval" a ON a.session_id = s.id AND a.status IN ('ALLOWED', 'DENIED')
   WHERE s.assigned_runner_id = {runner} AND s.finished_at IS NULL
     AND (s.turn_state = 'IN_FLIGHT' OR (s.turn_state IS NULL AND s.engine_turn_active)
          OR cardinality(s.running_bg_shells) > 0) $q$) \g /dev/null

-- ── 4. Reclaim and the heartbeat fence (runner-api/runner-api.controller.ts) ────────────────────
SELECT pg_temp.measure('4', 'reclaim set', 'word', NULL, $q$
  SELECT * FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.owner_id = {owner}
     AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') AND s.kind = 'CONVERSATION' $q$) \g /dev/null
SELECT pg_temp.measure('4', 'reclaim set', 'facts', 'session_runner_held_idx', $q$
  SELECT * FROM "session" s WHERE s.assigned_runner_id = {runner} AND s.owner_id = {owner}
     AND s.finished_at IS NULL AND s.kind = 'CONVERSATION' $q$) \g /dev/null

SELECT pg_temp.measure('4', 'heartbeat ownership fence', 'word', NULL, $q$
  SELECT s.id FROM "session" s WHERE s.id = ANY({supervised}) AND s.assigned_runner_id = {runner}
     AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') AND s.kind = 'CONVERSATION' $q$) \g /dev/null
SELECT pg_temp.measure('4', 'heartbeat ownership fence', 'facts', 'session_pkey session_runner_held_idx', $q$
  SELECT s.id FROM "session" s WHERE s.id = ANY({supervised}) AND s.assigned_runner_id = {runner}
     AND s.finished_at IS NULL AND s.kind = 'CONVERSATION' $q$) \g /dev/null

-- ── 5. Task occupancy and the carrier ───────────────────────────────────────────────────────────
SELECT pg_temp.measure('5', 'live runs of tasks (batch stop, delete, reach)', 'word', NULL, $q$
  SELECT s.id, s.task_id FROM "session" s WHERE s.owner_id = {owner} AND s.task_id = ANY({tasks})
     AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') $q$) \g /dev/null
SELECT pg_temp.measure('5', 'live runs of tasks (batch stop, delete, reach)', 'facts', 'session_owner_held_task_idx', $q$
  SELECT s.id, s.task_id FROM "session" s WHERE s.owner_id = {owner} AND s.task_id = ANY({tasks})
     AND s.finished_at IS NULL $q$) \g /dev/null

SELECT pg_temp.measure('5', 'live runs of a task list (list delete)', 'word', NULL, $q$
  SELECT s.id FROM "session" s JOIN "task" t ON t.id = s.task_id WHERE s.owner_id = {owner} AND t.list_id = {list}
     AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') $q$) \g /dev/null
SELECT pg_temp.measure('5', 'live runs of a task list (list delete)', 'facts', 'session_owner_held_task_idx', $q$
  SELECT s.id FROM "session" s JOIN "task" t ON t.id = s.task_id WHERE s.owner_id = {owner} AND t.list_id = {list}
     AND s.finished_at IS NULL $q$) \g /dev/null

-- The cap re-stamp filters one batch among the held rows; no candidate index is keyed on (batch_id) for held rows.
SELECT pg_temp.measure('5', 'batch cap re-stamp (task list update)', 'word', NULL, $q$
  UPDATE "session" SET batch_max_concurrent = 4 WHERE batch_id = {batch}
     AND status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
     AND (batch_max_concurrent <> 4 OR batch_max_concurrent IS NULL) $q$) \g /dev/null
SELECT pg_temp.measure('5', 'batch cap re-stamp (task list update)', 'facts', NULL, $q$
  UPDATE "session" SET batch_max_concurrent = 4 WHERE batch_id = {batch} AND finished_at IS NULL
     AND (batch_max_concurrent <> 4 OR batch_max_concurrent IS NULL) $q$) \g /dev/null

SELECT pg_temp.measure('5', 'reclaimStalledTask: occupied count', 'word', NULL, $q$
  SELECT count(*) FROM "session" s WHERE s.task_id = {task}
     AND s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') $q$) \g /dev/null
SELECT pg_temp.measure('5', 'reclaimStalledTask: occupied count', 'facts',
  'project_event_session_task_provider_idx session_task_execution_claim_idx_finished_at', $q$
  SELECT count(*) FROM "session" s WHERE s.task_id = {task} AND s.finished_at IS NULL $q$) \g /dev/null

SELECT pg_temp.measure('5', 'the task carrier, over 50 tasks', 'word', NULL, $q$
  SELECT t.id FROM "task" t WHERE t.id = ANY({tasks}) AND EXISTS (SELECT 1 FROM "session" c WHERE c.task_id = t.id
     AND c.starts_task_work = true AND c.deleted_at IS NULL AND c.finished_at IS NULL
     AND c.status IN ('PENDING'::run_status, 'RUNNING'::run_status, 'AWAITING_INPUT'::run_status)
     AND (c.status <> 'AWAITING_INPUT'::run_status OR (c.engine_turn_active = true OR cardinality(c.running_subagents) > 0 OR cardinality(c.running_bg_jobs) > 0
       OR EXISTS (SELECT 1 FROM "watch" w WHERE w.observer_session_id = c.id AND w.state = 'ACTIVE' AND w.action = 'RESUME_SESSION')
       OR EXISTS (SELECT 1 FROM "session_scheduled_wakeup" k WHERE k.session_id = c.id AND k.state = 'PENDING')
       OR c.retry_at IS NOT NULL))) $q$) \g /dev/null
SELECT pg_temp.measure('5', 'the task carrier, over 50 tasks', 'facts',
  'session_task_execution_claim_idx_finished_at session_owner_held_task_idx session_runner_held_idx', $q$
  SELECT t.id FROM "task" t WHERE t.id = ANY({tasks}) AND EXISTS (SELECT 1 FROM "session" c WHERE c.task_id = t.id
     AND c.starts_task_work = true AND c.deleted_at IS NULL AND c.finished_at IS NULL
     AND c.turn_state IS DISTINCT FROM 'ABANDONED'
     AND (c.turn_state IN ('QUEUED', 'IN_FLIGHT')
       OR (c.engine_turn_active = true OR cardinality(c.running_subagents) > 0 OR cardinality(c.running_bg_jobs) > 0
       OR EXISTS (SELECT 1 FROM "watch" w WHERE w.observer_session_id = c.id AND w.state = 'ACTIVE' AND w.action = 'RESUME_SESSION')
       OR EXISTS (SELECT 1 FROM "session_scheduled_wakeup" k WHERE k.session_id = c.id AND k.state = 'PENDING')
       OR c.retry_at IS NOT NULL))) $q$) \g /dev/null

-- ── 6. The auto-run slot budget and the reaper's sweep ──────────────────────────────────────────
SELECT pg_temp.measure('6', 'slot budget per runner', 'word', NULL, $q$
  SELECT r.id, r.max_concurrent - count(s.id)::int FROM "runner" r
    LEFT JOIN "session" s ON s.assigned_runner_id = r.id AND s.status IN ('RUNNING', 'PENDING')
   GROUP BY r.id, r.max_concurrent $q$) \g /dev/null
SELECT pg_temp.measure('6', 'slot budget per runner', 'facts', 'session_runner_turn_state_idx', $q$
  SELECT r.id, r.max_concurrent - count(s.id)::int FROM "runner" r
    LEFT JOIN "session" s ON s.assigned_runner_id = r.id AND s.turn_state IN ('QUEUED', 'IN_FLIGHT')
   GROUP BY r.id, r.max_concurrent $q$) \g /dev/null

SELECT pg_temp.measure('6', 'slot budget per capped list', 'word', NULL, $q$
  SELECT tl.id, tl.max_concurrent - count(s.id)::int FROM "task_list" tl
    LEFT JOIN "session" s ON s.batch_id = tl.id AND s.status IN ('RUNNING', 'PENDING')
   WHERE tl.max_concurrent IS NOT NULL GROUP BY tl.id, tl.max_concurrent $q$) \g /dev/null
SELECT pg_temp.measure('6', 'slot budget per capped list', 'facts',
  'session_runner_turn_state_idx session_batch_in_flight_idx session_runner_held_idx session_owner_held_task_idx', $q$
  SELECT tl.id, tl.max_concurrent - count(s.id)::int FROM "task_list" tl
    LEFT JOIN "session" s ON s.batch_id = tl.id AND s.turn_state IN ('QUEUED', 'IN_FLIGHT')
   WHERE tl.max_concurrent IS NOT NULL GROUP BY tl.id, tl.max_concurrent $q$) \g /dev/null

SELECT pg_temp.measure('6', 'the reaper''s sweep', 'word', NULL, $q$
  SELECT s.id, s.status FROM "session" s
   WHERE s.status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') AND s.kind = 'CONVERSATION' $q$) \g /dev/null
SELECT pg_temp.measure('6', 'the reaper''s sweep', 'facts', 'session_runner_held_idx session_owner_held_task_idx', $q$
  SELECT s.id, s.turn_state FROM "session" s WHERE s.finished_at IS NULL AND s.kind = 'CONVERSATION' $q$) \g /dev/null

-- ── 7. listForOrchestration with each ?status= word (sessions/sessions.service.ts, plan §6) ─────
CREATE TEMP TABLE plan_list_word (word text, facts text, intended text) ON COMMIT DROP;
INSERT INTO plan_list_word VALUES
  ('PENDING', $$s.finished_at IS NULL AND s.turn_state = 'QUEUED'$$,
     'session_runner_turn_state_idx session_owner_held_task_idx session_over_capacity_queued_idx'),
  ('RUNNING', $$s.finished_at IS NULL AND s.turn_state = 'IN_FLIGHT'$$,
     'session_runner_turn_state_idx session_owner_held_task_idx session_batch_in_flight_idx session_root_in_flight_idx'),
  ('INTERRUPTED', $$s.finished_at IS NULL AND s.turn_state = 'ABANDONED'$$,
     'session_runner_turn_state_idx session_owner_held_task_idx'),
  ('AWAITING_INPUT', $$s.finished_at IS NULL AND s.turn_state IS NULL$$, 'session_owner_held_task_idx session_runner_held_idx'),
  ('FAILED', $$s.finished_at IS NOT NULL AND ((s.end_reason IS NULL AND s.last_turn_outcome IS NOT NULL
                 AND s.last_turn_outcome = 'FAILED')
                 OR (s.end_reason IS NULL AND s.last_turn_outcome IS NULL AND s.import_source_cwd IS NOT NULL))$$,
     'session_released_failed_idx'),
  ('SUCCEEDED', $$s.finished_at IS NOT NULL AND s.end_reason IS NOT NULL AND s.end_reason = 'task_done'
                 AND s.started_at IS NOT NULL$$, NULL),
  ('CANCELLED', $$s.finished_at IS NOT NULL
                 AND NOT ((s.end_reason IS NULL AND s.last_turn_outcome IS NOT NULL AND s.last_turn_outcome = 'FAILED')
                   OR (s.end_reason IS NULL AND s.last_turn_outcome IS NULL AND s.import_source_cwd IS NOT NULL)
                   OR (s.end_reason IS NOT NULL AND s.end_reason = 'task_done' AND s.started_at IS NOT NULL))$$, NULL);
SELECT pg_temp.measure('7', 'listForOrchestration ' || w.word, f.form,
  CASE f.form WHEN 'facts' THEN w.intended END, format($q$
  SELECT s.id, s.title, s.created_at FROM "session" s
   WHERE s.owner_id = {owner} AND s.deleted_at IS NULL AND s.kind = 'CONVERSATION'
     AND s.run_source NOT IN ('SCHEDULE', 'SCHEDULE_CHANGE') AND %s
   ORDER BY s.last_turn_at DESC, s.created_at DESC LIMIT 100 $q$,
   CASE f.form WHEN 'word' THEN 's.status = ' || quote_literal(w.word) ELSE w.facts END))
  FROM plan_list_word w CROSS JOIN (VALUES ('word'), ('facts')) f(form) \g /dev/null

-- ── The summary ─────────────────────────────────────────────────────────────────────────────────
\echo '== plans: shared buffers, indexes used =='
SELECT item, query, form, buffers, ms, uses_intended, used, intended FROM plan_result ORDER BY item, query, form DESC;
\echo '== facts queries that did not use their intended index (expected: none) =='
SELECT item, query, used, intended FROM plan_result WHERE form = 'facts' AND uses_intended = 'NO' ORDER BY seq;
\echo '== facts queries that read more buffers than their word form =='
SELECT f.item, f.query, w.buffers AS word_buffers, f.buffers AS facts_buffers
  FROM plan_result f JOIN plan_result w ON w.item = f.item AND w.query = f.query AND w.form = 'word'
 WHERE f.form = 'facts' AND f.buffers > w.buffers ORDER BY f.seq;
\if :plans
  \echo '== the plans =='
  SELECT format(E'--- %s. %s [%s]\n%s', item, query, form, plan) FROM plan_result ORDER BY seq \g (format=unaligned tuples_only=on)
\endif

-- ── 8. The writes: event ingestion moving the running sets, with and without session_zz_phase ───
\if :writes
  SET LOCAL lock_timeout = '2s';
  CREATE FUNCTION pg_temp.ingest(label text) RETURNS TABLE (run text, updates bigint, hot bigint, hot_share numeric, ms numeric)
  LANGUAGE plpgsql AS $fn$
  DECLARE
    ids uuid[];
    before_upd bigint;
    before_hot bigint;
    started timestamptz;
    elapsed numeric;
  BEGIN
    SELECT array_agg(id) INTO ids FROM (SELECT s.id FROM "session" s, plan_target t
       WHERE s.assigned_runner_id = t.runner AND s.finished_at IS NULL ORDER BY s.id LIMIT 50) x;
    SELECT n_tup_upd, n_tup_hot_upd INTO before_upd, before_hot FROM pg_stat_xact_user_tables WHERE relname = 'session';
    BEGIN
      started := clock_timestamp();
      FOR i IN 1..2000 LOOP
        UPDATE "session" SET running_bg_jobs = CASE WHEN i % 2 = 0 THEN '{}'::text[] ELSE ARRAY['bgj_' || i] END,
               updated_at = now() WHERE id = ids[1 + i % array_length(ids, 1)];
      END LOOP;
      elapsed := round((extract(epoch FROM clock_timestamp() - started) * 1000)::numeric, 1);
      RETURN QUERY SELECT label, v.n_tup_upd - before_upd, v.n_tup_hot_upd - before_hot,
                          round((v.n_tup_hot_upd - before_hot)::numeric / NULLIF(v.n_tup_upd - before_upd, 0), 3), elapsed
                     FROM pg_stat_xact_user_tables v WHERE v.relname = 'session';
      RAISE EXCEPTION USING ERRCODE = 'P0099';
    EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
    END;
  END
  $fn$;
  \echo '== 8. 2,000 running-set updates on 50 held sessions =='
  SELECT * FROM pg_temp.ingest('with session_zz_phase (warm-up)');
  SELECT * FROM pg_temp.ingest('with session_zz_phase');
  ALTER TABLE "session" DISABLE TRIGGER "session_zz_phase";
  SELECT * FROM pg_temp.ingest('without session_zz_phase');
  ALTER TABLE "session" ENABLE TRIGGER "session_zz_phase";
  \echo '== 8. the table since statistics were last reset =='
  SELECT n_tup_upd, n_tup_hot_upd, round(n_tup_hot_upd::numeric / NULLIF(n_tup_upd, 0), 3) AS hot_share
    FROM pg_stat_user_tables WHERE relname = 'session';
\endif

ROLLBACK;
