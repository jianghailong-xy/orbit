# Postgres checkup — 2026-09-18T11:07:37Z

Produced by `scripts/pg-checkup.sh` against container `orbit-postgres`, database `orbit`
(9465 MB); re-run that script to refresh this file. Read-only; no table is scanned.
Baselines quoted per section come from the capacity-governance project's 2026-09-15 first
measurement, with its 2026-09-17 recheck where one exists — so each section reads as
before → now.

Thresholds: disk 85%, transaction 300s, idle-in-transaction 300s,
idle 24h, dead tuples past the table's own autovacuum trigger line with no
autovacuum in 7d.

## Alerts

- **DISK 91%** of / used, 18 GB free (threshold 85%)

The reading behind that count: dead tuples per table against that table's **own** autovacuum
trigger line (`autovacuum_vacuum_threshold + scale_factor x reltuples`, table-level
`reloptions` first — the arithmetic autovacuum itself uses). **0 alerted**:
`alerted` marks the rows the bullet above counted, and there is no such bullet when that
number is 0. Past the line is not by itself a fault: it is where autovacuum becomes due, and a
table past its line that autovacuum visited recently is autovacuum working. Section 6 carries
the same readings beside the rest of the bloat picture.

```
                    relation                    | n_dead_tup | own_trigger_line | pct_of_line | alerted |        last_autovacuum        
------------------------------------------------+------------+------------------+-------------+---------+-------------------------------
 public.session                                 |       1111 |             1114 |        99.7 | f       | 2026-09-18 05:16:28.074287+00
 public.watch                                   |         80 |               88 |        91.3 | f       | 2026-09-18 10:57:34.915878+00
 public.project_completion_contract             |         54 |               62 |        86.5 | f       | 2026-09-16 16:01:31.417347+00
 public.approval                                |        411 |              477 |        86.2 | f       | 
 public.project_acceptance_criterion_definition |        108 |              131 |        82.2 | f       | 2026-09-11 03:55:45.467188+00
 public.conversation_turn                       |       3239 |             4024 |        80.5 | f       | 2026-09-15 12:28:56.081557+00
 public.client_version                          |         40 |               51 |        79.1 | f       | 2026-09-18 00:32:12.630499+00
 public.task_dependency_revision                |      15191 |            22270 |        68.2 | f       | 2026-08-26 03:51:46.711564+00
 public.task_dispatch_epoch                     |      14502 |            22270 |        65.1 | f       | 2026-08-26 03:52:46.585499+00
 public.session_scheduled_wakeup                |         33 |               55 |        59.8 | f       | 
(10 rows)

```

## 1. Disk water level

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       197G  170G   19G  91% /

database size: 9465 MB
```

**Baseline.** `/` is 197G on this host. 2026-09-15: **100% full**, and Postgres logged
`ENOSPC` 288 times — that is how the incident was discovered. 2026-09-17: 88% (23G free).
Now: 91% (18G free of 196G).

The database is not the only writer on this filesystem (container logs have no rotation), but
per section 3 it is the largest one, so disk relief has to come from there.

## 2. Top SQL

`pg_stat_statements` has been accumulating for **00d 17h** (`.save=on`, so it survives
restarts — ask `pg_stat_statements_info.stats_reset` how long the window is, never
`pg_postmaster_start_time()`). `.track=top` keeps `total_exec_time` additive, which is what
makes the share column meaningful.

### By total execution time

```
                                     query                                      | calls  | total_s |  mean_ms  | pct_of_total 
