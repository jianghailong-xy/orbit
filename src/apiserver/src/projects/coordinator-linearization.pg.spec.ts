import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Client } from 'pg';

// `PC-CX-09` is the one finding in either review round whose whole claim is about Postgres. It says
// a `BEFORE INSERT` trigger that reads `task.dispatch_authority` with a plain `SELECT` cannot see an
// authority flip that has been written but not committed, and therefore admits a session the flip
// was supposed to forbid. Every other counter-example in this project is a model — a model is the
// right tool when the rule is the contract's own, but here the rule is the *database's*, and a model
// that asserts MVCC semantics is only asserting that whoever wrote it read the manual correctly.
//
// So this one runs against a real server: real tables, the real partial unique index (§7.7 D5), the
// real plpgsql trigger (D6), two real connections, and a barrier between "written" and "committed".
// It runs the two trigger variants (`FOR SHARE` and the v1.1 plain read) against both commit
// orders, and asserts I12 on the committed state — the invariant the review asked for, stated over
// what is in the database rather than over what a code path intended.
//
// It is skipped unless a database is pointed at it, so `node --test` stays green on a laptop:
//
//   docker run -d --name pcc-pg -e POSTGRES_PASSWORD=pcc -e POSTGRES_DB=pcc -p 55433:5432 postgres:16-alpine
//   COORDINATOR_PG_URL=postgres://postgres:pcc@127.0.0.1:55433/pcc node --test …/coordinator-linearization.pg.spec.js
//
// Units 09/13/19/22 still owe the rest of the real-database matrix (§20.7); this closes the first
// row of unit 02's follow-up list, the one that reads "real Postgres, authority UPDATE vs old-binary
// session INSERT, barrier between them, both commit orders".
const URL = process.env.COORDINATOR_PG_URL;

// `pg` is loaded lazily, and only when a database was actually pointed at this file. The driver is a
// direct dependency of this workspace, so in a normal checkout the difference never shows; it shows
// in a bare worktree with no `node_modules`, where a top-level import would turn "skipped" into a
// module-resolution failure and make the skip worthless exactly where it is needed.
type ClientCtor = new (config: { connectionString?: string }) => Client;
async function connect(): Promise<Client> {
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  return client;
}

/** §7.7 D5/D6, as the migration would create them. `forShare` off = v1.1. */
function schema(forShare: boolean): string {
  return `
    DROP TABLE IF EXISTS session, task CASCADE;
    CREATE TABLE task (
      id                 text PRIMARY KEY,
      dispatch_authority text NOT NULL DEFAULT 'LEGACY'
    );
    CREATE TABLE session (
      id                text PRIMARY KEY,
      task_id           text REFERENCES task(id),
      status            text NOT NULL,
      deleted_at        timestamptz,
      dispatch_origin   text NOT NULL DEFAULT 'LEGACY_SWEEP',
      project_action_id text
    );
    CREATE UNIQUE INDEX session_task_execution_claim_idx
        ON session (task_id)
     WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN ('PENDING','RUNNING');

    CREATE OR REPLACE FUNCTION session_dispatch_authority_guard() RETURNS trigger AS $fn$
    DECLARE authority text;
    BEGIN
      IF NEW.task_id IS NULL THEN RETURN NEW; END IF;
      SELECT t.dispatch_authority INTO authority FROM task t WHERE t.id = NEW.task_id${forShare ? ' FOR SHARE' : ''};
      IF authority IS DISTINCT FROM 'COORDINATOR' THEN
        IF NEW.dispatch_origin = 'COORDINATOR' THEN
          RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: coordinator dispatch on a LEGACY task %', NEW.task_id;
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.dispatch_origin = 'USER' THEN RETURN NEW; END IF;
      IF NEW.dispatch_origin = 'COORDINATOR' AND NEW.project_action_id IS NOT NULL THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is COORDINATOR-authority', NEW.task_id;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS session_dispatch_authority_guard ON session;
    CREATE TRIGGER session_dispatch_authority_guard
      BEFORE INSERT ON session
      FOR EACH ROW EXECUTE FUNCTION session_dispatch_authority_guard();

    INSERT INTO task (id, dispatch_authority) VALUES ('X', 'LEGACY');
  `;
}

