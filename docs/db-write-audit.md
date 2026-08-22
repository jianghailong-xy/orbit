# The database write audit

Every place the API server writes to PostgreSQL, what each one locks, and what each one does about
a conflict the server itself raised.

The list is not this document. It is
[`src/apiserver/src/common/db-write-inventory.ts`](../src/apiserver/src/common/db-write-inventory.ts),
because a list in prose is a list that stops being true. This page says what the shape of that
inventory means, what the audit found, and how to re-run the evidence.

## Why a list

"Retry a transaction the server threw away" is one sentence, and it is not enough on its own.
Whether re-running a unit of work is *correct* depends on three things that cannot be read off the
code's shape:

- **identity** — what makes a re-run the same request rather than a second one;
- **replayability** — whether everything the closure decides is re-derived inside it, from rows it
  locked, rather than carried in from a snapshot the server has discarded;
- **effects** — whether anything outside the database was already told the first attempt happened.

So each is stated per entry, and `db-write-inventory.spec.ts` re-scans the tree and fails when a
write appears, moves or changes shape without its entry moving with it.

## What is in it

| | count | what it is |
|---|---:|---|
| `TRANSACTION_UNITS` | 52 | Owns a transaction. This is where the retry decision lives. |
| `TRANSACTION_PARTICIPANTS` | 40 | Writes only through a transaction client its caller owns. |
| `STATEMENT_UNITS` | 102 | Runs outside any transaction, in one of five classes. |
| `TRIGGER_WRITE_SOURCES` | 63 | Derived by replaying every `CREATE`/`DROP TRIGGER` in migration order. |

The trigger list is the half no scan of the TypeScript could find, and it is the half both
production deadlocks turned on: in each of them at least one wait edge came from a lock no
statement spelled. `takes` records what a trigger reaches for in *other* relations, following the
functions it calls — which is what makes
`project_acceptance_task_fact_update` visible as the reason a plain `status` write on a task is a
two-lock operation and has to pre-lock the project.

## What the audit found

**One deadlock, in `WorkspacesService.reorder`.** It wrote its position updates in the order the
caller dragged them into. Two drags that move the same workspaces opposite ways send exactly
reversed arrays, so the two transactions took the same `workspace` rows in opposite orders — a
40P01 with no trigger and no foreign key in it, reaching a person as an unexplained failure on a
sidebar drag. The statements are now sorted by id, which changes when a row is locked and not what
it ends up saying; `RunnersService.reorderRunners` already did this, and
`SessionTagsService.setForSession` now orders its link inserts for the same reason.

`deadlock/reorder.pg.spec.ts` replays both: the pre-fix sequence, asserted to still produce exactly
one 40P01 with the two wait edges that close the ring, and the ordered sequence from both arrival
orders, asserted to commit with the stored positions still a permutation belonging to one whole
request.

**Every transaction boundary is now retried.** All 52 are pure database work — the spec proves the
"pure" half by scanning every closure for an external call — so all 52 re-run whole through
`withTransactionRetry`. Two cap themselves at 2 attempts rather than 4: `TaskListsService.remove`
and `TasksService.deleteAndStopRuns` each carry a 60s per-attempt deadline for a cascade that can
run through tens of thousands of rows, and a cascade that size should absorb one collision rather
than spend four deadlines on the same one.

**No autocommit statement is retried, and that is structural rather than a judgement.** A single
statement has no transaction to re-run; wrapping one in `$transaction` purely so a retry loop had
something to hold would change what the statement is. They are covered by the global boundary's
typed 503 instead. The five classes and their exposure are in `STATEMENT_CLASSES`.

**One residual is recorded rather than fixed.** `TasksService.clearFailedForRetry` writes `status`
as a single statement, so an `AFTER` trigger takes the project `FOR NO KEY UPDATE` while the task
row is held — the project/task inversion in [the lock order](postgres-lock-order.md) §6. It is not
resolvable from that side, and wrapping four of the fifteen single-statement status writers in
transactions would buy the appearance of coverage rather than the property.

## Running the evidence

```
# unit, contract and static-guard suites (no database needed)
npm test -w @orbit/apiserver

# the real-PostgreSQL barriers, on a disposable server this script provisions and removes
scripts/deadlock-barrier.sh reorder     # the reversed sidebar reorder: control, then fix
scripts/deadlock-barrier.sh all         # every barrier gate, in the order they must run
```

`scripts/deadlock-barrier.sh` refuses to point at an Orbit business database: the role, database
and `system_identifier` are re-checked before the first write
(`src/apiserver/src/projects/coordinator-pg-test-safety.ts`). A run that is killed by its timeout
is red, never a pass.

## What the guard catches

Each of these was checked by breaking it on purpose:

| change | the test that fails |
|---|---|
| a new `updateMany` with no inventory entry | *every database write in the tree is in the inventory* |
| a unit that stops calling `withTransactionRetry` | the same test, on the shape mismatch |
| a `publishForUser` moved inside a closure | *nothing outside the database happens inside a transaction* |
| a local `e.code === '40P01'` helper | *40P01, 40001 and P2034 are decided in one place* |
| a migration widening a trigger's column list | *the installed triggers are the ones the inventory describes* |
| that widening accepted into the inventory | *the trigger that makes a task status write a two-lock operation…* |

## Related

- [The canonical lock order](postgres-lock-order.md) — the partial order the `locks` field of every
  entry is stated against, including the FK and trigger locks it counts.
- [The barrier fixture](postgres-deadlock-barrier.md) — the multi-connection harness every one of
  these replays runs on.
