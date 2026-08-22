import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAuthorizationService } from './project-authorization.service';
import { wireRefusalCode } from './project-task-dispatcher.service';
import { blockerKindForRefusal } from './project-blocker';

/**
 * §13.1 AG6 on real PostgreSQL: a task that only aggregation may complete never gets a work Session.
 *
 * The service-side gates (§7.8's pass, §9.2's commit-point adapter, `TasksService.execute` and
 * `batchExecute`) are covered by unit specs. What only a database can decide, and what those specs
 * therefore cannot, is everything this file is about:
 *
 *  - **The guard survives the binary.** Migration 0132 puts the rule inside
 *    `session_admission_lock_order`, so it applies to a rolling-deploy replica that predates the
 *    service gates and to a hand-typed INSERT. That is a property of the trigger, not of any
 *    TypeScript.
 *  - **The rule is LINEARIZABLE, not merely checked.** A row lock on a parent is not a predicate
 *    lock over its children, so "we re-read the children at the commit point" proves nothing on its
 *    own. What proves it is a pair of real transactions interleaved on purpose, in both orders.
 *  - **The lock ORDER holds.** The guard takes a parent `task` row, and 0127's acceptance trigger
 *    then takes that task's `project` — task -> project, against a Coordinator that goes
 *    project -> task. Whether that is a `40P01` or a typed refusal is decided by PostgreSQL, and
 *    only a real server can be asked.
 *
 * Give it its own database — it runs `prisma migrate deploy` against the real schema rather than
 * hand-building a subset, because a subset would only ever agree with itself:
 *
 *   docker run -d --name pcch0-agg-pg -e POSTGRES_USER=pcch0_agg -e POSTGRES_PASSWORD=pcch0 \
 *     -e POSTGRES_DB=pcch0_agg -p 127.0.0.1:55532:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcch0_agg:pcch0@127.0.0.1:55532/pcch0_agg npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcch0_agg:pcch0@127.0.0.1:55532/pcch0_agg \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcch0_agg COORDINATOR_PG_EXPECTED_USER=pcch0_agg \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(docker exec pcch0-agg-pg psql -U pcch0_agg \
 *       -tAc 'SELECT system_identifier FROM pg_control_system()') \
 *     node --test --test-concurrency=1 build/projects/task-aggregate-parent-dispatch.pg.spec.js
 *
 * NOTHING here waits on an operation it is itself holding the lock for. Every transaction that is
 * expected to block is started WITHOUT `await`, observed as blocked through `pg_locks`, and only
 * then released — a harness that awaits a blocked insert before committing the transaction it is
 * blocked on hangs until a timeout, and a timeout is not a passing test. Every connection carries
 * `lock_timeout` and `statement_timeout` so a genuine wedge fails loudly and fast.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

type ClientCtor = new (config: {
  connectionString?: string; connectionTimeoutMillis?: number;
}) => Client;

/**
 * A fresh namespace per RUN, not per file.
 *
 * The convention of giving each pg spec its own database is a convention — this file cannot assume
 * it, and a second run against the same database must be as green as the first. Fixed ids made the
 * re-run a wall of `task_pkey` collisions that read like product failures, and made live Sessions
 * from earlier runs accumulate under the same task.
 */
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const WORKSPACE = randomUUID();
const PROJECT = randomUUID();
/**
 * A SECOND project, with the coordinator switched on.
 *
 * `task.dispatch_authority` is a database-derived column (§12.3 / `PC-CX-25`): enabling a project's
 * coordinator flips its tasks to `COORDINATOR`, and 0130's `session_dispatch_authority_guard` then
 * refuses any Session inserted with a USER origin. Most of this file models the LEGACY doors — Run
 * Now, the sweeps, a hand-typed INSERT — which are USER-origin by construction, so they need a
 * project whose coordinator is off. The commit-gate test models the control loop and needs one
 * whose coordinator is on. Two projects is the honest way to have both; one project with the flag
 * flipped mid-file would make every earlier assertion depend on test order.
 */
const COORDINATOR_PROJECT = randomUUID();

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  // A wedge must fail, not hang. Long enough that an intended block is observed as a block rather
  // than as an error, short enough that a real deadlock ends the test instead of the suite.
  await client.query("SET lock_timeout = '4s'");
  await client.query("SET statement_timeout = '15s'");
  return client;
}

/** Every connection this test opened, so one `finally` can roll them all back. */
class Pool {
  private readonly clients: Client[] = [];

  async open(): Promise<Client> {
    const client = await connect();
    this.clients.push(client);
    return client;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }
}

/** The error as a test can assert on it: the SQLSTATE and the marker the message leads with. */
function outcome(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return `${e.code ?? '?'} ${String(e.message ?? '').split(':')[0]}`;
}

const settled = (promise: Promise<unknown>): Promise<string> =>
  promise.then(() => 'OK', outcome);

async function fixture(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'h0', 'x'), ($3, $4, 'o', 'x')
     ON CONFLICT DO NOTHING`,
    [OWNER, `h0-${OWNER}@example.test`, OTHER_OWNER, `h0-${OTHER_OWNER}@example.test`],
  );
  await client.query(
    `INSERT INTO "workspace" (id, owner_id, name) VALUES ($1, $2, 'ws') ON CONFLICT DO NOTHING`,
    [WORKSPACE, OWNER],
  );
  await client.query(
    `INSERT INTO "project" (id, owner_id, title, coordinator_enabled, automation_policy, updated_at)
     VALUES ($1, $2, 'legacy', false, 'GUARDED_AUTO', now()),
            ($3, $2, 'coordinated', true, 'GUARDED_AUTO', now())
     ON CONFLICT (id) DO UPDATE
        SET coordinator_enabled = EXCLUDED.coordinator_enabled,
            automation_policy = EXCLUDED.automation_policy`,
    [PROJECT, OWNER, COORDINATOR_PROJECT],
  );
}

type Policy = 'MANUAL' | 'ALL_CHILDREN_DONE' | 'VERIFICATION_PASSED';

function task(
  client: Client,
  id: string,
  policy: Policy,
  parent: string | null,
  options: { foreman?: boolean; owner?: string; project?: string } = {},
): Promise<unknown> {
  return client.query(
    `INSERT INTO "task" (id, owner_id, project_id, title, creator_id, creator_type, assignee_id,
                         completion_policy, parent_task_id, is_foreman, updated_at)
     VALUES ($1, $2, $3, 'T', $2, 'USER', $4, $5::task_completion_policy, $6, $7, now())`,
    [id, options.owner ?? OWNER, options.project ?? PROJECT, WORKSPACE, policy, parent,
      options.foreman ?? false],
  );
}

function startWork(client: Client, taskId: string, owner = OWNER): Promise<unknown> {
  return client.query(
    `INSERT INTO "session" (id, owner_id, creator_id, title, prompt, task_id, workspace_id,
                            status, starts_task_work, updated_at)
     VALUES ($1, $2, $2, 's', 'p', $3, $4, 'PENDING', true, now())`,
    [randomUUID(), owner, taskId, WORKSPACE],
  );
}

async function liveSessions(client: Client, taskId: string): Promise<number> {
  const rows = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "session"
      WHERE task_id = $1 AND deleted_at IS NULL AND starts_task_work
        AND status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')`,
    [taskId],
  );
  return rows.rows[0].n;
}

