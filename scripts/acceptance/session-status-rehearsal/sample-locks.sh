#!/usr/bin/env bash
# Read-only lock sampler for the rehearsal (after scripts/runner-link/lock-sampler.sh): every 0.2 s, one JSON line with
# every backend waiting on a heavyweight lock (pg_stat_activity wait_event_type = 'Lock'), how long its statement has
# run, the lock it waits for and the backends holding it. One long-lived psql backend; nothing is changed. Lines with
# no waiter are dropped, so the file holds only the waits.
#   sample-locks.sh <postgres container> <out.jsonl>     (stop it with kill; its backend ends with the psql)
set -u
container=$1 out=$2
docker exec -i "$container" psql -U orbit -d orbit -X -A -t -q <<'SQL' | grep --line-buffered -v '"waits" : \[\]\|^$' >> "$out"
SET application_name = 't16-lock-sampler';
SELECT json_build_object(
  't', to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'waits', coalesce((
    SELECT json_agg(json_build_object(
      'pid', w.pid, 'app', w.application_name, 'query', left(regexp_replace(w.query, '\s+', ' ', 'g'), 90),
      'waitingMs', (extract(epoch FROM clock_timestamp() - w.query_start) * 1000)::bigint,
      'waitingFor', (SELECT json_agg(json_build_object('locktype', l.locktype, 'mode', l.mode, 'relation', l.relation::regclass::text))
        FROM pg_locks l WHERE l.pid = w.pid AND NOT l.granted),
      'blockedBy', (SELECT json_agg(json_build_object('pid', h.pid, 'app', h.application_name, 'state', h.state,
          'query', left(regexp_replace(h.query, '\s+', ' ', 'g'), 90)))
        FROM pg_stat_activity h WHERE h.pid = ANY(pg_blocking_pids(w.pid)))))
    FROM pg_stat_activity w WHERE w.wait_event_type = 'Lock' AND w.pid <> pg_backend_pid()), '[]'::json))
\watch 0.2
SQL
