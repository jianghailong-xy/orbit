# §8.6 LO1 barrier driver

A driver that measures the acquisition order against a real PostgreSQL, in the one way the specs
cannot: by driving raw statements from two connections and letting them collide.

`barriers.mjs` runs five barriers TWICE — once in the lock order the code took before migration
0134, against a schema with 0134's three triggers dropped, and once in LO1's order against the
migrated schema. A barrier only counts when the first deadlocks and the second does not, so a
"fixed" run cannot pass on a barrier that never met.

```sh
# two databases: one migrated, one with 0134's triggers dropped
createdb orbit && createdb baseline
DATABASE_URL=$MIGRATED  npx prisma migrate deploy
DATABASE_URL=$BASELINE  npx prisma migrate deploy
psql "$BASELINE" -c 'DROP TRIGGER "task_acceptance_fact_lock_order_insert_delete" ON "task";
                     DROP TRIGGER "task_acceptance_fact_lock_order_update" ON "task";
                     DROP TRIGGER "task_dependency_project_lock_order" ON "task_dependency";'

PG_URL=$MIGRATED PG_URL_BASELINE=$BASELINE SEED_SQL=tools/lock-order/seed.sql \
  node tools/lock-order/barriers.mjs
```

It is destructive: it `TRUNCATE`s on every scenario. Point it at a disposable server.

`acceptance-facts.mjs` stood beside it until migration 0229 removed the project acceptance
judgment; the facts it raced — an acceptance run, a reopen, an audit row — no longer exist.

The unit spec (`src/tasks/task-lock-order.spec.ts`) checks the rule is stated correctly and that
the three copies of the acceptance-fact column list still agree. The pg spec
(`src/tasks/task-lock-order.pg.spec.ts`) checks `TasksService` actually takes the order. These two
check that the order is the RIGHT one.
