#!/usr/bin/env bash
# Repeatable Postgres checkup: one Markdown report per run, on stdout.
#
#   scripts/pg-checkup.sh                              # report to stdout
#   scripts/pg-checkup.sh > docs/postgres-checkup.md   # refresh the committed report
#
# Committing it to that one path is what makes the series readable: `git log -p
# docs/postgres-checkup.md` is the trend. To run it on a schedule instead, one crontab line
# on the database host does it:
#   0 7 * * * cd /root/orbit && ./scripts/pg-checkup.sh > /var/log/orbit/pg-checkup-$(date -u +\%Y\%m\%d).md
#
# Why this exists: on 2026-09-15 the disk filled to 100% (/ is 197G), Postgres logged ENOSPC
# 288 times, and that alarm is how anyone found out. Every number below was already readable
# hours earlier. The report pairs each live reading with the baseline measured during the
# capacity-governance project, so the direction of travel is visible before the next wall.
#
# It is read-only and cheap by construction: pg_stat_* views, pg_stat_statements, and the
# size functions, which stat() relation files rather than scanning them. There is deliberately
# no exact-bloat estimation (pgstattuple, count(*)) — those read every page of the table they
# are asked about, which is the one thing a checkup on a 5 GB table must not do.
set -eu

PG_CONTAINER="${ORBIT_PG_CONTAINER:-orbit-postgres}"
PG_USER="${ORBIT_PG_USER:-orbit}"
PG_DB="${ORBIT_PG_DB:-orbit}"
# The filesystem PGDATA lives on. PGDATA is a bind mount to /root/orbit/data/postgres, so on
# this host the database shares `/` with everything else.
DISK_PATH="${ORBIT_CHECKUP_DISK_PATH:-/}"
TOP_N="${ORBIT_CHECKUP_TOP_N:-10}"
# Alert thresholds. These bound "when should a human look", not "what is acceptable" — the
# report always prints the readings, whether or not anything crossed a line.
DISK_PCT="${ORBIT_CHECKUP_DISK_PCT:-85}"
LONG_XACT="${ORBIT_CHECKUP_LONG_XACT_SECONDS:-300}"
LONG_IDLE_XACT="${ORBIT_CHECKUP_LONG_IDLE_XACT_SECONDS:-300}"
# Idle connections are held open legitimately by the runners' LISTEN sockets (hours at a
# time), so this one is a day rather than an hour: what it is meant to catch is the 12-day
# connection found on 2026-09-15, not a working listener.
LONG_IDLE="${ORBIT_CHECKUP_LONG_IDLE_SECONDS:-86400}"
DEAD_TUPLES="${ORBIT_CHECKUP_DEAD_TUPLES:-10000}"
AUTOVACUUM_STALE_DAYS="${ORBIT_CHECKUP_AUTOVACUUM_STALE_DAYS:-7}"

case "${1:-}" in
  -h | --help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
esac

docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -qx true || {
  echo "pg-checkup: container '$PG_CONTAINER' is not running (set ORBIT_PG_CONTAINER)" >&2
  exit 1
}

# -X so a developer's ~/.psqlrc cannot reshape the report; -q so only results are printed.
pg() { docker exec -i "$PG_CONTAINER" psql -X -q -U "$PG_USER" -d "$PG_DB" -P pager=off "$@"; }
scalars() { pg -At -F '|' -f -; }
table() {
  printf '```\n'
  pg -f -
  printf '```\n'
}

STAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ---------------------------------------------------------------- alerts (the front page)
disk_line="$(df -P "$DISK_PATH" | awk 'NR==2 {print $2, $3, $4, $5}')"
set -- $disk_line
disk_total_kb="$1" disk_used_kb="$2" disk_avail_kb="$3" disk_pct="${4%\%}"

IFS='|' read -r a_long_xact a_idle_xact a_long_idle a_bloated a_db_size a_ps_window <<EOF
$(scalars <<SQL
select
  (select count(*) from pg_stat_activity
     where xact_start is not null and now() - xact_start > interval '$LONG_XACT seconds'),
  (select count(*) from pg_stat_activity
     where state = 'idle in transaction'
       and now() - state_change > interval '$LONG_IDLE_XACT seconds'),
  (select count(*) from pg_stat_activity
     where state = 'idle' and now() - state_change > interval '$LONG_IDLE seconds'),
  (select count(*) from pg_stat_user_tables
     where n_dead_tup > $DEAD_TUPLES
       and (last_autovacuum is null
            or last_autovacuum < now() - interval '$AUTOVACUUM_STALE_DAYS days')),
  (select pg_size_pretty(pg_database_size(current_database()))),
  (select coalesce(to_char(now() - stats_reset, 'DD"d "HH24"h"'), 'never reset')
     from pg_stat_statements_info);
SQL
)
EOF

