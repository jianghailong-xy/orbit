# Postgres checkup — 2026-09-17T23:58:12Z

Produced by `scripts/pg-checkup.sh` against container `orbit-postgres`, database `orbit`
(8736 MB); re-run that script to refresh this file. Read-only; no table is scanned.
Baselines quoted per section come from the capacity-governance project's 2026-09-15 first
measurement, with its 2026-09-17 recheck where one exists — so each section reads as
before → now.

Thresholds: disk 85%, transaction 300s, idle-in-transaction 300s,
idle 24h, dead tuples 10000 with autovacuum older than 7d.

## Alerts

- **DISK 89%** of / used, 22 GB free (threshold 85%)
- **3 table(s)** over 10000 dead tuples with no autovacuum in 7 days

## 1. Disk water level

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       197G  167G   23G  89% /

database size: 8736 MB
```

**Baseline.** `/` is 197G on this host. 2026-09-15: **100% full**, and Postgres logged
`ENOSPC` 288 times — that is how the incident was discovered. 2026-09-17: 88% (23G free).
Now: 89% (22G free of 196G).

The database is not the only writer on this filesystem (container logs have no rotation), but
per section 3 it is the largest one, so disk relief has to come from there.

## 2. Top SQL

`pg_stat_statements` has been accumulating for **00d 06h** (`.save=on`, so it survives
restarts — ask `pg_stat_statements_info.stats_reset` how long the window is, never
`pg_postmaster_start_time()`). `.track=top` keeps `total_exec_time` additive, which is what
makes the share column meaningful.

### By total execution time

```
                                             query                                             | calls | total_s | mean_ms  | pct_of_total 