/** The backend a connection's statements run on, so a test can ask what THAT one is waiting for. */
async function backendPid(client: Client): Promise<number> {
  const rows = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows.rows[0].pid;
}

/**
 * Wait until `pid` is blocked BY SOMEBODY, or give up.
 *
 * This is the barrier, and it replaces the thing that must never be written: awaiting an operation
 * that cannot return until this test releases a lock it is still holding.
 *
 * `pg_blocking_pids` on a known backend, not `count(*) FROM pg_locks WHERE NOT granted`: the second
 * is a whole-server reading, so an unrelated backend — another spec sharing this database, autovacuum
 * — makes it true while the transaction under test is not blocked at all. That is a false pass on
 * the one assertion the interleaving depends on.
 */
async function waitUntilBlocked(observer: Client, pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await observer.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers', [pid],
    );
    if (rows.rows[0].blockers.length > 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A fresh task id per call. Random rather than a counter: this spec has to be re-runnable against a
 * database it has already run on — the harness that gives each file its own database is a
 * convention, not something the file can assume, and a deterministic id turns a second run into a
 * wall of `task_pkey` collisions that look like product failures.
 */
const id = (): string => randomUUID();

/**
 * `assert` that no task anywhere is aggregating AND has a child AND holds a live work Session.
 * The whole invariant, asked of the database rather than of any one write's return value.
 */
async function assertNoIllegalState(db: Client, parent: string): Promise<void> {
  const rows = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "task" t
      WHERE t.id = $1 AND t.completion_policy <> 'MANUAL'
        AND EXISTS (SELECT 1 FROM "task" c
                     WHERE c.parent_task_id = t.id AND c.owner_id = t.owner_id)
        AND EXISTS (SELECT 1 FROM "session" s
                     WHERE s.task_id = t.id AND s.deleted_at IS NULL AND s.starts_task_work
                       AND s.status IN ('PENDING','RUNNING','AWAITING_INPUT','INTERRUPTED'))`,
    [parent],
  );
  assert.equal(rows.rows[0].n, 0,
    'aggregating + a child + a live work Session is the state that must be unreachable');
}

// ---------------------------------------------------------------------------------------------
// The rule itself, and the three compatibility boundaries it must NOT cross.
// ---------------------------------------------------------------------------------------------
test('AG6: the database refuses a work Session on an aggregate parent', { skip }, async (t) => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);

    await t.test('ALL_CHILDREN_DONE with a direct child is refused', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await task(db, id(), 'MANUAL', parent);
      const result = await settled(startWork(db, parent));
      assert.match(result, /TASK_AGGREGATE_PARENT/);
      assert.equal(await liveSessions(db, parent), 0);
    });

    await t.test('VERIFICATION_PASSED with a direct child is refused', async () => {
      const parent = id();
      await task(db, parent, 'VERIFICATION_PASSED', null);
      await task(db, id(), 'MANUAL', parent);
      const result = await settled(startWork(db, parent));
      assert.match(result, /TASK_AGGREGATE_PARENT/);
      assert.equal(await liveSessions(db, parent), 0);
    });

    // AG4 read forwards: the policy is inert without children, so the task is an ordinary leaf.
    await t.test('boundary: a CHILDLESS non-MANUAL task is still dispatchable', async () => {
      const leaf = id();
      await task(db, leaf, 'ALL_CHILDREN_DONE', null);
      assert.equal(await settled(startWork(db, leaf)), 'OK');
      assert.equal(await liveSessions(db, leaf), 1);
    });

    await t.test('boundary: a MANUAL parent WITH children is still dispatchable', async () => {
      const parent = id();
      await task(db, parent, 'MANUAL', null);
      await task(db, id(), 'MANUAL', parent);
      assert.equal(await settled(startWork(db, parent)), 'OK');
      assert.equal(await liveSessions(db, parent), 1);
    });

    await t.test('boundary: a MANUAL foreman WITH children is still dispatchable', async () => {
      const parent = id();
      await task(db, parent, 'MANUAL', null, { foreman: true });
      await task(db, id(), 'MANUAL', parent);
      assert.equal(await settled(startWork(db, parent)), 'OK');
      assert.equal(await liveSessions(db, parent), 1);
    });

    // The scope is `starts_task_work`. Reading a roll-up node, or asking it a question, is a thing
    // a person may legitimately do — 0130 draws the same line for the same reason.
    await t.test('a non-work Session on an aggregate parent is NOT refused', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await task(db, id(), 'MANUAL', parent);
      const result = await settled(db.query(
        `INSERT INTO "session" (id, owner_id, creator_id, title, prompt, task_id, workspace_id,
                                status, starts_task_work, updated_at)
         VALUES ($1, $2, $2, 's', 'p', $3, $4, 'PENDING', false, now())`,
        [randomUUID(), OWNER, parent, WORKSPACE],
      ));
      assert.equal(result, 'OK');
    });
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------------------------
// An effective Foreman is MANUAL: the pair that would give one task two completion owners.
// ---------------------------------------------------------------------------------------------
test('AG6: is_foreman and an aggregating policy cannot both be written', { skip }, async (t) => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);

    await t.test('creating the pair is refused by the CHECK constraint', async () => {
      const result = await settled(task(db, id(), 'ALL_CHILDREN_DONE', null, { foreman: true }));
      assert.match(result, /task_foreman_manual_policy/);
    });

    await t.test('updating a foreman into an aggregating policy is refused', async () => {
      const foreman = id();
      await task(db, foreman, 'MANUAL', null, { foreman: true });
      const result = await settled(db.query(
        `UPDATE "task" SET completion_policy = 'VERIFICATION_PASSED' WHERE id = $1`, [foreman],
      ));
      assert.match(result, /task_foreman_manual_policy/);
    });
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The other end of the invariant: nothing may turn a RUNNING task into an aggregate parent.
// ---------------------------------------------------------------------------------------------
test('AG6: a live work Session blocks the transition INTO the aggregate shape', { skip }, async (t) => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);

    await t.test('filing a child under a running non-MANUAL task is refused', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await startWork(db, parent);
      const result = await settled(task(db, id(), 'MANUAL', parent));
      assert.match(result, /TASK_AGGREGATE_PARENT_ACTIVATION/);
    });

    await t.test('flipping a running parent MANUAL -> aggregating is refused', async () => {
      const parent = id();
      await task(db, parent, 'MANUAL', null);
      await task(db, id(), 'MANUAL', parent);
      await startWork(db, parent);
      const result = await settled(db.query(
        `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
      ));
      assert.match(result, /TASK_AGGREGATE_PARENT_ACTIVATION/);
    });

    // Every RELEASE direction stays open: refusing them would close the only exits from a wedge.
    await t.test('release: moving a child OUT of a running parent is allowed', async () => {
      const parent = id();
      const elsewhere = id();
      const child = id();
      await task(db, parent, 'MANUAL', null);
      await task(db, elsewhere, 'MANUAL', null);
      await task(db, child, 'MANUAL', parent);
      await startWork(db, parent);
      assert.equal(await settled(db.query(
        `UPDATE "task" SET parent_task_id = $2 WHERE id = $1`, [child, elsewhere],
      )), 'OK');
    });

    await t.test('release: an aggregate parent going back to MANUAL is allowed', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await task(db, id(), 'MANUAL', parent);
      assert.equal(await settled(db.query(
        `UPDATE "task" SET completion_policy = 'MANUAL' WHERE id = $1`, [parent],
      )), 'OK');
    });

    await t.test('a self-parent on a running task cannot smuggle it into the shape', async () => {
      // `UPDATE task SET parent_task_id = id` makes a task its own direct child, so a childless
      // aggregating task with a live run becomes an aggregate parent WITHOUT any other row being
      // written. The service refuses a parent cycle, so this arrives only by raw SQL — which is the
      // writer this guard exists for.
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await startWork(db, parent);
      const result = await settled(db.query(
        'UPDATE "task" SET parent_task_id = id WHERE id = $1', [parent],
      ));
      assert.match(result, /TASK_AGGREGATE_PARENT_ACTIVATION/);
      await assertNoIllegalState(db, parent);
    });

    await t.test('a policy flip on an already self-parented running task is refused too', async () => {
      const parent = id();
      await task(db, parent, 'MANUAL', null);
      await db.query('UPDATE "task" SET parent_task_id = id WHERE id = $1', [parent]);
      await startWork(db, parent);
      const result = await settled(db.query(
        `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
      ));
      assert.match(result, /TASK_AGGREGATE_PARENT_ACTIVATION/);
      await assertNoIllegalState(db, parent);
    });

    await t.test('an aggregate parent with NO live session may gain children freely', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      assert.equal(await settled(task(db, id(), 'MANUAL', parent)), 'OK');
    });
  } finally {
    await pool.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The barriers. Two transactions, both orders, and nothing awaited while its lock is held.
// ---------------------------------------------------------------------------------------------
test('AG6 barrier: a child that lands before the dispatch transaction is seen', { skip }, async () => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    await task(db, parent, 'ALL_CHILDREN_DONE', null);

    // The production shape: §7.8's pass plans in one transaction that has already COMMITTED, and
    // `applyDecisionAction` opens a second one. A child filed in between is what AC5 calls "a child
    // added after the snapshot" — the apply transaction must see it and refuse.
    const child = await pool.open();
    await child.query('BEGIN');
    await task(child, id(), 'MANUAL', parent);
    await child.query('COMMIT');

    const dispatch = await pool.open();
    await dispatch.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await dispatch.query('SELECT 1 FROM "project" WHERE id = $1 FOR NO KEY UPDATE', [PROJECT]);
    const result = await settled(startWork(dispatch, parent));
    await dispatch.query('ROLLBACK');

    assert.match(result, /TASK_AGGREGATE_PARENT/, 'the stale plan must be refused, not run');
    assert.equal(await liveSessions(db, parent), 0, 'no Session may exist for the parent');
  } finally {
    await pool.close();
  }
});

test('AG6 barrier: a child arriving while the dispatcher holds the parent', { skip }, async () => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    await task(db, parent, 'ALL_CHILDREN_DONE', null);

    const dispatch = await pool.open();
    await dispatch.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await dispatch.query('SELECT 1 FROM "project" WHERE id = $1 FOR NO KEY UPDATE', [PROJECT]);
    // Childless and non-MANUAL: legal to dispatch at this instant, which is the whole point.
    assert.equal(await settled(startWork(dispatch, parent)), 'OK');

    // NOT awaited: it cannot return until `dispatch` releases the project and the parent.
    const child = await pool.open();
    await child.query('BEGIN');
    const childPid = await backendPid(child);
    const pending = settled(task(child, id(), 'MANUAL', parent));
    assert.ok(await waitUntilBlocked(db, childPid),
      'the child insert must be waiting on the dispatcher, specifically');

    await dispatch.query('COMMIT');
    const childResult = await pending;
    await child.query('ROLLBACK');

    assert.match(childResult, /TASK_AGGREGATE_PARENT_ACTIVATION/,
      'once the run exists, the child that would activate the policy must be refused');
    assert.equal(await liveSessions(db, parent), 1, 'exactly one Session, and it is the legal one');
  } finally {
    await pool.close();
  }
});

test('AG6 barrier: a running MANUAL parent, child insert forced to interleave with a policy flip',
  { skip }, async (t) => {
    // Neither write is illegal alone: the parent is MANUAL and childless with a live run, so a
    // child may be filed under it AND its policy may be changed. Only the PAIR is illegal, which is
    // why the two have to be forced to overlap — running them one after another lets each see the
    // other's committed row and proves nothing about the case where neither does.
    await t.test('child holds, policy flip arrives and must wait', { skip }, async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        await task(db, parent, 'MANUAL', null);
        await startWork(db, parent);

        const childTx = await pool.open();
        await childTx.query('BEGIN');
        assert.equal(await settled(task(childTx, id(), 'MANUAL', parent)), 'OK',
          'filing a child under a running MANUAL parent is legal');

        const policyTx = await pool.open();
        await policyTx.query('BEGIN');
        const policyPid = await backendPid(policyTx);
        const pending = settled(policyTx.query(
          `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
        ));
        assert.ok(await waitUntilBlocked(db, policyPid),
          'the policy flip must be held by the uncommitted child, not race past it');

        await childTx.query('COMMIT');
        const policyResult = await pending;
        await policyTx.query(policyResult === 'OK' ? 'COMMIT' : 'ROLLBACK');

        assert.notEqual(policyResult, 'OK',
          'once the child is committed the flip must be refused, not applied');
        await assertNoIllegalState(db, parent);
      } finally {
        await pool.close();
      }
    });

    await t.test('policy flip holds, child insert arrives and must wait', { skip }, async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        await task(db, parent, 'MANUAL', null);
        await startWork(db, parent);

        const policyTx = await pool.open();
        await policyTx.query('BEGIN');
        assert.equal(await settled(policyTx.query(
          `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
        )), 'OK', 'flipping a childless parent with a live run is legal');

        const childTx = await pool.open();
        await childTx.query('BEGIN');
        const childPid = await backendPid(childTx);
        const pending = settled(task(childTx, id(), 'MANUAL', parent));
        assert.ok(await waitUntilBlocked(db, childPid),
          'the child insert must be held by the uncommitted policy flip');

        await policyTx.query('COMMIT');
        const childResult = await pending;
        await childTx.query(childResult === 'OK' ? 'COMMIT' : 'ROLLBACK');

        assert.match(childResult, /TASK_AGGREGATE_PARENT_ACTIVATION/,
          'once the parent is aggregating the child must be refused');
        await assertNoIllegalState(db, parent);
      } finally {
        await pool.close();
      }
    });
  });

test('AG6 barrier: a stale REPEATABLE READ policy flip is refused, not applied', { skip }, async () => {
  // The discriminating case, and the one an unlocked "the parent is MANUAL, nothing to do here"
  // early return passes every other test while failing:
  //
  //   T_policy pins a REPEATABLE READ snapshot in which the parent is childless — WITHOUT taking
  //   any lock, exactly as a planner does. T_child then files a child and commits. T_policy now
  //   flips the policy. Its snapshot still says childless, so nothing it can READ will stop it;
  //   what stops it is that the child write TOUCHED the parent, so the row version moved and the
  //   UPDATE cannot serialize.
  //
  // Remove the touch, or skip the linearization on a MANUAL reading, and this commits: aggregating,
  // with a child, with a live work Session.
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    await task(db, parent, 'MANUAL', null);
    await startWork(db, parent);

    const policyTx = await pool.open();
    await policyTx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const seen = await policyTx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "task" WHERE parent_task_id = $1', [parent],
    );
    assert.equal(seen.rows[0].n, 0, 'the snapshot is pinned on a childless parent');

    const childTx = await pool.open();
    await childTx.query('BEGIN');
    await task(childTx, id(), 'MANUAL', parent);
    await childTx.query('COMMIT');

    const result = await settled(policyTx.query(
      `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
    ));
    await policyTx.query(result === 'OK' ? 'COMMIT' : 'ROLLBACK');

    assert.notEqual(result, 'OK', 'a flip decided on a snapshot that has moved must not commit');
    assert.match(result, /40001|TASK_AGGREGATE_PARENT_ACTIVATION/,
      'either serialization failure or the guard — both are retryable and both refuse');
    await assertNoIllegalState(db, parent);
  } finally {
    await pool.close();
  }
});

