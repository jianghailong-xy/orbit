# Narrowing the Session Project-event trigger (migration 0130)

`project_session_event_source` turns a Session's lifecycle into a `project_event` signal. Since
migration 0117 it has been installed as `AFTER INSERT OR UPDATE OR DELETE ON "session"`, so every
UPDATE of a `session` row ran it — and the first thing it did, before looking at a single column,
was two lookups:

```sql
SELECT t."project_id" FROM "task"    t WHERE t."id" = task_id;
SELECT p."id"         FROM "project" p WHERE p."coordinator_session_id" = session_id;
```

Only three columns can make that work produce anything: `status`, `deleted_at` and `merge_status`.
Everything else a `session` row carries is telemetry the runner writes at conversation rate —
`last_turn_at`, `last_tool_use`, `last_assistant_text`, `last_user_text`, `engine_turn_active`,
`context_tokens`, `updated_at` — and one `/events` ingest batch issues several of those UPDATEs
(`runner-api.controller.ts`).

Migration `0130_session_event_source_update_scope` declares the UPDATE half over exactly those
three columns.

## What it changes

| | before 0130 | after 0130 |
| --- | --- | --- |
| INSERT / DELETE | trigger `project_session_event_source` | unchanged, same trigger name |
| UPDATE | same trigger, every column | trigger `project_session_event_source_update`, `UPDATE OF status, deleted_at, merge_status` + `WHEN` those values actually move |
| telemetry-only UPDATE | reads `task` and `project`, enqueues nothing | reads nothing, enqueues nothing |
| every event kind | `session.started/ended/failed/awaiting_input`, `merge.succeeded/conflict` | identical |

Both clauses are needed, and they buy different things:

* **`UPDATE OF`** is evaluated without fetching anything, so a telemetry write never enters the
  after-trigger queue at all. That is what keeps `task` and `project` out of the transaction's lock
  set.
* **`WHEN`** catches the writer that *names* one of the three columns while assigning the value it
  already had — `updateMany({ data: { status: 'RUNNING', lastTurnAt } })` is exactly that shape.
  `UPDATE OF` fires on a column being assigned, not on it changing.

The same predicate is repeated as an early return at the top of the function, ahead of both
lookups. It is not redundant: the function outlives any one trigger definition, so a rolled-back
migration, a hand-installed trigger or a future event type cannot silently restore the lookups.

`merge_error` is deliberately not in the list. The body only ever reads it as payload alongside a
`merge_status` change, so a write that moves it alone has no event — before or after.

## Why the lock set matters

An `AccessShareLock` on `task` conflicts with exactly one thing: `AccessExclusiveLock`, which is
what `ALTER TABLE`, `REINDEX` and `VACUUM FULL` take. Before 0130 every telemetry write queued
behind such a statement, and each one queued while already holding its own `session` row lock — so
a sub-second DDL during a deploy fanned out into blocked runner transactions. A *row* lock on the
associated Task was never the problem (MVCC reads straight through one); the regression asserts
that too, so the distinction is on the record rather than assumed.

Narrowing also moves "a telemetry write enqueues nothing" from a property of the function *body*,
which is one edit away from being false, to a property of the trigger *definition*, which the
planner and the lock manager can both see. `project_event_notify_pending` (0116) is declared the
same way for the same reason.

## Verifying it

```
scripts/deadlock-barrier.sh session-scope     # this migration's regression alone
scripts/deadlock-barrier.sh all               # harness spec, both 40P01 baselines, then this
```

Both provision a disposable PostgreSQL 16, run `prisma migrate deploy` against it and refuse to
touch a shared Orbit database (`src/apiserver/src/projects/coordinator-pg-test-safety.ts`). The
regression is `src/apiserver/src/projects/project-session-event-scope.pg.spec.ts`:

1. **Lock set.** Each telemetry statement is run in its own transaction and the relations the
   backend then holds a lock on are read out of `pg_locks`: `session`, and nothing else. The
   control is a `merge_status` write — the one event-bearing column no *other* Session trigger is
   declared over (0122's capacity fence is `UPDATE OF status, task_id, deleted_at`), so the
   `task`/`project` locks it leaves behind are this trigger's and nobody else's.
2. **Barrier.** One connection holds `task` (then `project`) in `ACCESS EXCLUSIVE MODE` while a
   second does the telemetry write under `lock_timeout = 2s`. It is run against the **pre-0130
   shape first** — 0126's function plus the `AFTER INSERT OR UPDATE OR DELETE` trigger — and
   asserted to fail with `55P03` there. Without that half a green barrier would only prove that
   nothing happens to block, not that the narrowing is what unblocked it.
3. **Event matrix.** Session start and batch coalescing, all six status transitions, a status
   re-asserted without moving, coordinator-session status, soft delete and restore, all four
   `merge_status` values, a lone `merge_error`, and hard delete — against the real migrated schema.
4. **Atomicity.** A rolled-back status change leaves no signal, and a signal that cannot be written
   takes its business row with it.
5. **Re-application.** The migration is applied twice more on top of `migrate deploy`, then
   `pg_get_triggerdef` is asserted column-for-column and the behaviour re-checked.

The two 40P01 baselines are unaffected and were re-run on the same server: both still reproduce
their production cycle 20/20. The narrowing removes work from the telemetry transaction but no edge
of either cycle — neither ever waited on this trigger.

## Upgrading

Nothing to schedule. The migration adds no column, rewrites no row and backfills nothing; it is
`CREATE OR REPLACE FUNCTION` plus `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER`, all of which take
brief locks on `session` and can be re-applied any number of times.

A **mixed-version window is safe in both directions**, because the trigger is the whole contract
and it lives in the database:

* an old apiserver against a 0130 database writes the same UPDATEs it always did; the ones that
  carry an event still carry it;
* a new apiserver against a pre-0130 database gets the old, unconditional trigger — slower, never
  wrong.

## Rolling back

Reverting the application does **not** require reverting the migration; the trigger's behaviour is
a strict subset of the old one's. If the trigger itself must be restored (say, to bisect a signal
that appears to be missing), reinstall the pre-0130 shape:

```sql
-- 1. the pre-0130 function body: re-apply
--    prisma/migrations/0126_project_coordinator_session_lifecycle/migration.sql
-- 2. the pre-0130 trigger:
DROP TRIGGER IF EXISTS "project_session_event_source" ON "session";
DROP TRIGGER IF EXISTS "project_session_event_source_update" ON "session";
CREATE TRIGGER "project_session_event_source"
AFTER INSERT OR UPDATE OR DELETE ON "session"
FOR EACH ROW EXECUTE FUNCTION "project_session_event_source"();
```

Re-applying `0130_session_event_source_update_scope/migration.sql` moves back. Neither direction
touches a row, so no data check is needed after either; `_prisma_migrations` is not rewritten by a
manual `CREATE OR REPLACE`, so a later `migrate deploy` will not try to re-run 0130 on its own.

If a Project ever *does* look stuck after this change, the question is whether a signal is missing,
and it is answerable directly:

```sql
-- pending signals for one project, newest first
SELECT kind, occurrences, occurred_at, last_at
  FROM project_event
 WHERE project_id = :project AND consumed_at IS NULL
 ORDER BY last_at DESC;

-- what the trigger is currently declared over
SELECT tgname, pg_get_triggerdef(oid)
  FROM pg_trigger
 WHERE tgrelid = 'session'::regclass AND NOT tgisinternal
   AND tgname LIKE 'project_session_event_source%';
```

A Session whose `status`, `deleted_at` or `merge_status` moved and which produced no row is a
defect in this migration. A Session that only wrote telemetry and produced no row is this migration
working.
