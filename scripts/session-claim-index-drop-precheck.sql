-- Before deploy 3: may migration 1444 drop session_task_execution_claim_idx on this database?
-- (docs/session-three-state-plan.md §7 step 4.5, release B; the migration's header says what a server one release
-- older does after the drop.)
--
-- Read-only, safe on production as it stands (deploy 2, a7f28ff0ac): plain SELECTs of the catalog, of
-- _prisma_migrations and of pg_stat_statements. It takes no lock beyond what any read takes and writes nothing.
--
--   psql "$DATABASE_URL" -X -f scripts/session-claim-index-drop-precheck.sql
--
-- Run it twice, at least five minutes apart (the dispatch sweep runs every minute), and compare old_carrier_calls.
-- Together with the container check in the plan (every running apiserver and wiki-worker container is an image of
-- a7f28ff0ac or a later commit), it says that no running replica states the old predicate.
--
-- Expected, and what a different answer means:
--   release_a_applied        true. 1426 is recorded applied and not rolled back. false: deploy 2 is not live here.
--   new_index_valid          true. 1426's index exists, is valid and unique. Anything else: it does not enforce the claim,
--                            and dropping the old one would leave none. Do not deploy.
--   old_index_valid          true, or null once 1444 has run. false: an earlier drop (or build) was cut short. 1444's
--                            IF EXISTS drops it all the same.
--   invalid_session_indexes  empty. Any name: a build or drop on session was cut short. Read 1426's and 1444's headers.
--   tasks_doubled            0. Tasks with two live runs by the new predicate. Not 0 cannot happen while the new index
--                            is valid.
--   old_carrier_statements   how many distinct statements pg_stat_statements holds that state the task carrier
--   old_carrier_calls        without `finished_at IS NULL`: deploy 1's sessions/task-work-carrier.ts sessionCarriesTaskSql
--                            (45c327a903), `x."deleted_at" IS NULL` followed at once by `x."status" IN`, under any alias.
--                            Release A put `x."finished_at" IS NULL` between the two. The dispatch sweep, the ready-to-run
--                            reads and the project rollups all state it, so a deploy-1 server sends it every minute.
--                            Deploy 1's statements stay in the view after it stopped, so the first run may well show
--                            some; their total calls must not grow between the two runs. Growth: a server still sends
--                            deploy 1's carrier, and 1444 must wait. null: pg_stat_statements is not installed here,
--                            and only the container check stands.
SELECT
  EXISTS (SELECT 1 FROM "_prisma_migrations"
           WHERE "migration_name" = '1426_session_task_execution_claim_finished_at_idx'
             AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) AS release_a_applied,
  (SELECT bool_and(i."indisvalid" AND i."indisready" AND i."indisunique") FROM "pg_index" i
    WHERE i."indexrelid" = to_regclass('public.session_task_execution_claim_idx_finished_at')) AS new_index_valid,
  (SELECT bool_and(i."indisvalid") FROM "pg_index" i
    WHERE i."indexrelid" = to_regclass('public.session_task_execution_claim_idx')) AS old_index_valid,
  (SELECT coalesce(string_agg(i."indexrelid"::regclass::text, ', '), '') FROM "pg_index" i
    WHERE i."indrelid" = 'public.session'::regclass AND NOT i."indisvalid") AS invalid_session_indexes,
  (SELECT count(*) FROM (
     SELECT "task_id" FROM "session"
      WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL AND "finished_at" IS NULL
      GROUP BY "task_id" HAVING count(*) > 1) d) AS tasks_doubled,
  CASE WHEN to_regclass('pg_stat_statements') IS NOT NULL THEN (xpath('/table/row/n/text()', query_to_xml($q$
     SELECT count(*) AS n FROM pg_stat_statements
      WHERE query ~ '"starts_task_work" = (true|\$[0-9]+)[[:space:]]+AND ([a-z_]+)\."deleted_at" IS NULL[[:space:]]+AND \2\."status" IN'$q$, false, false, '')))[1]::text::bigint END
    AS old_carrier_statements,
  CASE WHEN to_regclass('pg_stat_statements') IS NOT NULL THEN (xpath('/table/row/n/text()', query_to_xml($q$
     SELECT coalesce(sum(calls), 0) AS n FROM pg_stat_statements
      WHERE query ~ '"starts_task_work" = (true|\$[0-9]+)[[:space:]]+AND ([a-z_]+)\."deleted_at" IS NULL[[:space:]]+AND \2\."status" IN'$q$, false, false, '')))[1]::text::bigint END
    AS old_carrier_calls
\gx