test('AG6: re-owning a task into a running parent is refused, and out of one is allowed',
  { skip }, async (t) => {
    // `owner_id` is the column that changes a parent's children set without naming the parent: a
    // parent's children are the tasks that share its owner, because that is the scope
    // `collectAggregationScope` walks. A raw writer that moves a task between owners would
    // otherwise walk it into a running aggregate parent with no guarded column touched.
    await t.test('owner-in is refused', { skip }, async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        const child = id();
        await task(db, parent, 'ALL_CHILDREN_DONE', null);
        await startWork(db, parent);
        // Not yet a child of `parent` in the counted sense: a different owner.
        await task(db, child, 'MANUAL', parent, { owner: OTHER_OWNER });
        const result = await settled(db.query(
          'UPDATE "task" SET owner_id = $2 WHERE id = $1', [child, OWNER],
        ));
        assert.match(result, /TASK_AGGREGATE_PARENT_ACTIVATION/);
        await assertNoIllegalState(db, parent);
      } finally {
        await pool.close();
      }
    });

    await t.test('owner-out is allowed even when the parent keeps other children', { skip }, async () => {
      // The release promise, in the shape that used to break it. The parent here is a genuine
      // aggregate parent WITH a live work Session — a state the guard normally makes unreachable,
      // built by disabling this one trigger for the two writes that create it and re-enabling it
      // immediately, so the release below is judged by the real guard against a real prior anomaly.
      // Asking about the parent's OTHER children on a release would refuse this write, and a
      // release that cannot happen is a wedge with the exits closed.
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        const leaving = id();
        await task(db, parent, 'MANUAL', null);
        await task(db, id(), 'MANUAL', parent);      // the sibling that stays
        await task(db, leaving, 'MANUAL', parent);
        // ONE transaction, rolled back at the end. PostgreSQL makes DDL transactional, so the
        // disabled triggers are restored by the rollback — and, more to the point, by the
        // connection simply dropping. A JS `finally` cannot promise that: kill the process (or let
        // a timeout kill it) between the DISABLE and the ENABLE and this dedicated database keeps
        // permanently disabled triggers, which would make every later run on it falsely green.
        await db.query('BEGIN');
        let release: string;
        try {
          // `SET LOCAL session_replication_role`, not `ALTER TABLE ... DISABLE TRIGGER`, for two
          // reasons. It is transaction-scoped, so the ROLLBACK below — and a dropped connection,
          // and a killed process — all restore it; a `finally` in JavaScript promises none of
          // those, and a dedicated database left with permanently disabled triggers would make
          // every later run on it falsely green. And it can be turned back on with AFTER-trigger
          // events already queued, which `ALTER TABLE` refuses ("pending trigger events").
          await db.query("SET LOCAL session_replication_role = 'replica'");
          await db.query(
            `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
          );
          await startWork(db, parent);
          await db.query("SET LOCAL session_replication_role = 'origin'");
          // Judged by the REAL guard, against the anomaly built above.
          release = await settled(db.query(
            'UPDATE "task" SET owner_id = $2 WHERE id = $1', [leaving, OTHER_OWNER],
          ));
        } finally {
          await db.query('ROLLBACK').catch(() => undefined);
        }
        assert.equal(release, 'OK',
          'a release must not be refused because the parent is already in a bad state');
      } finally {
        await pool.close();
      }
    });

    await t.test('owner-out is allowed', { skip }, async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        const child = id();
        await task(db, parent, 'MANUAL', null);
        await task(db, child, 'MANUAL', parent);
        await startWork(db, parent);
        assert.equal(await settled(db.query(
          'UPDATE "task" SET owner_id = $2 WHERE id = $1', [child, OTHER_OWNER],
        )), 'OK', "leaving a parent's owner set is a release direction");
      } finally {
        await pool.close();
      }
    });
  });

test('AG6: every Session ingress is guarded, not only INSERT', { skip }, async (t) => {
  // A trigger declared `UPDATE OF <cols>` does not fire for a write touching none of them, and a
  // row can ENTER the guarded state without being inserted: a finished run revived, a soft-deleted
  // one restored, a conversation promoted to work, a session re-pointed at another task. Testing
  // only INSERT leaves four doors open.
  const ingress: Array<[string, (client: Client, session: string, parent: string) => Promise<unknown>]> = [
    ['starts_task_work false -> true', (c, s) =>
      c.query('UPDATE "session" SET starts_task_work = true WHERE id = $1', [s])],
    ['terminal -> PENDING revival', (c, s) =>
      c.query(`UPDATE "session" SET status = 'PENDING' WHERE id = $1`, [s])],
    ['soft-deleted -> restored', (c, s) =>
      c.query('UPDATE "session" SET deleted_at = NULL WHERE id = $1', [s])],
    ['task_id rebound onto the parent', (c, s, parent) =>
      c.query('UPDATE "session" SET task_id = $2 WHERE id = $1', [s, parent])],
  ];
  for (const [name, promote] of ingress) {
    await t.test(name, { skip }, async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        await task(db, parent, 'ALL_CHILDREN_DONE', null);
        await task(db, id(), 'MANUAL', parent);

        // A session that is NOT currently live work on that parent, in each of the four ways.
        const sessionId = randomUUID();
        const other = id();
        await task(db, other, 'MANUAL', null);
        const rebind = name.startsWith('task_id');
        await db.query(
          `INSERT INTO "session" (id, owner_id, creator_id, title, prompt, task_id, workspace_id,
                                  status, starts_task_work, deleted_at, updated_at)
           VALUES ($1, $2, $2, 's', 'p', $3, $4, $5, $6, $7, now())`,
          [sessionId, OWNER, rebind ? other : parent, WORKSPACE,
            name.startsWith('terminal') ? 'SUCCEEDED' : 'PENDING',
            name.startsWith('starts_task_work') ? false : true,
            name.startsWith('soft-deleted') ? new Date() : null],
        );

        const result = await settled(promote(db, sessionId, parent));
        assert.match(result, /TASK_AGGREGATE_PARENT/,
          `${name} must be refused by the same guard as INSERT`);
        assert.equal(await liveSessions(db, parent), 0);
      } finally {
        await pool.close();
      }
    });
  }
});

test('AG6 barrier: deleting the last child serializes with the parent lock', { skip }, async () => {
  // The release direction that fires NO column trigger. Deleting a child is a DELETE on the child
  // row, so §4's guard — declared on INSERT and on four UPDATE columns — never sees it, and the
  // parent stops being an aggregate parent with nothing having taken its lock. Every reader that
  // decides under `FOR UPDATE` (the commit gate, the auto-retry settle) depends on that not being
  // possible, so §5 takes the same lock on the way out.
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    const child = id();
    await task(db, parent, 'ALL_CHILDREN_DONE', null);
    await task(db, child, 'MANUAL', parent);

    // A reader holding the parent `FOR UPDATE`, exactly as the settle does.
    const reader = await pool.open();
    await reader.query('BEGIN');
    await reader.query('SELECT 1 FROM "task" WHERE id = $1 FOR UPDATE', [parent]);

    const deleter = await pool.open();
    const deleterPid = await backendPid(deleter);
    await deleter.query('BEGIN');
    const pending = settled(deleter.query('DELETE FROM "task" WHERE id = $1', [child]));
    // NOWAIT on the parent means it does not queue behind the reader — it is told so at once.
    const outcome = await pending;
    await deleter.query('ROLLBACK');
    await reader.query('COMMIT');
    void deleterPid;

    assert.match(outcome, /TASK_AGGREGATE_PARENT_BUSY|55P03/,
      'the delete is refused while a reader holds the parent, not allowed to slip past it');

    // ...and once nobody holds the parent, the delete goes through: a release is never refused for
    // its own sake.
    assert.equal(await settled(db.query('DELETE FROM "task" WHERE id = $1', [child])), 'OK');
  } finally {
    await pool.close();
  }
});

test('AG6: the delete path handles the shapes that would break its own touch', { skip }, async (t) => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);

    await t.test('a self-parented row can be deleted', async () => {
      // Its "parent" is the tuple being deleted, so touching it inside BEFORE DELETE would be an
      // error. Nothing needs serializing either: the parent is going in the same statement.
      const orphan = id();
      await task(db, orphan, 'ALL_CHILDREN_DONE', null);
      await db.query('UPDATE "task" SET parent_task_id = id WHERE id = $1', [orphan]);
      assert.equal(await settled(db.query('DELETE FROM "task" WHERE id = $1', [orphan])), 'OK');
    });

    await t.test('deleting a parent cascades its children loose', async () => {
      // `ON DELETE SET NULL` rewrites each child's `parent_task_id`, which fires §4's guard on rows
      // whose parent is disappearing in the same statement. It must not refuse the delete.
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      for (let n = 0; n < 3; n += 1) await task(db, id(), 'MANUAL', parent);
      assert.equal(await settled(db.query('DELETE FROM "task" WHERE id = $1', [parent])), 'OK');
    });

    await t.test('a bulk delete of several children of one parent goes through', async () => {
      const parent = id();
      const children = [id(), id(), id()];
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      for (const child of children) await task(db, child, 'MANUAL', parent);
      assert.equal(await settled(db.query(
        `DELETE FROM "task" WHERE id = ANY ($1::uuid[])`, [children],
      )), 'OK', 'the parent is locked once per row, in one order, so this cannot self-deadlock');
    });
  } finally {
    await pool.close();
  }
});

test('AG6: a cross-owner child does not bump the parent it does not count towards', { skip },
  async () => {
    // The predicate counts children that share the parent's OWNER, so a cross-owner row changes
    // nothing about that parent's shape and must not write its `updated_at` — that would wake
    // another tenant's project through 0117 over a change that means nothing to it.
    //
    // It DOES still take the parent's lock on the way through, and that is deliberate rather than
    // an oversight: deciding membership from an unlocked read and skipping the lock is exactly the
    // interleaving §4 describes, where a concurrent owner change makes the row count after both
    // transactions have decided it did not. The requirement is "no cross-owner bump", not "no
    // cross-owner lock".
    const pool = new Pool();
    try {
      const db = await pool.open();
      await fixture(db);
      const parent = id();
      const foreign = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await task(db, foreign, 'MANUAL', parent, { owner: OTHER_OWNER });

      const before = await db.query<{ updatedAt: Date }>(
        'SELECT "updated_at" AS "updatedAt" FROM "task" WHERE id = $1', [parent],
      );
      assert.equal(await settled(db.query('DELETE FROM "task" WHERE id = $1', [foreign])), 'OK');
      assert.equal(await settled(task(db, id(), 'MANUAL', parent, { owner: OTHER_OWNER })), 'OK');
      const after = await db.query<{ updatedAt: Date }>(
        'SELECT "updated_at" AS "updatedAt" FROM "task" WHERE id = $1', [parent],
      );
      assert.equal(after.rows[0].updatedAt.getTime(), before.rows[0].updatedAt.getTime(),
        "the other tenant's row was not touched, so their project was not woken");
    } finally {
      await pool.close();
    }
  });

test('AG6: an owner move is judged on BOTH sides, each by its own owner', { skip }, async (t) => {
  // Membership is directional. Collapsing the two ends into one list judged by the NEW owner drops
  // the release: an owner move A -> B takes the last counted child away from a parent owned by A,
  // and if that parent is not bumped a REPEATABLE READ reader goes on believing it aggregates.
  await t.test('moving a child OUT of its parent\'s owner set bumps that parent', { skip },
    async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const parent = id();
        const child = id();
        await task(db, parent, 'ALL_CHILDREN_DONE', null);
        await task(db, child, 'MANUAL', parent);
        const before = await db.query<{ updatedAt: Date }>(
          'SELECT "updated_at" AS "updatedAt" FROM "task" WHERE id = $1', [parent],
        );
        assert.equal(await settled(db.query(
          'UPDATE "task" SET owner_id = $2 WHERE id = $1', [child, OTHER_OWNER],
        )), 'OK', 'the release itself is allowed');
        const after = await db.query<{ updatedAt: Date }>(
          'SELECT "updated_at" AS "updatedAt" FROM "task" WHERE id = $1', [parent],
        );
        assert.ok(after.rows[0].updatedAt.getTime() > before.rows[0].updatedAt.getTime(),
          'and the parent it left is bumped, so a stale reader is forced to re-read');
      } finally {
        await pool.close();
      }
    });

  await t.test('moving a child INTO a running parent\'s owner set is refused', { skip }, async () => {
    const pool = new Pool();
    try {
      const db = await pool.open();
      await fixture(db);
      const parent = id();
      const child = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await startWork(db, parent);
      await task(db, child, 'MANUAL', parent, { owner: OTHER_OWNER });
      assert.match(await settled(db.query(
        'UPDATE "task" SET owner_id = $2 WHERE id = $1', [child, OWNER],
      )), /TASK_AGGREGATE_PARENT_ACTIVATION/);
      await assertNoIllegalState(db, parent);
    } finally {
      await pool.close();
    }
  });

  await t.test('a re-parent that also changes owner is judged on the arrival side', { skip },
    async () => {
      const pool = new Pool();
      try {
        const db = await pool.open();
        await fixture(db);
        const from = id();
        const to = id();
        const child = id();
        await task(db, from, 'MANUAL', null, { owner: OTHER_OWNER });
        await task(db, to, 'ALL_CHILDREN_DONE', null);
        await startWork(db, to);
        await task(db, child, 'MANUAL', from, { owner: OTHER_OWNER });
        assert.match(await settled(db.query(
          'UPDATE "task" SET parent_task_id = $2, owner_id = $3 WHERE id = $1',
          [child, to, OWNER],
        )), /TASK_AGGREGATE_PARENT_ACTIVATION/);
        await assertNoIllegalState(db, to);
      } finally {
        await pool.close();
      }
    });
});

test('AG6 barrier: opposing re-parents between the same two parents', { skip }, async () => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const left = id();
    const right = id();
    const leftChild = id();
    const rightChild = id();
    await task(db, left, 'ALL_CHILDREN_DONE', null);
    await task(db, right, 'ALL_CHILDREN_DONE', null);
    await task(db, leftChild, 'MANUAL', left);
    await task(db, rightChild, 'MANUAL', right);

    const a = await pool.open();
    const b = await pool.open();
    await a.query('BEGIN');
    await b.query('BEGIN');
    const move = (client: Client, child: string, to: string) => settled(client.query(
      'UPDATE "task" SET parent_task_id = $2 WHERE id = $1', [child, to],
    ));
    const [one, two] = await Promise.all([move(a, leftChild, right), move(b, rightChild, left)]);
    for (const [client, result] of [[a, one], [b, two]] as const) {
      await client.query(result === 'OK' ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
    }
    // A typed `55P03` refusal is a pass; `40P01` is the deadlock the sorted, NOWAIT acquisition
    // exists to make impossible.
    for (const result of [one, two]) assert.doesNotMatch(result, /40P01/);
  } finally {
    await pool.close();
  }
});

test('AG6 barrier: releasing to MANUAL while a reconcile holds the project', { skip }, async () => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    await task(db, parent, 'ALL_CHILDREN_DONE', null);
    await task(db, id(), 'MANUAL', parent);

    // 0127's acceptance trigger takes the project on the AFTER side of ANY completion_policy write,
    // including this release — so the release must pre-acquire it, NOWAIT, rather than deadlock.
    const reconcile = await pool.open();
    await reconcile.query('BEGIN');
    await reconcile.query('SELECT 1 FROM "project" WHERE id = $1 FOR NO KEY UPDATE', [PROJECT]);

    const release = await pool.open();
    const underLock = await settled(release.query(
      `UPDATE "task" SET completion_policy = 'MANUAL' WHERE id = $1`, [parent],
    ));
    assert.doesNotMatch(underLock, /40P01/, 'a release must never be a deadlock victim');
    assert.match(underLock, /55P03/, 'it is a typed, retryable refusal');

    await reconcile.query('COMMIT');
    assert.equal(await settled(release.query(
      `UPDATE "task" SET completion_policy = 'MANUAL' WHERE id = $1`, [parent],
    )), 'OK', 'and the retry the refusal asks for succeeds');
  } finally {
    await pool.close();
  }
});

test('AG6: a cross-owner Session cannot read a real aggregate parent as childless', { skip }, async () => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    await task(db, parent, 'ALL_CHILDREN_DONE', null);
    await task(db, id(), 'MANUAL', parent);

    // Nothing in the schema forces `session.owner_id` to equal `task.owner_id`. The guard therefore
    // scopes the child lookup by the OWNER OF THE TASK, read off the row it has locked — scoping it
    // by the session's owner would let this row through.
    const result = await settled(startWork(db, parent, OTHER_OWNER));
    assert.match(result, /TASK_AGGREGATE_PARENT/);
    assert.equal(await liveSessions(db, parent), 0);
  } finally {
    await pool.close();
  }
});

test('AG6: an old writer that hits the guard leaves nothing behind', { skip }, async () => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    const parent = id();
    await task(db, parent, 'ALL_CHILDREN_DONE', null);
    await task(db, id(), 'MANUAL', parent);

    // A replica that predates the service gates still plans this dispatch and still writes its
    // action row before inserting the Session. What THIS test asserts is only the database half:
    // the guard refuses the INSERT and the transaction rolls back whole, so nothing of the attempt
    // survives — no Session, and no CLAIMED action row for a dispatch that never happened.
    //
    // The rest of the recovery story is NOT asserted here and must not be read out of this test:
    // that `ProjectDispatchPassService.runFor` swallows the error post-commit (so the delivered
    // event is not retried and never reaches a dead letter), that the reconcile's persisted
    // `next_wake_at` still stands, and that an upgraded planner then skips the parent and chooses
    // the leaf. Those are properties of the service layer, covered by its own specs and by the
    // release note, and this file can only speak for the transaction.
    const old = await pool.open();
    await old.query('BEGIN');
    const actionId = randomUUID();
    await old.query(
      `INSERT INTO "project_action" (id, project_id, type, status, idempotency_key,
                                     subject_type, subject_id, fencing_token, created_at, updated_at)
       VALUES ($1, $2, 'DISPATCH_TASK', 'CLAIMED', $3, 'TASK', $4, 1, now(), now())`,
      [actionId, PROJECT, `pc:v1:${PROJECT}:dispatch:${parent}:0`, parent],
    );
    const result = await settled(startWork(old, parent));
    await old.query('ROLLBACK');

    assert.match(result, /TASK_AGGREGATE_PARENT/);
    assert.equal(await liveSessions(db, parent), 0, 'no Session survives the refusal');
    const actions = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "project_action" WHERE id = $1`, [actionId],
    );
    assert.equal(actions.rows[0].n, 0, 'and no CLAIMED action row is left for it either');
  } finally {
    await pool.close();
  }
});


