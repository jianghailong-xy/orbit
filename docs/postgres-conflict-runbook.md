# PostgreSQL conflict runbook

What to look at when the API server starts answering `503 TRANSIENT_DB_CONFLICT`, how to tell the
five things that produce one apart, and how to deploy and roll back the changes that made them
survivable.

The mechanism itself is documented elsewhere and is not repeated here: `withTransactionRetry` and
the classifier in [the database write audit](db-write-audit.md), the lock order the retries sit on
in [the canonical lock order](postgres-lock-order.md), and the fixtures that reproduce the two
production deadlocks in [the barrier fixture](postgres-deadlock-barrier.md). This page is the
operational half: the numbers, the thresholds, the log correlation and the release procedure.

## The counters

`GET /api/metrics`, Prometheus text exposition format (`version=0.0.4`), behind the same bearer
token as every other route.

```bash
curl -sS -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/metrics
```

```yaml
# prometheus.yml — the token is a normal Orbit access token; keep it in a file, not in the config.
scrape_configs:
  - job_name: orbit-apiserver
    metrics_path: /api/metrics
    scheme: https
    authorization:
      credentials_file: /etc/prometheus/orbit-token
    static_configs:
      - targets: ['orbit.example.com']
```

Three metrics, all with low-cardinality labels only. There is no task id, session id, request id,
user, workspace or route parameter anywhere in them; the values come from closed sets or from shape
tests, and the registry folds anything unexpected into a constant rather than growing a series for
it (`src/apiserver/src/common/db-conflict-metrics.ts`).

| Metric | Type | Labels |
| --- | --- | --- |
| `orbit_db_transaction_units_total` | counter | `operation`, `outcome`, `handling`, `classifier`, `sqlstate`, `attempt`, `origin` |
| `orbit_db_conflict_responses_total` | counter | `method`, `route`, `handling`, `classifier`, `sqlstate`, `origin` |
| `orbit_db_transaction_duration_ms` | histogram | `operation`, `outcome`, `handling`, `origin` |

`orbit_db_transaction_units_total` counts **units of work**: exactly one increment per transaction
that settled, whatever happened inside it. That makes it the denominator of every rate below.

* `operation` — the name the write gave itself, e.g. `tasks.create`, `runnerApi.events`. Every one
  is a literal in the source; a static test refuses a computed one.
* `outcome` — `committed`, `conflict` (a conflict outlived the attempts), `failed` (something that
  is not a conflict).
* `handling` — `none`, `absorbed` (a retry re-ran it and it committed), `exhausted`.
* `classifier` — `none`, `deadlock`, `serialization`, `write_conflict`, `resource`, `permanent`,
  `answered` (a refusal some layer had already turned into an HTTP answer), `unclassified`.
* `sqlstate` — the code that decided it (`40P01`, `40001`, `P2034`, `23505`, …), `message` when only
  the driver's wording survived the wrapping, `none`, or `other`.
* `attempt` — attempts spent, including the first.
* `origin` — `service`, or `fault_injection` when `ORBIT_DB_CONFLICT_ORIGIN=fault_injection` is set
  in the process environment. **Every query below filters on `origin="service"`.**

`orbit_db_conflict_responses_total` counts **callers turned away**: one increment per typed 503.
`handling` is `exhausted` when a retry loop had already tried, `boundary_only` when nothing did.

`orbit_db_transaction_duration_ms` is the wall time of the whole unit, across every attempt and
every backoff between them — what the caller waited, not what one attempt took.

Counters are per process and start at zero when a replica restarts. Use `rate()`/`increase()`;
raw values across a deploy are meaningless.

## Telling the five apart

This is the whole point of the labels. In an incident these look identical in a log and are five
different problems.

### 1. A fault injected on purpose

```promql
sum by (operation) (rate(orbit_db_transaction_units_total{origin="fault_injection"}[5m]))
```

`scripts/deadlock-barrier.sh`, `scripts/project-pg-matrix.sh` and the fault-injection suites create
real deadlocks — that is what they are for — and they export `ORBIT_DB_CONFLICT_ORIGIN=fault_injection`
in the environment of every test process they start, so their conflicts label themselves. No
production code path can set it. **Action: none.** If this is non-zero on a scraped production
process, something is running a test suite against it, which is its own problem.

A harness that starts a test process without it is the mirror image of that problem, and it is
visible in the harness rather than in a graph: `transaction-retry.pg.spec.ts` asserts both the label
on its own two injected conflicts and that the variable is set at all, so it reports 4/6 rather than
6/6. Anything new that makes conflicts on purpose exports the variable to its children.