/** A promise plus a synchronous view of whether it has settled — this is how "it blocked" is read. */
function watch<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const wrapped = p.then(
    (v) => {
      done = true;
      return v;
    },
    (e) => {
      done = true;
      throw e;
    },
  );
  wrapped.catch(() => undefined); // the caller decides when to look at the rejection
  return { promise: wrapped, settled: () => done };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

interface Committed {
  authority: string;
  occupying: { origin: string }[];
  insertRefused: boolean;
  insertBlocked: boolean;
  flipBlocked: boolean;
}

async function race(order: 'FLIP_FIRST' | 'INSERT_FIRST', forShare: boolean): Promise<Committed> {
  const [setup, flip, old] = await Promise.all([connect(), connect(), connect()]);
  let insertRefused = false;
  let insertBlocked = false;
  let flipBlocked = false;
  try {
    await setup.query(schema(forShare));

    // The old binary's insert, verbatim: it does not know the column exists, so `dispatch_origin`
    // takes the DB default and `project_action_id` stays null (§7.7 D6-a).
    const OLD_INSERT = `INSERT INTO session (id, task_id, status) VALUES ('s-legacy', 'X', 'PENDING')`;
    // §7.7 D8-a: lock, then read claims in a *fresh* statement, then write.
    const flipLockScanWrite = async (): Promise<void> => {
      await flip.query(`SELECT id FROM task WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`, [['X']]);
      await flip.query(`
        UPDATE task SET dispatch_authority = 'COORDINATOR'
         WHERE id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM session s
                            WHERE s.task_id = task.id AND s.deleted_at IS NULL
                              AND s.status IN ('PENDING','RUNNING'))`, [['X']]);
    };

    await flip.query('BEGIN');
    await old.query('BEGIN');

    if (order === 'FLIP_FIRST') {
      await flipLockScanWrite();
      // ── barrier: written, not committed ──
      const insert = watch(old.query(OLD_INSERT));
      await settle();
      insertBlocked = !insert.settled();
      await flip.query('COMMIT');
      try {
        await insert.promise;
        await old.query('COMMIT');
      } catch (e) {
        insertRefused = /DISPATCH_AUTHORITY_VIOLATION/.test(String(e));
        await old.query('ROLLBACK');
      }
    } else {
      try {
        await old.query(OLD_INSERT);
      } catch (e) {
        insertRefused = /DISPATCH_AUTHORITY_VIOLATION/.test(String(e));
      }
      // ── barrier: inserted, not committed ──
      const flipped = watch(flipLockScanWrite());
      await settle();
      flipBlocked = !flipped.settled();
      await old.query(insertRefused ? 'ROLLBACK' : 'COMMIT');
      await flipped.promise;
      await flip.query('COMMIT');
    }

    const authority = (await setup.query<{ dispatch_authority: string }>(`SELECT dispatch_authority FROM task WHERE id = 'X'`)).rows[0].dispatch_authority;
    const occupying = (
      await setup.query<{ origin: string }>(
        `SELECT dispatch_origin AS origin FROM session
          WHERE task_id = 'X' AND deleted_at IS NULL AND status IN ('PENDING','RUNNING')`,
      )
    ).rows;
    return { authority, occupying, insertRefused, insertBlocked, flipBlocked };
  } finally {
    await Promise.all([setup.end(), flip.end(), old.end()]);
  }
}

/** I12 on the committed state: the D6 predicate, re-read after both transactions are done. */
function i12Holds(c: Committed): boolean {
  return c.occupying.every((s) =>
    c.authority === 'COORDINATOR' ? s.origin !== 'LEGACY_SWEEP' : s.origin !== 'COORDINATOR',
  );
}