// ---------------------------------------------------------------------------------------------
// The PRODUCTION commit gate, against the real schema.
// ---------------------------------------------------------------------------------------------

/**
 * `ProjectAuthorizationService.authorizeInTransaction` runs entirely on `$queryRaw`, so its row
 * interfaces are the only check that its SQL and the schema still agree — a column renamed in one
 * and not the other compiles, runs, and serves `undefined`. That is exactly the failure mode the
 * new direct-children read could have, and no unit spec can see it.
 */
function transactionClient(client: Client): Prisma.TransactionClient {
  const statement = (query: unknown, values: unknown[]) => {
    const sql = query as Prisma.Sql;
    if (sql && typeof sql === 'object' && 'text' in sql) return { text: sql.text, values: sql.values };
    const strings = query as readonly string[];
    return {
      text: strings.map((part, i) => (i === 0 ? part : `$${i}${part}`)).join(''),
      values,
    };
  };
  return {
    $queryRaw: async (query: unknown, ...values: unknown[]) => {
      const { text, values: bound } = statement(query, values);
      return ((await client.query(text, bound)) as QueryResult).rows;
    },
    $executeRaw: async (query: unknown, ...values: unknown[]) => {
      const { text, values: bound } = statement(query, values);
      return (await client.query(text, bound)).rowCount ?? 0;
    },
  } as unknown as Prisma.TransactionClient;
}