### 2. Contention a retry absorbed

```promql
sum by (operation) (rate(orbit_db_transaction_units_total{origin="service", handling="absorbed"}[5m]))
```

The database rolled a transaction back, the loop re-ran the whole closure, and it committed. **No
caller saw anything.** This is the system working, and a low steady rate under concurrency is
normal. What matters is the trend and the share:

```promql
sum(rate(orbit_db_transaction_units_total{origin="service", handling=~"absorbed|exhausted"}[5m]))
  / sum(rate(orbit_db_transaction_units_total{origin="service"}[5m]))
```

A rising share is contention rising with the retries still hiding it. It is the early warning for
(3): the same lock cycle that backoff absorbs at low volume exhausts at high volume.

### 3. A lock-order defect

```promql
sum by (operation, classifier) (rate(orbit_db_transaction_units_total{origin="service", handling="exhausted"}[5m]))
```

Exhaustion with `classifier="deadlock"`, repeatedly, on the same operation. Backoff cannot fix a
lock-order defect: two transactions that take the same rows in opposite orders will form the cycle
again on every attempt, so spacing them out only spends the attempt budget. A serialization
exhaustion (`classifier="serialization"`) reads differently — it means sustained write contention on
one row set rather than a cycle.

**Action:** identify the two operations involved (the metric names one side; the PostgreSQL log
names both — see below), then check them against
[the canonical lock order](postgres-lock-order.md) §1 and the entry for each in
`src/apiserver/src/common/db-write-inventory.ts`. A write whose `locks` line disagrees with the
partial order is the bug.

### 4. The database itself in trouble

```promql
sum by (sqlstate) (rate(orbit_db_transaction_units_total{origin="service", classifier="resource"}[5m]))
```

SQLSTATE classes `08` (connection), `53` (out of connections, memory or disk), `57` (cancelled,
shutting down, dropped) and `58` (the file system). These are **not retried** — re-running a unit of
work against a server with no connections left only spends latency on the same answer — and they are
the one `retryable: false` that means somebody should be woken up. `53300 too_many_connections` in
particular is usually a symptom of something else holding transactions open.

**Action:** page. Then `pg_stat_activity`, connection-pool size, disk, and the PostgreSQL log.

### 5. A path with no retry at all

```promql
sum by (route, classifier) (rate(orbit_db_conflict_responses_total{origin="service", handling="boundary_only"}[15m]))
```

A conflict that reached the API boundary without any retry loop having tried. Two things produce it,
and they need different responses:

* **an autocommit statement**, of which there are around a hundred (`STATEMENT_UNITS` in the
  inventory). PostgreSQL wraps each in an implicit single-statement transaction; there is no closure
  to re-run, so these are deliberately not retried and the typed 503 is the intended answer. This is
  by design, and the class argument is in `STATEMENT_CLASSES`.
* **a new transaction boundary that does not go through the shared loop.** Every one in the tree
  currently does, and `db-write-inventory.spec.ts` fails when one appears that does not — so this
  should not happen, and if it does, the inventory is what to check first.

**Action:** find the route's write in the inventory. If it is an `AUTOCOMMIT` entry, the answer is
correct and the question is why that statement is losing conflicts. If it is a transaction, it has
escaped the shared retry.

## Alerting

Thresholds are **starting points**, not universal truths: set them from a week of your own baseline.
The shape of the rules is the part that transfers.

