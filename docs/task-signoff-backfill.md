# HUMAN_SIGNOFF stored-task rollout

Migration `0184_task_signoff_backfill` installs metadata and audit ledgers only. It does not scan
`task`, read `task_comment`, create evidence or requests, or update lifecycle state. Migration
`0179_task_completion_criterion` gives omitted/pre-existing criteria the PostgreSQL constant
default `HUMAN_SIGNOFF` without an `UPDATE`.

## 1. Preflight and invariant counts

Run both count queries before deployment and save their raw output:

```sql
SELECT status, count(*) FROM task GROUP BY status ORDER BY status;

SELECT count(*) AS tasks,
       count(*) FILTER (WHERE status = 'DONE') AS done,
       count(*) FILTER (WHERE status = 'OPEN') AS open
  FROM task;
```

After schema deployment, run and save:

```sql
SELECT completion_criterion, status, count(*)
  FROM task
 GROUP BY completion_criterion, status
 ORDER BY completion_criterion, status;

SELECT count(*) AS tasks,
       count(*) FILTER (WHERE completion_criterion IS NULL) AS criterion_null,
       count(*) FILTER (WHERE status = 'DONE') AS done
  FROM task;
```

The total and every status count must be unchanged. In particular `done` is an equality check,
not a target to be reached by migration.

## 2. Explicit legacy import

An account owner first reads one exact historical comment, writes a structured JSON object that
contains only the facts they reviewed, and records why they accepted that transcription. Then run
one invocation for that one source:

```text
npm run ops:task-signoff-migration -w @orbit/apiserver -- import-comment \
  --owner OWNER --task TASK --source-comment COMMENT --source-session SESSION \
  --evidence-file /path/reviewed-evidence.json \
  --idempotency-key legacy-TASK-v1 \
  --review-note 'Reviewed the exact source comment and transcribed the stated results.'
```

The default is `IN_APP_ONLY`. Add `--device-push` only for a deliberately selected request. The
receipt records importer, server time, source comment/session/author/time, the SHA-256 of the exact
stored comment, the structured-evidence SHA-256, review note and policy. Reusing the same source
and key with the same inputs returns the original revision; changing either side is refused.

There is deliberately no command that enumerates or parses comments. Creating a comment never
calls the import path.

## 3. Missing-request backfill

Use a small batch after the scale estimate. The command selects only non-DONE/non-CANCELLED,
non-retired HUMAN_SIGNOFF tasks that already have a latest evidence revision and lack its exact
request:

```text
npm run ops:task-signoff-migration -w @orbit/apiserver -- backfill \
  --owner OWNER --idempotency-key rollout-0001 --batch-size 250
```

Every created request gets a durable in-app inbox item. With no `--push-task`, every device ledger
is immediately terminal `CANCELLED / POLICY_IN_APP_ONLY`, attempts `0`. Repeat `--push-task TASK`
only for the explicit task allowlist that may become due APNs work. The batch row stores that
sorted allowlist, the fixed selection predicate, actor, size, start/finish, duration and all four
request/inbox/push counters.

Replaying the same key is a read of the same receipt. A new-key rerun should report zero once the
eligible slice is exhausted. Continue with a new key only after inspecting the previous counts;
`FOR UPDATE SKIP LOCKED` and the fact uniqueness constraint make concurrent bounded batches
converge without duplicates.

If an explicitly selected push was filed by an offline operator process, drain the persisted due
ledger through the production worker path:

```text
npm run ops:task-signoff-migration -w @orbit/apiserver -- deliver-due --limit 20
```

Never run a device-push allowlist derived from “all migrated tasks”. A missing allowlist means no
due device work, not “all”.