async function authorize(client: Client, taskId: string) {
  const service = new ProjectAuthorizationService();
  return service.authorizeInTransaction(transactionClient(client), {
    ownerId: OWNER,
    projectId: COORDINATOR_PROJECT,
    coordinatorAgentId: WORKSPACE,
    idempotencyKey: `pc:v1:${COORDINATOR_PROJECT}:dispatch:${taskId}:0`,
    action: 'DISPATCH_TASK',
    taskId,
    sourceDecisionInputHash: 'a'.repeat(64),
  });
}

test('AG6: the production commit gate re-reads the children and DENIES', { skip }, async (t) => {
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);
    // The coordinator has to be a member for the gate to get past its principal checks.
    await db.query(
      `INSERT INTO "project_member" (id, project_id, agent_id, role)
       VALUES ($1, $2, $3, 'COORDINATOR') ON CONFLICT DO NOTHING`,
      [randomUUID(), COORDINATOR_PROJECT, WORKSPACE],
    );

    await t.test('a plan whose task gained children since the snapshot is refused', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null, { project: COORDINATOR_PROJECT });
      // The pass chose it while it was childless; the child lands before this transaction reads.
      await task(db, id(), 'MANUAL', parent, { project: COORDINATOR_PROJECT });
      const audit = await authorize(db, parent);
      assert.ok(audit, 'the project must resolve');
      assert.equal(audit.request.task?.aggregateParent?.hasDirectChildren, true,
        'the adapter must have actually re-read the children');
      assert.equal(audit.result.decision, 'DENY');
      assert.equal(audit.result.reasonCode, 'TASK_AGGREGATE_PARENT');
    });

    await t.test('a childless non-MANUAL task is not refused by this gate', async () => {
      const leaf = id();
      await task(db, leaf, 'ALL_CHILDREN_DONE', null, { project: COORDINATOR_PROJECT });
      const audit = await authorize(db, leaf);
      assert.equal(audit?.request.task?.aggregateParent?.hasDirectChildren, false);
      assert.notEqual(audit?.result.reasonCode, 'TASK_AGGREGATE_PARENT');
    });

    await t.test('a MANUAL parent with children is not refused by this gate', async () => {
      const parent = id();
      await task(db, parent, 'MANUAL', null, { project: COORDINATOR_PROJECT });
      await task(db, id(), 'MANUAL', parent, { project: COORDINATOR_PROJECT });
      const audit = await authorize(db, parent);
      assert.equal(audit?.request.task?.aggregateParent?.completionPolicy, 'MANUAL');
      assert.notEqual(audit?.result.reasonCode, 'TASK_AGGREGATE_PARENT');
    });

    await t.test('the refusal is carried on a wire code no reader turns into a blocker', async () => {
      const parent = id();
      await task(db, parent, 'ALL_CHILDREN_DONE', null, { project: COORDINATOR_PROJECT });
      await task(db, id(), 'MANUAL', parent, { project: COORDINATOR_PROJECT });
      const audit = await authorize(db, parent);
      const reasonCode = audit!.result.reasonCode;
      // What the dispatcher would persist in `project_action.refusal_code`, and what a reader —
      // including one that predates this release — makes of it.
      assert.equal(reasonCode, 'TASK_AGGREGATE_PARENT');
      assert.equal(wireRefusalCode(reasonCode), 'STALE_SNAPSHOT');
      assert.equal(blockerKindForRefusal(wireRefusalCode(reasonCode)), null,
        'no blocker, and in particular not a PROJECT-subject UNKNOWN_FAILURE');
    });
  } finally {
    await pool.close();
  }
});