```yaml
groups:
  - name: orbit-db-conflicts
    rules:
      # (4) The database, not the code. Nothing here is retried and nothing recovers on its own.
      - alert: OrbitDatabaseResourceFault
        expr: sum(rate(orbit_db_transaction_units_total{origin="service", classifier="resource"}[5m])) > 0
        for: 2m
        labels: { severity: page }
        annotations:
          summary: PostgreSQL is refusing work for a resource reason (see sqlstate)

      # (3) Retries are no longer absorbing conflicts; callers are being turned away.
      - alert: OrbitConflictRetriesExhausted
        expr: sum by (operation) (rate(orbit_db_transaction_units_total{origin="service", handling="exhausted"}[5m])) > 0
        for: 10m
        labels: { severity: page }
        annotations:
          summary: '{{ $labels.operation }} is spending its whole retry budget on conflicts'

      # (3), the sharper form: a cycle backoff cannot break.
      - alert: OrbitLockOrderSuspected
        expr: sum by (operation) (rate(orbit_db_transaction_units_total{origin="service", handling="exhausted", classifier="deadlock"}[15m])) > 0.01
        for: 15m
        labels: { severity: page }
        annotations:
          summary: '{{ $labels.operation }} keeps losing deadlocks after every retry'

      # (2) The early warning. Contention is rising; the retries are still hiding it.
      - alert: OrbitConflictRateElevated
        expr: |
          sum(rate(orbit_db_transaction_units_total{origin="service", handling=~"absorbed|exhausted"}[10m]))
            / sum(rate(orbit_db_transaction_units_total{origin="service"}[10m])) > 0.05
        for: 30m
        labels: { severity: ticket }
        annotations:
          summary: over 5% of database transactions are paying for a conflict

      # (5) A write path that reaches the floor without a retry.
      - alert: OrbitUnretriedConflictPath
        expr: sum by (route) (rate(orbit_db_conflict_responses_total{origin="service", handling="boundary_only"}[15m])) > 0
        for: 15m
        labels: { severity: ticket }
        annotations:
          summary: '{{ $labels.route }} is answering 503 with no retry behind it'

      # What the retries cost. A unit that used to take 20ms and now takes a second is a
      # user-visible regression even when every conflict is absorbed.
      - alert: OrbitTransactionSlow
        expr: |
          histogram_quantile(0.99,
            sum by (le, operation) (rate(orbit_db_transaction_duration_ms_bucket{origin="service"}[10m]))) > 1000
        for: 15m
        labels: { severity: ticket }
        annotations:
          summary: 'p99 of {{ $labels.operation }} is over a second'
```

Without a Prometheus, the same reading by hand:

```bash
# every conflict this replica has seen since it started
curl -sS -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/metrics \
  | grep '^orbit_db_transaction_units_total' | grep -v 'handling="none"'

# only the ones that were not absorbed
curl -sS -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/metrics \
  | grep -E 'handling="(exhausted|boundary_only)"'
```

## Correlating with the PostgreSQL log

The API server's own logs deliberately carry **no SQL, no table, no parameter and no stack** — the
error object is never logged, because it is the one place a prompt, a token or a bound parameter can
appear. So the statement that formed a cycle is only in the PostgreSQL log, and correlation is the
procedure.

Enable it once, on the server:

```ini
# postgresql.conf
log_lock_waits = on            # a wait longer than deadlock_timeout is logged with its blocker
deadlock_timeout = '1s'        # also the threshold above; the default
log_line_prefix = '%m [%p] %q%u@%d app=%a '   # timestamp, pid, user, database, application_name
log_min_error_statement = error
```

```bash
docker compose exec postgres psql -U orbit -c "ALTER SYSTEM SET log_lock_waits = on"
docker compose exec postgres psql -U orbit -c "SELECT pg_reload_conf()"
```

Three sources, in the order to read them:

1. **The metric** says WHICH operation and WHICH SQLSTATE, with no timestamp finer than the scrape.
2. **The API server log** says WHEN and how hard it tried. One line per retried transaction:

   ```
   WARN [TasksService] operation=tasks.create outcome=RETRYING attempt=1/4 sqlstate=40P01
   WARN [TasksService] operation=tasks.create outcome=EXHAUSTED attempt=4/4 sqlstate=40P01
   ```

   and one per conflict that reached the boundary:

   ```
   WARN [TransientDbConflict] DEADLOCK reached the API boundary · answered 503 TRANSIENT_DB_CONFLICT · evidence=40P01 depth=2 · POST /tasks
   ```

   ```bash
   docker compose logs apiserver --since 30m | grep -E 'outcome=(EXHAUSTED|RETRYING)|reached the API boundary'
   ```

3. **The PostgreSQL log** says WHAT the cycle was made of. A `40P01` is logged by the server with
   both sides of it:

   ```
   ERROR:  deadlock detected
   DETAIL:  Process 4711 waits for ShareLock on transaction 90210; blocked by process 4712.
           Process 4712 waits for ShareLock on transaction 90209; blocked by process 4711.
           Process 4711: UPDATE "task" SET "updated_at" = $1 WHERE "id" = $2
           Process 4712: INSERT INTO "session" ...
   CONTEXT:  while updating tuple (0,17) in relation "task"
   ```

   ```bash
   # the deadlocks and their two sides, with the lock waits that preceded them
   docker compose logs postgres --since 30m | grep -A6 -E 'deadlock detected|still waiting for'
   ```

   Match by the API server's timestamp window. The `DETAIL` block names both relations and both
   statements; the API server only ever knows the one it was running, which is why this step is not
   optional for a lock-order defect.

While it is happening, the live view — who is waiting on whom, right now:

```sql
SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blocked_by,
       left(a.query, 120) AS query
  FROM pg_stat_activity a
 WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
```