-----------------------------------------------------------------------------------------------+-------+---------+----------+--------------
 SELECT "public"."task_list"."id", "public"."task_list"."title", "public"."task                |  1692 |   385.3 |   227.74 |         17.9
 SELECT t.id, t.owner_id AS "ownerId", a.id AS "workspaceId", a.runner_id AS "r                |   407 |   108.0 |   265.28 |          5.0
 SELECT "public"."runner"."id", "public"."runner"."name", "public"."runner"."di                | 39279 |    94.3 |     2.40 |          4.4
 -- 会话生命周期分布 与 其持有的 run_event 行数 select case when s.deleted_at is not null then |     1 |    92.5 | 92548.81 |          4.3
 SELECT MAX("seq") AS "_max$seq" FROM (SELECT "public"."run_event"."seq" FROM "                |  3646 |    92.2 |    25.28 |          4.3
 SELECT count(*)::int AS count FROM task t WHERE t.owner_id = $1::uuid AND t.li                |  1679 |    79.0 |    47.06 |          3.7
 select date_trunc($1, created_at)::date d, count(*) rows, count(*) filter (whe                |     1 |    76.6 | 76585.96 |          3.6
 SELECT t.id, t.owner_id AS "ownerId", t.assignee_id AS "workspaceId", a.runner                |   408 |    67.4 |   165.19 |          3.1
 SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration", "inbox_lease_ow                | 41175 |    57.8 |     1.40 |          2.7
 SELECT c.id, c.owner_id AS "ownerId", a.id AS "workspaceId", a.runner_id AS "r                |   408 |    48.9 |   119.84 |          2.3
(10 rows)

```

### By temporary blocks written

Anything with a non-zero count here spilled out of `work_mem` (4MB) to disk, which is both
slower and a claim on the filesystem in section 1.

```
                                             query                                             | calls | temp_blks_written | temp_written | total_s 
-----------------------------------------------------------------------------------------------+-------+-------------------+--------------+---------
 select date_trunc($1, created_at)::date d, count(*) rows, count(*) filter (whe                |     1 |            731045 | 5711 MB      |    76.6
 select count(*) as total_tasks, count(*) filter (where list_id is not null) as                |     1 |               273 | 2184 kB      |     0.3
 SELECT "public"."task_list"."id", "public"."task_list"."title", "public"."task                |  1692 |                 0 | 0 bytes      |   385.3
 SELECT t.id, t.owner_id AS "ownerId", a.id AS "workspaceId", a.runner_id AS "r                |   407 |                 0 | 0 bytes      |   108.0
 SELECT "public"."runner"."id", "public"."runner"."name", "public"."runner"."di                | 39284 |                 0 | 0 bytes      |    94.4
 -- 会话生命周期分布 与 其持有的 run_event 行数 select case when s.deleted_at is not null then |     1 |                 0 | 0 bytes      |    92.5
 SELECT MAX("seq") AS "_max$seq" FROM (SELECT "public"."run_event"."seq" FROM "                |  3646 |                 0 | 0 bytes      |    92.2
 SELECT count(*)::int AS count FROM task t WHERE t.owner_id = $1::uuid AND t.li                |  1679 |                 0 | 0 bytes      |    79.0
 SELECT t.id, t.owner_id AS "ownerId", t.assignee_id AS "workspaceId", a.runner                |   408 |                 0 | 0 bytes      |    67.4
 SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration", "inbox_lease_ow                | 41176 |                 0 | 0 bytes      |    57.8
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
 public.run_event                                | 5362 MB | 2865 MB | 1392 MB | 1104 MB | 11,227,203
 public.tool_call                                | 1027 MB | 314 MB  | 43 MB   | 671 MB  | 383,941
 public.task                                     | 966 MB  | 160 MB  | 187 MB  | 618 MB  | 125,712
 public.attachment                               | 591 MB  | 416 kB  | 288 kB  | 590 MB  | 1,739
 public.executable_runtime_heartbeat             | 186 MB  | 117 MB  | 68 MB   | 64 kB   | 131,067
 public.session_diff                             | 84 MB   | 432 kB  | 80 kB   | 84 MB   | 1,849
 recovery_import_20260819.source_run_event       | 80 MB   | 35 MB   | 0 bytes | 46 MB   | 116,721
 public.session                                  | 79 MB   | 9352 kB | 52 MB   | 18 MB   | 5,278
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
 public.run_event                    | run_event_session_id_seq_key            | 686 MB | 15327273 |    959297437
 public.run_event                    | run_event_pkey                          | 396 MB | 15053265 |       114157
 public.run_event                    | run_event_text_trgm                     | 132 MB |     2287 |       621867
 public.run_event                    | run_event_turn_id_idx                   | 109 MB |    42559 |     72727077
 public.run_event                    | run_event_renderable_idx                | 69 MB  |   357260 |     45228502
 public.session                      | session_search_trgm                     | 49 MB  |     1981 |       224316
 public.task                         | task_project_rollup_covering_idx        | 27 MB  |    13301 |     83630165
 public.tool_call                    | tool_call_session_id_tool_use_id_idx    | 25 MB  |  2296884 |      2425527
 public.task                         | task_title_search_trgm                  | 20 MB  |     1523 |         5682
 public.executable_runtime_heartbeat | executable_runtime_heartbeat_latest_idx | 20 MB  |     4500 |      2956369
(10 rows)

```

Index bytes per million rows for the table that dominates the disk, which is the reading that
survives the table's growth rate:

```
 run_event_indexes |  rows_est  | mb_per_million_rows 
-------------------+------------+---------------------
 1392 MB           | 11,227,203 |               124.0
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
 orbit   |     329974 | 1363 GB    | 4331 kB      |             | 1024 (log_temp_files) | 4096kB (work_mem)
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
  pid  | state | state_age | application_name |                      query                       
-------+-------+-----------+------------------+--------------------------------------------------
  7145 | idle  | 05:40:08  |                  | LISTEN orbit_inbox
 42772 | idle  | 00:00:01  |                  | SELECT pg_notify($1, $2)
 42743 | idle  | 00:00:01  |                  | SELECT pg_notify($1, $2)
 42518 | idle  | 00:00:00  |                  | SELECT "public"."watch_delivery"."id", "public".
 41153 | idle  | 00:00:00  |                  | SELECT "public"."workspace"."id", "public"."work
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
            relation             | n_dead_tup | n_live_tup | dead_pct |        last_autovacuum        | autovacuum_age |       last_autoanalyze        | autovacuum_count 
---------------------------------+------------+------------+----------+-------------------------------+----------------+-------------------------------+------------------
 public.tool_call                |      33270 |     400851 |      7.7 | 2026-09-05 10:29:51.451284+00 | 12 days        | 2026-09-16 05:37:06.999049+00 |                1
 public.task_dependency_revision |      15707 |     111719 |     12.3 | 2026-08-26 03:51:46.711564+00 | 22 days        | 2026-08-29 21:21:32.175997+00 |                8
 public.task_dispatch_epoch      |      14498 |     111719 |     11.5 | 2026-08-26 03:52:46.585499+00 | 22 days        | 2026-08-29 21:00:30.924862+00 |                8
 public.conversation_turn        |       2783 |      20109 |     12.2 | 2026-09-15 12:28:56.081557+00 | 2 days         | 2026-09-17 15:16:32.62721+00  |               12
 public.run_event                |       1196 |   11617179 |      0.0 | 2026-09-16 16:07:38.628476+00 | 1 day          | 2026-09-17 14:42:27.723557+00 |                9
 public.session                  |        479 |       5278 |      8.3 | 2026-09-17 23:56:21.22093+00  | 00:00:00       | 2026-09-17 23:57:14.461904+00 |              138
 public.approval                 |        383 |       2230 |     14.7 |                               |                | 2026-09-16 00:06:27.589943+00 |                0
 public.inbox_lease_generation   |        306 |      10769 |      2.8 |                               |                | 2026-09-16 16:40:25.633908+00 |                0
 public.attachment               |        149 |       1769 |      7.8 | 2026-09-05 06:09:26.478044+00 | 12 days        | 2026-09-17 06:06:02.095805+00 |                1
 public.project_coordinator_wake |        144 |       1665 |      8.0 | 2026-09-16 00:07:27.862566+00 | 1 day          | 2026-09-16 06:47:50.886063+00 |                9
(10 rows)

```

Tables over the alert threshold (10000 dead tuples and no autovacuum for
7d) are counted in the Alerts section. A stale `last_autovacuum` next to
a growing `n_dead_tup` is the signal worth acting on: autovacuum's scale factor is proportional
to table size, so on a large table the trigger point recedes as the table grows.

**Baseline.** 2026-09-15: `tool_call` had 24,497 dead tuples and its `last_autovacuum` was
stuck at **2026-09-05**.

*A note on `n_live_tup` in this table:* it is the same counter that reset with the 2026-08-21
postmaster restart, so treat it as a denominator for `dead_pct`, not as a row count. Section 3's
`reltuples_est` is the number to quote for size.