test('AG6: reviving a terminal work Session whose task became an aggregate parent', { skip }, async (t) => {
  // AC4's remaining door. `SessionsService.resume` and `AutoRetryService` reach the Session
  // directly, without going through `TasksService`, so a run that was a legal leaf when it failed
  // can be revived onto a task that has since become a roll-up node. The database is what stops it
  // — `session_admission_lock_order` fires on the revival UPDATE — and these assert that.
  const pool = new Pool();
  try {
    const db = await pool.open();
    await fixture(db);

    await t.test('the revival UPDATE is refused', async () => {
      const parent = id();
      const sessionId = randomUUID();
      await task(db, parent, 'MANUAL', null);
      await db.query(
        `INSERT INTO "session" (id, owner_id, creator_id, title, prompt, task_id, workspace_id,
                                status, starts_task_work, updated_at)
         VALUES ($1, $2, $2, 's', 'p', $3, $4, 'FAILED', true, now())`,
        [sessionId, OWNER, parent, WORKSPACE],
      );
      // The task becomes a roll-up while the run is terminal — legal, because nothing is live.
      await task(db, id(), 'MANUAL', parent);
      await db.query(
        `UPDATE "task" SET completion_policy = 'ALL_CHILDREN_DONE' WHERE id = $1`, [parent],
      );

      const revived = await settled(db.query(
        `UPDATE "session" SET status = 'PENDING' WHERE id = $1`, [sessionId],
      ));
      assert.match(revived, /TASK_AGGREGATE_PARENT/,
        'a manual Resume and an auto-retry both land on this same UPDATE');
      assert.equal(await liveSessions(db, parent), 0);
    });

    await t.test('a live salvage session that is NOT the task\'s work keeps going', async () => {
      // The exemption `resume` already draws: replying in a session ABOUT a task is not executing
      // the task, and a roll-up node is exactly the row somebody wants to read.
      const parent = id();
      const sessionId = randomUUID();
      await task(db, parent, 'ALL_CHILDREN_DONE', null);
      await task(db, id(), 'MANUAL', parent);
      await db.query(
        `INSERT INTO "session" (id, owner_id, creator_id, title, prompt, task_id, workspace_id,
                                status, starts_task_work, updated_at)
         VALUES ($1, $2, $2, 's', 'p', $3, $4, 'AWAITING_INPUT', false, now())`,
        [sessionId, OWNER, parent, WORKSPACE],
      );
      assert.equal(await settled(db.query(
        `UPDATE "session" SET status = 'RUNNING' WHERE id = $1`, [sessionId],
      )), 'OK', 'a non-work session on an aggregate parent is not dispatch');
    });
  } finally {
    await pool.close();
  }
});