alerts=""
note() { alerts="${alerts}- $1
"; }
[ "$disk_pct" -ge "$DISK_PCT" ] &&
  note "**DISK ${disk_pct}%** of $DISK_PATH used, $((disk_avail_kb / 1024 / 1024)) GB free (threshold ${DISK_PCT}%)"
[ "$a_long_xact" -gt 0 ] && note "**${a_long_xact} transaction(s)** open longer than ${LONG_XACT}s"
[ "$a_idle_xact" -gt 0 ] && note "**${a_idle_xact} connection(s)** idle in transaction longer than ${LONG_IDLE_XACT}s (these hold locks and pin xmin)"
[ "$a_long_idle" -gt 0 ] && note "**${a_long_idle} connection(s)** idle longer than $((LONG_IDLE / 3600))h"
[ "$a_bloated" -gt 0 ] && note "**${a_bloated} table(s)** over ${DEAD_TUPLES} dead tuples with no autovacuum in ${AUTOVACUUM_STALE_DAYS} days"

cat <<HEADER
# Postgres checkup — $STAMP

Produced by \`scripts/pg-checkup.sh\` against container \`$PG_CONTAINER\`, database \`$PG_DB\`
($a_db_size); re-run that script to refresh this file. Read-only; no table is scanned.
Baselines quoted per section come from the capacity-governance project's 2026-09-15 first
measurement, with its 2026-09-17 recheck where one exists — so each section reads as
before → now.

Thresholds: disk ${DISK_PCT}%, transaction ${LONG_XACT}s, idle-in-transaction ${LONG_IDLE_XACT}s,
idle $((LONG_IDLE / 3600))h, dead tuples ${DEAD_TUPLES} with autovacuum older than ${AUTOVACUUM_STALE_DAYS}d.

## Alerts

HEADER
if [ -n "$alerts" ]; then printf '%s' "$alerts"; else echo "None: every reading below is inside its threshold."; fi

# ---------------------------------------------------------------- 1. disk
cat <<'SECTION'

## 1. Disk water level

SECTION
printf '```\n'
df -h "$DISK_PATH"
echo
echo "database size: $a_db_size"
printf '```\n'
cat <<SECTION

**Baseline.** \`/\` is 197G on this host. 2026-09-15: **100% full**, and Postgres logged
\`ENOSPC\` 288 times — that is how the incident was discovered. 2026-09-17: 88% (23G free).
Now: ${disk_pct}% ($((disk_avail_kb / 1024 / 1024))G free of $((disk_total_kb / 1024 / 1024))G).

The database is not the only writer on this filesystem (container logs have no rotation), but
per section 3 it is the largest one, so disk relief has to come from there.
SECTION

# ---------------------------------------------------------------- 2. top SQL
cat <<SECTION

## 2. Top SQL

\`pg_stat_statements\` has been accumulating for **$a_ps_window** (\`.save=on\`, so it survives
restarts — ask \`pg_stat_statements_info.stats_reset\` how long the window is, never
\`pg_postmaster_start_time()\`). \`.track=top\` keeps \`total_exec_time\` additive, which is what
makes the share column meaningful.

### By total execution time

SECTION
table <<SQL
select
  left(regexp_replace(query, '\s+', ' ', 'g'), 78) as query,
  calls,
  round(total_exec_time::numeric / 1000, 1) as total_s,
  round(mean_exec_time::numeric, 2) as mean_ms,
  round(100 * total_exec_time::numeric
        / nullif(sum(total_exec_time::numeric) over (), 0), 1) as pct_of_total
from pg_stat_statements
order by total_exec_time desc
limit $TOP_N;
SQL
cat <<SECTION

### By temporary blocks written

Anything with a non-zero count here spilled out of \`work_mem\` (4MB) to disk, which is both
slower and a claim on the filesystem in section 1.

SECTION
table <<SQL
select
  left(regexp_replace(query, '\s+', ' ', 'g'), 78) as query,
  calls,
  temp_blks_written,
  pg_size_pretty(temp_blks_written::bigint * current_setting('block_size')::bigint) as temp_written,
  round(total_exec_time::numeric / 1000, 1) as total_s
from pg_stat_statements
order by temp_blks_written desc, total_exec_time desc
limit $TOP_N;
SQL
cat <<'SECTION'

**Baseline.** There was no SQL-level observability before 2026-09-17: `shared_preload_libraries`
was empty and `log_temp_files` was `-1`, so none of this was answerable. First profile, in a
6h37m window: the `task_list` list query held **22.1%** of all execution time (Prisma's `_count`
compiles to a full aggregate over `task` — `... FROM task WHERE $4=$5 GROUP BY list_id` — 111,717
rows scanned to produce 13), and `temp_blks_written` was **zero database-wide**, which is how we
learned the 1.36TB in section 4 is historical rather than current.
SECTION

# ---------------------------------------------------------------- 3. sizes
cat <<SECTION

## 3. Largest tables and indexes

Every schema, not just \`public\`: the 2026-08-19 recovery left \`recovery_import_20260819\` and
\`recovery_quarantine_20260819\` behind, and an unqualified table name silently misses them.
\`toast\` is broken out because a table whose heap is tiny next to its total is not bloated — its
bytes are compressed values out of line, which \`VACUUM\` cannot reclaim.

SECTION
table <<SQL
select
  n.nspname || '.' || c.relname as relation,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total,
  pg_size_pretty(pg_relation_size(c.oid)) as heap,
  pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
  pg_size_pretty(pg_total_relation_size(c.oid)
                 - pg_relation_size(c.oid) - pg_indexes_size(c.oid)) as toast,
  to_char(c.reltuples, 'FM999,999,999') as reltuples_est
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'm')
  and n.nspname not in ('pg_catalog', 'information_schema')
order by pg_total_relation_size(c.oid) desc
limit $TOP_N;
SQL
cat <<SECTION

### Largest indexes, with their scan counts

\`idx_scan = 0\` is trustworthy here only because \`pg_stat_database.stats_reset\` is empty for
this database — the counters have never been reset, so a zero is the whole history rather than
a recently cleared slate. That is the self-proof that retired the 389MB duplicate index; any
future candidate has to earn the same one.

SECTION
table <<SQL
select
  s.schemaname || '.' || s.relname as relation,
  s.indexrelname as index,
  pg_size_pretty(pg_relation_size(s.indexrelid)) as size,
  s.idx_scan,
  s.idx_tup_read
from pg_stat_all_indexes s
  join pg_class c on c.oid = s.indexrelid
where s.schemaname not in ('pg_catalog', 'information_schema')
order by pg_relation_size(s.indexrelid) desc
limit $TOP_N;
SQL
cat <<'SECTION'

Index bytes per million rows for the table that dominates the disk, which is the reading that
survives the table's growth rate:

SECTION
table <<SQL
select
  pg_size_pretty(pg_indexes_size('run_event')) as run_event_indexes,
  to_char(c.reltuples, 'FM999,999,999') as rows_est,
  round((pg_indexes_size('run_event') / 1024.0 / 1024.0)
        / nullif(c.reltuples::numeric / 1e6, 0), 1) as mb_per_million_rows
from pg_class c
where c.oid = 'run_event'::regclass;
SQL
cat <<'SECTION'

**Baseline.** 2026-09-15: `run_event` 4402MB over 7.06M rows with 1326MB of indexes across six
of them, `task` 983MB, `tool_call` 934MB. 2026-09-17 recheck: `run_event` 5296MB / 11.49M rows,
indexes 1371MB, `tool_call` 1014MB, `task` 989MB, `attachment` 585MB.

Two things that reading teaches, both worth re-reading against the numbers above:

* The zero-scan duplicate `run_event_session_id_seq_idx` (389MB) **was** dropped on 2026-09-17 by
  migration `0277_drop_run_event_duplicate_index`, and the index total still went **up** — the
  table was taking on ~1.5M rows a day and `run_event_session_id_seq_key` alone grew 362 → 677MB.
  Normalised per million rows the intervention is visible where the absolute number hides it:
  **187.8 → 119.2 MB/M rows, −36.5%**. Judge index work that way, not against a fixed ceiling.
* `reltuples_est` above is `pg_class.reltuples`, deliberately not `pg_stat_user_tables.n_live_tup`.
  The latter resets with the postmaster, so a table imported before the 2026-08-21 restart and
  never written since reads as 0 rows forever. Three tables in `recovery_import_20260819` were
  written off as "zero-row bloat" on that basis and actually hold 244,844 live rows.
SECTION

# ---------------------------------------------------------------- 4. temp bytes
cat <<'SECTION'

## 4. Temporary file usage (pg_stat_database)

SECTION
table <<SQL
select
  datname,
  temp_files,
  pg_size_pretty(temp_bytes) as temp_bytes,
  case when temp_files > 0
       then pg_size_pretty((temp_bytes / temp_files)::bigint) end as avg_per_file,
  stats_reset,
  (select setting || ' (log_temp_files)' from pg_settings where name = 'log_temp_files') as logging,
  (select setting || 'kB (work_mem)' from pg_settings where name = 'work_mem') as work_mem
from pg_stat_database
where datname = current_database();
SQL
cat <<'SECTION'

**Baseline.** 2026-09-15: 1360GB across 329,939 files, averaging 4.3MB each — right at the
`work_mem` spill line.

**These two counters are cumulative and `stats_reset` is empty, so they carry no time
dimension.** The absolute number answers nothing on its own; the delta between two of these
reports does. That distinction matters: the 1.36TB looks like a live emergency and is not one —
across 2026-09-15 → 09-17 the measured rate was 0.45 files/hour against a 148/hour historical
average, a 329× difference, corroborated by zero `temp_blks_written` in section 2 and zero
`temporary file` lines in the container log. Chase the rate, not the total.
SECTION

# ---------------------------------------------------------------- 5. long transactions
cat <<SECTION

## 5. Long transactions and long idle connections

Three different conditions, with three different costs and three different parameters that end
them, so the report keeps them apart:

SECTION
table <<SQL
select
  pid,
  state,
  date_trunc('second', now() - xact_start) as xact_age,
  date_trunc('second', now() - state_change) as state_age,
  case
    when state = 'idle in transaction' then 'holds locks, pins xmin -> idle_in_transaction_session_timeout'
    when state = 'idle' then 'one connection slot -> idle_session_timeout'
    else 'running -> statement_timeout'
  end as cost_and_lever,
  usename,
  application_name,
  wait_event_type,
  left(regexp_replace(coalesce(query, ''), '\s+', ' ', 'g'), 48) as query
from pg_stat_activity
where backend_type = 'client backend'
  and (
    (xact_start is not null and now() - xact_start > interval '$LONG_XACT seconds')
    or (state = 'idle in transaction' and now() - state_change > interval '$LONG_IDLE_XACT seconds')
    or (state = 'idle' and now() - state_change > interval '$LONG_IDLE seconds')
  )
order by coalesce(xact_start, state_change);
SQL
cat <<'SECTION'

An empty table means nothing crossed a threshold. For context, the longest-lived connections
regardless of threshold:

SECTION
table <<SQL
select
  pid,
  state,
  date_trunc('second', now() - state_change) as state_age,
  application_name,
  left(regexp_replace(coalesce(query, ''), '\s+', ' ', 'g'), 48) as query
from pg_stat_activity
where backend_type = 'client backend'
order by state_change
limit 5;
SQL
cat <<'SECTION'

**Baseline.** 2026-09-15 turned up a connection (pid 1909054) that had been idle for **12 days**.

**With a correction this report exists to keep making.** That connection's state was `idle`, not
`idle in transaction`, and its `xact_start` was empty: it held no locks and pinned no xmin, so its
real cost was one connection slot. The parameter that would have ended it is `idle_session_timeout`
(PG 14+), **not** `idle_in_transaction_session_timeout`. All three timeouts are still `0` on this
server, which is a structural risk — nothing stops a future forgotten transaction — rather than a
past incident. Read the `state` column before naming the lever.
SECTION

# ---------------------------------------------------------------- 6. bloat signs
cat <<SECTION

## 6. Bloat signs (n_dead_tup and last_autovacuum)

Estimates from \`pg_stat_user_tables\`, which is free. Exact bloat measurement is deliberately
not attempted: it would read every page of these tables.

SECTION
table <<SQL
select
  schemaname || '.' || relname as relation,
  n_dead_tup,
  n_live_tup,
  round(100 * n_dead_tup::numeric / nullif(n_live_tup + n_dead_tup, 0), 1) as dead_pct,
  last_autovacuum,
  date_trunc('day', now() - last_autovacuum) as autovacuum_age,
  last_autoanalyze,
  autovacuum_count
from pg_stat_user_tables
where n_dead_tup > 0
order by n_dead_tup desc
limit $TOP_N;
SQL
cat <<SECTION

Tables over the alert threshold ($DEAD_TUPLES dead tuples and no autovacuum for
${AUTOVACUUM_STALE_DAYS}d) are counted in the Alerts section. A stale \`last_autovacuum\` next to
a growing \`n_dead_tup\` is the signal worth acting on: autovacuum's scale factor is proportional
to table size, so on a large table the trigger point recedes as the table grows.

**Baseline.** 2026-09-15: \`tool_call\` had 24,497 dead tuples and its \`last_autovacuum\` was
stuck at **2026-09-05**.

*A note on \`n_live_tup\` in this table:* it is the same counter that reset with the 2026-08-21
postmaster restart, so treat it as a denominator for \`dead_pct\`, not as a row count. Section 3's
\`reltuples_est\` is the number to quote for size.
SECTION