test('PC-CX-09 on real Postgres: FOR SHARE linearizes the flip against the insert', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // Flip first. The trigger's `SELECT … FOR SHARE` conflicts with the `FOR NO KEY UPDATE` the plain
  // UPDATE already took, so the insert *waits*; when it is granted the lock, READ COMMITTED re-reads
  // the newest version of the row (EvalPlanQual) and finds COORDINATOR. Refusal, not admission.
  const flipFirst = await race('FLIP_FIRST', true);
  assert.equal(flipFirst.insertBlocked, true, 'the insert must actually block — that is the whole mechanism');
  assert.equal(flipFirst.insertRefused, true, 'and then be refused by the guard reading the new value');
  assert.equal(flipFirst.authority, 'COORDINATOR');
  assert.deepEqual(flipFirst.occupying, []);
  assert.ok(i12Holds(flipFirst), 'I12 on the committed state');

  // Insert first. Now the flip is the one that waits, and its second statement takes a fresh
  // snapshot with the lock held, so the `NOT EXISTS` sees the claim and the task keeps its
  // authority (D8-b) rather than ending up COORDINATOR with a LEGACY_SWEEP session on it.
  const insertFirst = await race('INSERT_FIRST', true);
  assert.equal(insertFirst.flipBlocked, true, 'the flip must wait for the session insert to commit');
  assert.equal(insertFirst.authority, 'LEGACY', 'a claimed task keeps the authority it had');
  assert.deepEqual(insertFirst.occupying.map((s) => s.origin), ['LEGACY_SWEEP'], 'that session was legal when it was made');
  assert.ok(i12Holds(insertFirst), 'I12 on the committed state');
});

test('PC-CX-09 on real Postgres: a plain SELECT in the trigger reproduces the defect', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // The negative control, and the reason this file exists: remove two words and Postgres does
  // exactly what the review said it does. Neither order blocks, nothing is refused, and the
  // committed state is the one the contract forbids — with a single claim, so D5 sees nothing wrong.
  for (const order of ['FLIP_FIRST', 'INSERT_FIRST'] as const) {
    const v11 = await race(order, false);
    assert.equal(v11.insertBlocked, false, `${order}: nothing blocks without the lock`);
    assert.equal(v11.flipBlocked, false, `${order}: …in either direction`);
    assert.equal(v11.insertRefused, false, `${order}: the guard read a value that was already stale`);
    assert.equal(v11.authority, 'COORDINATOR', order);
    assert.deepEqual(v11.occupying.map((s) => s.origin), ['LEGACY_SWEEP'], order);
    assert.equal(i12Holds(v11), false, `${order}: PC-CX-09 must reproduce on a real server`);
  }
});

test('PC-CX-09 on real Postgres: the guard still refuses and still admits the two legal origins', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // Adding a lock to the guard must not change what it decides once it can see the truth — D6's two
  // permitted branches (a person, and the control loop with an action row) and I11's attribution.
  const c = await connect();
  try {
    await c.query(schema(true));
    await c.query(`UPDATE task SET dispatch_authority = 'COORDINATOR' WHERE id = 'X'`);

    await assert.rejects(
      c.query(`INSERT INTO session (id, task_id, status) VALUES ('s1','X','PENDING')`),
      /DISPATCH_AUTHORITY_VIOLATION/,
      'a legacy-origin insert on a COORDINATOR task is refused (D6-a, D6-c)',
    );
    await assert.rejects(
      c.query(`INSERT INTO session (id, task_id, status, dispatch_origin) VALUES ('s2','X','PENDING','COORDINATOR')`),
      /DISPATCH_AUTHORITY_VIOLATION/,
      'so is a coordinator insert with no action row (I11)',
    );
    await c.query(`INSERT INTO session (id, task_id, status, dispatch_origin) VALUES ('s3','X','PENDING','USER')`);
    // D5: the claim index is what makes the second one a value rather than a crash (§8.5 C1).
    const second = await c.query(
      `INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
       VALUES ('s4','X','PENDING','COORDINATOR','act-1')
       ON CONFLICT (task_id) WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN ('PENDING','RUNNING')
       DO NOTHING RETURNING id`,
    );
    assert.equal(second.rowCount, 0, 'zero rows back, no exception — the coordinator commits the rest of its outcome');
    const live = await c.query<{ origin: string }>(
      `SELECT dispatch_origin AS origin FROM session WHERE task_id='X' AND deleted_at IS NULL AND status IN ('PENDING','RUNNING')`,
    );
    assert.deepEqual(live.rows.map((r) => r.origin), ['USER'], 'exactly one claim, and it is attributable');
  } finally {
    await c.end();
  }
});
