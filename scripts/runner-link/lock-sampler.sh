#!/usr/bin/env bash
# Read-only (coordinator, 2026-10-31): every 2 s, the backends waiting on a heavyweight lock (pg_stat_activity
# wait_event_type = 'Lock'), the lock each waits for in pg_locks (locktype, mode, database, classid, objid, relation,
# transactionid), and the backends holding it (pg_blocking_pids) with their state and wait event. One long-lived psql
# backend (\watch); no setting is changed. A NOTIFY's commit-time lock would read locktype object, database 0,
# classid 1262 (pg_database), objid 0, mode AccessExclusiveLock (src/backend/commands/async.c PreCommit_Notify).
#   lock-sampler.sh <out.jsonl>        (stop it, then pg_terminate_backend its backend)
out="$1"
docker exec -i orbit-link-c2b-postgres psql -U orbit -d orbit -X -A -t -q <<'SQL' | grep --line-buffered '^{' >> "$out"
SELECT json_build_object(
  't', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
  'waits', coalesce((
    SELECT json_agg(json_build_object(
      'pid', w.pid, 'waitEvent', w.wait_event, 'state', w.state, 'query', left(w.query, 60),
      'xactAgeMs', (extract(epoch FROM clock_timestamp() - w.xact_start) * 1000)::bigint,
      'waitingFor', (SELECT json_agg(json_build_object('locktype', l.locktype, 'mode', l.mode, 'database', l.database,
          'classid', l.classid, 'objid', l.objid, 'objsubid', l.objsubid, 'relation', l.relation::regclass::text,
          'transactionid', l.transactionid::text))
        FROM pg_locks l WHERE l.pid = w.pid AND NOT l.granted),
      'blockedBy', (SELECT json_agg(json_build_object('pid', h.pid, 'state', h.state, 'waitEventType', h.wait_event_type,
          'waitEvent', h.wait_event, 'query', left(h.query, 60),
          'xactAgeMs', (extract(epoch FROM clock_timestamp() - h.xact_start) * 1000)::bigint))
        FROM pg_stat_activity h WHERE h.pid = ANY(pg_blocking_pids(w.pid)))))
    FROM pg_stat_activity w WHERE w.wait_event_type = 'Lock' AND w.pid <> pg_backend_pid()), '[]'::json))
\watch 2
SQL