And the server's own count, as a cross-check on the application's — these two should move together,
and a divergence means conflicts are being lost somewhere between the server and the counter:

```sql
SELECT datname, deadlocks, xact_rollback, stats_reset
  FROM pg_stat_database WHERE datname = current_database();
```

## Deploying

The API server image runs `prisma migrate deploy` and then starts (`src/apiserver/Dockerfile`), so
**migrations always land before the code that needs them** and there is no separate step to
sequence. Nothing in this work needs a maintenance window: the two migrations it depends on take
brief locks and rewrite no rows.

The ordinary upgrade from [self-hosting](self-hosting.md#upgrading) is the whole procedure:

```bash
git fetch --tags && git checkout <release-tag-or-reviewed-commit>
ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" docker compose up -d --build
docker compose logs apiserver --since 5m | grep -E 'migration|listening'
```

Migrations involved:

* **0132** `task_dependency_revision` — adds a table, seeds one row per Task, installs a deferred
  commit-boundary check. Details, including the rollback script, in
  [task dependency revision](task-dependency-revision.md) §5.
* **0133** `session_event_source_update_scope` — replaces one trigger with a narrower one. No column,
  no row, no backfill; re-applicable any number of times. Details in
  [the Session event source scope](session-event-trigger-scope.md).

The observability in this page is **application-only**: no migration, no schema, no new
configuration except the optional `ORBIT_DB_CONFLICT_ORIGIN` that only a test harness sets. The
`/api/metrics` route appears when the new image starts and disappears when it is rolled back.

After the deploy, confirm the counters exist and are moving:

```bash
curl -sS -H "Authorization: Bearer $ORBIT_TOKEN" https://orbit.example.com/api/metrics \
  | grep -c '^orbit_db_transaction_units_total'   # non-zero once any write has run
```

## Old and new schema together

Both migrations are safe with mixed replica versions, in both directions but **not symmetrically**.

| | database before 0132/0133 | database at 0132+0133 |
| --- | --- | --- |
| **API server before this work** | the state this work started from | **safe.** The narrowed Session trigger is a strict subset of the old one, so events it used to raise it still raises. A dispatch that skips the revision lock is refused at COMMIT by `session_dispatch_dependency_check` and rolled back whole — visible as `DISPATCH_DEPENDENCY_CHANGED`, never as a wrong dispatch. Tasks it creates still get their revision row, because the seed is a trigger in the database. |
| **API server with this work** | **not supported.** The dispatch decision reads `task_dependency_revision`, which does not exist; dispatch errors rather than dispatching. Nothing writes wrong data, but the coordinator stops. | the target state |

The consequence for procedure: **the database may lead the application, never the other way round.**
The image's boot sequence enforces that on the way up. On the way down it is a decision — see below.

During a rolling upgrade, one number is expected to be briefly non-zero and must return to zero:

```sql
-- old replicas being refused at the commit boundary. Non-zero during the window is the guard
-- working; non-zero afterwards means a dispatch path is not going through the fencing transaction.
SELECT count(*) FROM "project_action"
 WHERE "type" = 'DISPATCH_TASK' AND "status" = 'CLAIMED'
   AND "created_at" < now() - interval '10 minutes';
```

## Rolling the application back

Deploy the previous image. There is nothing to undo in the database, and the migrations do **not**
have to be reverted:

```bash
git checkout <previous-release-tag>
docker compose up -d --build apiserver
```

What changes while the old image runs against a 0132/0133 database:

* **conflicts stop being retried and stop being typed.** A `40P01`, a `40001` and a `P2034` become
  `500` again, with whatever the service happened to do about them before. Clients see an error that
  is not marked retryable; the CLI and the web will show a generic failure.
* **`/api/metrics` 404s.** Alerts on the metrics above will go stale, not fire — configure `absent()`
  on the target if that matters to you.
* **dispatch is refused rather than wrong**, as in the table above, and the reconciler retries it.

**Do not roll the database below 0132 while any replica is running this work.** The floor is a real
one: the dispatch decision queries `task_dependency_revision` by name, and a database without it
produces a hard error on every decision. If the migration itself must be reverted, take the
application down to the pre-0132 build **first**, then run `ROLLBACK_0132` (defined in
`src/apiserver/src/deadlock/dependency-revision-fixture.ts`, and exercised by
`scripts/deadlock-barrier.sh dependency-revision`), which reinstalls the old `task.updated_at` touch
**before** it drops the revision table so the dispatch boundary exists at every instant of the
window. 0133 needs no revert at all; if you want the old trigger back, the statements are in
[the Session event source scope](session-event-trigger-scope.md).

## Data checks

Run these after an upgrade, after a rollback, and whenever a conflict incident makes you wonder
whether a transaction committed half of itself. Each is a count that must be zero, or a definition
that must match. All five were run against a database at 0133.

```bash
psql "$DATABASE_URL" -f - <<'SQL'
-- 1. Every Task has its dispatch version row (migration 0132's invariant, maintained by trigger).
--    Non-zero means a Task exists that dispatch cannot lock, which is the phantom 0132 closes.
SELECT count(*) AS tasks_without_revision
  FROM "task" t
  LEFT JOIN "task_dependency_revision" r ON r."task_id" = t."id"
 WHERE r."task_id" IS NULL;

-- 2. What the Session event source is actually declared over. After 0133 there must be exactly two:
--    an unconditional INSERT OR DELETE trigger, and an UPDATE trigger declared over
--    status, deleted_at and merge_status with a WHEN that requires the value to have changed.
--    A single AFTER INSERT OR UPDATE OR DELETE row means 0133 is not applied (or was rolled back).
SELECT tgname, pg_get_triggerdef(oid)
  FROM pg_trigger
 WHERE tgrelid = '"session"'::regclass AND NOT tgisinternal
   AND tgname LIKE 'project_session_event_source%'
 ORDER BY tgname;

-- 3. Dispatch claims a refused or aborted commit left behind. Expected zero outside an upgrade
--    window; see "Old and new schema together".
SELECT count(*) AS stuck_dispatch_claims
  FROM "project_action"
 WHERE "type" = 'DISPATCH_TASK' AND "status" = 'CLAIMED'
   AND "created_at" < now() - interval '10 minutes';

-- 4. The server's own conflict tally, to compare with the application counters.
SELECT datname, deadlocks, xact_rollback, stats_reset
  FROM pg_stat_database WHERE datname = current_database();

-- 5. Anything currently blocked, and by whom.
SELECT a.pid, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blocked_by,
       left(a.query, 120) AS query
  FROM pg_stat_activity a
 WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
SQL
```

There is deliberately no "find the half-committed batch" query, because there cannot be one. A
transaction PostgreSQL aborts is aborted whole: nothing it wrote is visible, which is why re-running
the closure is the correct response and why the barrier regressions assert the victim left no
partial Task, no partial dependency set and no orphan `project_event`
([the barrier fixture](postgres-deadlock-barrier.md) §4 and §9). If a partial write is ever
observed, that is not a conflict — it is a bug in a unit that spans more than one transaction, and
the inventory is where to look for one.

## What a client sees

Never SQL, a table name, a parameter, a prompt, a credential or a stack. The whole answer is a
constant declared once in `src/shared/src/dbConflict.ts` and served by
`src/apiserver/src/common/transient-db-conflict.filter.ts`:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 1
Content-Type: application/json

{
  "statusCode": 503,
  "error": "Service Unavailable",
  "code": "TRANSIENT_DB_CONFLICT",
  "message": "the database rolled this request back to break a conflict with a concurrent write; nothing was saved, so the same request can be sent again",
  "retryable": true,
  "retryAfterSeconds": 1
}
```

All three of `40P01`, `40001` and `P2034` produce this identical answer — the difference between
them is about the server's locking and would tell a caller nothing it could act on. The three
consumers agree on it by construction: the web imports the same builder (`src/web/src/api.test.ts`),
and the Go CLI mirrors the constants with a test that reads the shared file and fails when it
changes (`src/runner-go/transient_db_conflict_test.go`).

## Running the evidence

```bash
# the counters, the label rules, the security claims and the API/CLI/Web contract (no database)
npm test -w @orbit/apiserver
npm test -w @orbit/shared && npm test -w @orbit/web
( cd src/runner-go && go test -run TransientDBConflict ./... )

# the counters against conflicts a real PostgreSQL raised, on a disposable server
scripts/deadlock-barrier.sh retry
```

## Related

- [The database write audit](db-write-audit.md) — every write, its lock order and its retry decision.
- [The canonical lock order](postgres-lock-order.md) — the partial order a lock-order defect violates.
- [PostgreSQL lock-order barrier fixture](postgres-deadlock-barrier.md) — the two reproduced
  production deadlocks and their lock graphs.
- [Task dependency revision](task-dependency-revision.md) and
  [the Session event source scope](session-event-trigger-scope.md) — the two migrations, their
  upgrade and rollback procedures in full.
- [Postgres backup and restore](postgres-backup-restore.md) — for the failures this page is not about.
