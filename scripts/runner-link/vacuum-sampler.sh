#!/usr/bin/env bash
# Read-only: every 2 s, the vacuums and analyzes in progress (pg_stat_progress_vacuum / _analyze), one JSON line each
# tick, from ONE long-lived psql backend (\watch), so it adds one cheap catalog query every 2 s and changes no setting.
# Task C2b rerun: the coordinator's rule (2026-10-31) asks when each vacuum of the judged hour ran and for how long;
# pg_stat_user_tables keeps only when the last one ended, and log_autovacuum_min_duration (default 10 min) is not
# to be changed.
#   vacuum-sampler.sh <out.jsonl>        (stop it with kill; it runs until then)
out="$1"
docker exec -i orbit-link-c2b-postgres psql -U orbit -d orbit -X -A -t -q <<'SQL' | grep --line-buffered '^{' >> "$out"
SELECT json_build_object(
  't', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
  'vacuum', coalesce((SELECT json_agg(json_build_object('pid', p.pid, 'rel', c.relname, 'phase', p.phase,
      'heapTotal', p.heap_blks_total, 'heapScanned', p.heap_blks_scanned, 'heapVacuumed', p.heap_blks_vacuumed,
      'indexPasses', p.index_vacuum_count, 'xactStart', (extract(epoch FROM a.xact_start) * 1000)::bigint,
      'query', left(a.query, 80)))
    FROM pg_stat_progress_vacuum p JOIN pg_class c ON c.oid = p.relid LEFT JOIN pg_stat_activity a ON a.pid = p.pid), '[]'::json),
  'analyze', coalesce((SELECT json_agg(json_build_object('pid', p.pid, 'rel', c.relname, 'phase', p.phase,
      'xactStart', (extract(epoch FROM a.xact_start) * 1000)::bigint))
    FROM pg_stat_progress_analyze p JOIN pg_class c ON c.oid = p.relid LEFT JOIN pg_stat_activity a ON a.pid = p.pid), '[]'::json))
\watch 2
SQL