--------------------------------------------------------------------------------+--------+---------+-----------+--------------
 SELECT "public"."task_list"."id", "public"."task_list"."title", "public"."task |   2027 |   399.7 |    197.17 |          6.1
 SELECT t.id, t.owner_id AS "ownerId", t.assignee_id AS "workspaceId", a.runner |   1075 |   358.0 |    333.01 |          5.5
 SELECT MAX("seq") AS "_max$seq" FROM (SELECT "public"."run_event"."seq" FROM " |   9785 |   321.8 |     32.88 |          4.9
 SELECT "public"."runner"."id", "public"."runner"."name", "public"."runner"."di | 131833 |   283.9 |      2.15 |          4.3
 SELECT t.id, t.owner_id AS "ownerId", a.id AS "workspaceId", a.runner_id AS "r |   1074 |   283.7 |    264.13 |          4.3
 SELECT count(*)::int AS count FROM task t WHERE t.owner_id = $1::uuid AND t.li |   4380 |   215.6 |     49.22 |          3.3
 SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration", "inbox_lease_ow | 106167 |   203.2 |      1.91 |          3.1
 SELECT "public"."task"."id", "public"."task"."title", "public"."task"."status" |    558 |   149.4 |    267.75 |          2.3
 with mx as ( select distinct on (session_id) session_id, seq, type, payload fr |      1 |   138.9 | 138925.65 |          2.1
 select pg_sleep($1)                                                            |      1 |   120.1 | 120060.52 |          1.8
(10 rows)

```

### By temporary blocks written

Anything with a non-zero count here spilled out of `work_mem` (4MB) to disk, which is both
slower and a claim on the filesystem in section 1.

```
                                                 query                                                  | calls | temp_blks_written | temp_written | total_s 
--------------------------------------------------------------------------------------------------------+-------+-------------------+--------------+---------
 select date_trunc($1, created_at)::date d, count(*) rows, count(*) filter (whe                         |     1 |            731045 | 5711 MB      |    76.6
 select coalesce(s.provider,$1) provider, count(distinct s.id) sess, count(*) r                         |     1 |            234798 | 1834 MB      |    32.4
 explain (analyze, buffers, timing off) with mx as ( select distinct on (sessio                         |     1 |            145095 | 1134 MB      |    95.1
 with mx as ( select distinct on (session_id) session_id, seq, type, payload fr                         |     1 |            144319 | 1127 MB      |   138.9
 with subset as (select id from session order by id limit $1), orig as ( select                         |     1 |             95819 | 749 MB       |    29.5
 select e.session_id, s.provider, s.title, count(*) rows from run_event e join                          |     1 |             31712 | 248 MB       |     8.8
 select left(regexp_replace(query, $1, $2, $3), $4) as query, calls, round(tota                         |    17 |             12032 | 94 MB        |     5.0
 -- 用 PG 自己的收件时钟交叉验证增速（created_at 由 runner 提供，不可全信） select date_trunc($1, inges |     1 |              9600 | 75 MB        |    10.4
 select query from pg_stat_statements where queryid = $1                                                |    15 |              6625 | 52 MB        |     0.8
 select left(regexp_replace(query, $1, $2, $3), $4) as query, calls, temp_blks_                         |    16 |              6034 | 47 MB        |     3.5
(10 rows)

```

**Baseline.** There was no SQL-level observability before 2026-09-17: `shared_preload_libraries`
was empty and `log_temp_files` was `-1`, so none of this was answerable. First profile, in a
6h37m window: the `task_list` list query held **22.1%** of all execution time (Prisma's `_count`
compiles to a full aggregate over `task` — `... FROM task WHERE $4=$5 GROUP BY list_id` — 111,717
rows scanned to produce 13), and `temp_blks_written` was **zero database-wide**, which is how we
learned the 1.36TB in section 4 is historical rather than current.

## 3. Largest tables and indexes

Every schema, not just `public`: the 2026-08-19 recovery left `recovery_import_20260819` and
`recovery_quarantine_20260819` behind, and an unqualified table name silently misses them.
`toast` is broken out because a table whose heap is tiny next to its total is not bloated — its
bytes are compressed values out of line, which `VACUUM` cannot reclaim.

```
                    relation                     |  total  |  heap   | indexes |  toast  | reltuples_est 
-------------------------------------------------+---------+---------+---------+---------+---------------
 public.run_event                                | 6065 MB | 3299 MB | 1650 MB | 1117 MB | 12,436,804
 public.tool_call                                | 1044 MB | 321 MB  | 44 MB   | 679 MB  | 404,020
 public.task                                     | 966 MB  | 160 MB  | 187 MB  | 618 MB  | 111,719
 public.attachment                               | 595 MB  | 416 kB  | 288 kB  | 594 MB  | 1,739
 public.executable_runtime_heartbeat             | 186 MB  | 117 MB  | 68 MB   | 64 kB   | 131,067
 public.session_diff                             | 86 MB   | 440 kB  | 88 kB   | 86 MB   | 1,896
 public.session                                  | 80 MB   | 9352 kB | 53 MB   | 19 MB   | 5,320
 recovery_import_20260819.source_run_event       | 80 MB   | 35 MB   | 0 bytes | 46 MB   | 116,721
 recovery_import_20260819.source_tool_call       | 60 MB   | 15 MB   | 0 bytes | 45 MB   | 18,155
 recovery_import_20260819.task_recovery_manifest | 57 MB   | 54 MB   | 3416 kB | 24 kB   | 109,968
(10 rows)

```

### Largest indexes, with their scan counts

`idx_scan = 0` is trustworthy here only because `pg_stat_database.stats_reset` is empty for
this database — the counters have never been reset, so a zero is the whole history rather than
a recently cleared slate. That is the self-proof that retired the 389MB duplicate index; any
future candidate has to earn the same one.

```
              relation               |                  index                  |  size  | idx_scan | idx_tup_read 
-------------------------------------+-----------------------------------------+--------+----------+--------------
 public.run_event                    | run_event_session_id_seq_key            | 817 MB | 17231653 |   1049474816
 public.run_event                    | run_event_pkey                          | 498 MB | 16945131 |       114157
 public.run_event                    | run_event_text_trgm                     | 134 MB |     2294 |       623995
 public.run_event                    | run_event_turn_id_idx                   | 129 MB |    64338 |     89673235
 public.run_event                    | run_event_renderable_idx                | 70 MB  |   379483 |     48255983
 public.session                      | session_search_trgm                     | 50 MB  |     1981 |       224316
 public.task                         | task_project_rollup_covering_idx        | 27 MB  |    13317 |     84399357
 public.tool_call                    | tool_call_session_id_tool_use_id_idx    | 26 MB  |  2323813 |      2451659
 public.task                         | task_title_search_trgm                  | 20 MB  |     1566 |         5815
 public.executable_runtime_heartbeat | executable_runtime_heartbeat_latest_idx | 20 MB  |     4500 |      2956369
(10 rows)

```

Index bytes per million rows for the table that dominates the disk, which is the reading that
survives the table's growth rate:

```
 run_event_indexes |  rows_est  | mb_per_million_rows 
-------------------+------------+---------------------
 1650 MB           | 12,436,804 |               132.7
(1 row)

```

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

## 4. Temporary file usage (pg_stat_database)

```
 datname | temp_files | temp_bytes | avg_per_file | stats_reset |        logging        |     work_mem      
---------+------------+------------+--------------+-------------+-----------------------+-------------------
 orbit   |     330348 | 1367 GB    | 4338 kB      |             | 1024 (log_temp_files) | 4096kB (work_mem)
(1 row)

```

**Baseline.** 2026-09-15: 1360GB across 329,939 files, averaging 4.3MB each — right at the
`work_mem` spill line.

**These two counters are cumulative and `stats_reset` is empty, so they carry no time
dimension.** The absolute number answers nothing on its own; the delta between two of these
reports does. That distinction matters: the 1.36TB looks like a live emergency and is not one —
across 2026-09-15 → 09-17 the measured rate was 0.45 files/hour against a 148/hour historical
average, a 329× difference, corroborated by zero `temp_blks_written` in section 2 and zero
`temporary file` lines in the container log. Chase the rate, not the total.

## 5. Long transactions and long idle connections

Three different conditions, with three different costs and three different parameters that end
them, so the report keeps them apart:

```
 pid | state | xact_age | state_age | cost_and_lever | usename | application_name | wait_event_type | query 
-----+-------+----------+-----------+----------------+---------+------------------+-----------------+-------
(0 rows)

```

An empty table means nothing crossed a threshold. For context, the longest-lived connections
regardless of threshold:

```
  pid   | state | state_age | application_name |                      query                       
--------+-------+-----------+------------------+--------------------------------------------------
  90150 | idle  | 03:36:20  |                  | LISTEN orbit_inbox
 111643 | idle  | 00:00:05  |                  | SELECT pg_notify($1, $2)
 111477 | idle  | 00:00:05  |                  | SELECT pg_notify($1, $2)
 111683 | idle  | 00:00:05  |                  | SELECT pg_notify($1, $2)
 111312 | idle  | 00:00:02  |                  | SELECT "public"."project_criteria_authorship"."d
(5 rows)

```

**Baseline.** 2026-09-15 turned up a connection (pid 1909054) that had been idle for **12 days**.

**With a correction this report exists to keep making.** That connection's state was `idle`, not
`idle in transaction`, and its `xact_start` was empty: it held no locks and pinned no xmin, so its
real cost was one connection slot. The parameter that would have ended it is `idle_session_timeout`
(PG 14+), **not** `idle_in_transaction_session_timeout`. All three timeouts are still `0` on this
server, which is a structural risk — nothing stops a future forgotten transaction — rather than a
past incident. Read the `state` column before naming the lever.

## 6. Bloat signs (n_dead_tup and last_autovacuum)

Estimates from `pg_stat_user_tables`, which is free. Exact bloat measurement is deliberately
not attempted: it would read every page of these tables.

```
            relation             | n_dead_tup | own_trigger_line | pct_of_line | n_live_tup | dead_pct |        last_autovacuum        | autovacuum_age |       last_autoanalyze        | autovacuum_count 
---------------------------------+------------+------------------+-------------+------------+----------+-------------------------------+----------------+-------------------------------+------------------
 public.tool_call                |      34965 |            80854 |        43.2 |     408349 |      7.9 | 2026-09-05 10:29:51.451284+00 | 13 days        | 2026-09-18 00:53:20.146525+00 |                1
 public.task_dependency_revision |      15191 |            22270 |        68.2 |     111738 |     12.0 | 2026-08-26 03:51:46.711564+00 | 23 days        | 2026-08-29 21:21:32.175997+00 |                8
 public.task_dispatch_epoch      |      14502 |            22270 |        65.1 |     111738 |     11.5 | 2026-08-26 03:52:46.585499+00 | 23 days        | 2026-08-29 21:00:30.924862+00 |                8
 public.conversation_turn        |       3239 |             4024 |        80.5 |      20320 |     13.7 | 2026-09-15 12:28:56.081557+00 | 2 days         | 2026-09-17 15:16:32.62721+00  |               12
 public.session                  |       1110 |             1114 |        99.6 |       5320 |     17.3 | 2026-09-18 05:16:28.074287+00 | 00:00:00       | 2026-09-18 11:03:36.897438+00 |              148
 public.run_event                |       1052 |          2487411 |         0.0 |   13517723 |      0.0 | 2026-09-18 01:29:59.98698+00  | 00:00:00       | 2026-09-18 02:37:23.786549+00 |               10
 public.approval                 |        411 |              477 |        86.2 |       2258 |     15.4 |                               |                | 2026-09-16 00:06:27.589943+00 |                0
 public.project_coordinator_wake |        201 |              386 |        52.1 |       1722 |     10.5 | 2026-09-16 00:07:27.862566+00 | 2 days         | 2026-09-18 00:45:17.545089+00 |                9
 public.attachment               |        152 |              398 |        38.2 |       1777 |      7.9 | 2026-09-05 06:09:26.478044+00 | 13 days        | 2026-09-17 06:06:02.095805+00 |                1
 public.task_dependency          |        126 |            20477 |         0.6 |     110862 |      0.1 | 2026-08-29 15:08:22.026171+00 | 19 days        | 2026-08-29 18:16:26.164728+00 |                8
(10 rows)

```

`own_trigger_line` is each table's own vacuum trigger point and `pct_of_line` is how far into
it the table is. Read the line before the reading: the scale factor is proportional to table
size, so the trigger point recedes as a table grows and the same `n_dead_tup` means different
things on a 400k-row table and on a 5k-row one. The Alerts section counts the tables **past
that line** with no autovacuum for 7d, which is the combination worth
acting on: a stale `last_autovacuum` beside a table that should already have been vacuumed. A
table below its line is autovacuum working as configured.

**Baseline.** 2026-09-15: `tool_call` had 24,497 dead tuples and its `last_autovacuum` was
stuck at **2026-09-05**.

*A note on `n_live_tup` in this table:* it is the same counter that reset with the 2026-08-21
postmaster restart, so treat it as a denominator for `dead_pct`, not as a row count. Section 3's
`reltuples_est` is the number to quote for size.
