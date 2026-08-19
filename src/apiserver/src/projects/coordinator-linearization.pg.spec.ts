import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

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
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
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

// ─────────────────────────────────────────────────────────────────────────────
// v1.3 · the three rows unit 02's v1.2 review asked for on a real server
// ─────────────────────────────────────────────────────────────────────────────
//
// Round three raised three findings whose whole claim is about Postgres, and two of them the
// review had already reproduced on a real server before the contract was revised: a lock upgrade
// that deadlocks (`PC-CX-19`) and a guard that admits a session it cannot attribute (`PC-CX-20`).
// A model cannot settle either one — the rule being asserted is the database's. `PC-CX-18`'s
// database half (a Task moving between two projects while one of them is being marked DONE) is
// here for the same reason: the claim is that one shared row lock orders them, and that is a
// statement about what `FOR UPDATE` does, not about what the service intended.

/** §13.4 AE6/AE7/AE8's tables, reduced to the two rows the gate is about. */
const ACCEPTANCE_SCHEMA = `
  DROP TABLE IF EXISTS acc_task, acc_project CASCADE;
  CREATE TABLE acc_project (
    id            text PRIMARY KEY,
    status        text NOT NULL DEFAULT 'OPEN',
    evidence_hash text
  );
  CREATE TABLE acc_task (
    id         text PRIMARY KEY,
    project_id text REFERENCES acc_project(id),
    status     text NOT NULL DEFAULT 'DONE'
  );
`;

/** The `taskSet` projection of AE1, computed in SQL so both transactions read the same definition. */
const DIGEST_SQL = `
  SELECT coalesce(string_agg(t.id || ':' || t.status, ',' ORDER BY t.id), '') FROM acc_task t WHERE t.project_id = $1
`;

test('PC-CX-19 on real Postgres: FOR NO KEY UPDATE removes the deadlock the upgrade caused', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // Two acceptance-fact writers. Each takes the project row, reads it, and — because AE8 says a
  // fact write that finds the project DONE must reopen it in the same transaction — updates it.
  // v1.2 told them to take `FOR SHARE` first, and `FOR SHARE` is compatible with itself: both get
  // the lock, then both wait for the other to let go so they can upgrade. That is the definition
  // of a lock-upgrade deadlock, and Postgres names it.
  async function race(mode: 'FOR SHARE' | 'FOR NO KEY UPDATE', writers: number): Promise<{ codes: (string | null)[]; blocked: boolean }> {
    const conns = await Promise.all(Array.from({ length: writers + 1 }, () => connect()));
    const [setup, ...ws] = conns;
    try {
      await setup.query(`${ACCEPTANCE_SCHEMA} INSERT INTO acc_project (id, status) VALUES ('p1','DONE');`);
      for (const w of ws) await w.query('BEGIN');

      // The first writer takes the lock; the rest ask for it while it is held. Under `FOR SHARE`
      // they all get it (compatible), which is precisely how they end up able to deadlock.
      await ws[0].query(`SELECT 1 FROM acc_project WHERE id = 'p1' ${mode}`);
      const waiting = ws.slice(1).map((w) => watch(w.query(`SELECT 1 FROM acc_project WHERE id = 'p1' ${mode}`)));
      await settle();
      const blocked = waiting.some((p) => !p.settled());

      const codes: (string | null)[] = [];
      const finish = async (c: Client): Promise<void> => {
        try {
          await c.query(`UPDATE acc_project SET status = 'OPEN' WHERE id = 'p1'`);
          await c.query('COMMIT');
          codes.push(null);
        } catch (e) {
          codes.push((e as { code?: string }).code ?? 'unknown');
          await c.query('ROLLBACK').catch(() => undefined);
        }
      };
      if (blocked) {
        // The exclusive mode already ordered them: each is granted the lock as the previous commits.
        // Which one is granted next is Postgres' business, not this test's, so every waiter is
        // wired to finish when *its own* lock arrives rather than in the order they were started.
        const rest = waiting.map((p, i) => p.promise.then(() => finish(ws[i + 1])));
        await finish(ws[0]);
        await Promise.all(rest);
      } else {
        // Everybody holds a compatible share lock. Now everybody tries to upgrade.
        await Promise.all(waiting.map((p) => p.promise));
        await Promise.all(ws.map((w) => finish(w)));
      }
      return { codes, blocked };
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  }

  // v1.2: one of them dies with 40P01, and the contract had nothing to say about that code.
  const upgrade = await race('FOR SHARE', 2);
  assert.equal(upgrade.blocked, false, 'FOR SHARE is compatible with itself, so nothing waits…');
  assert.ok(upgrade.codes.includes('40P01'), `…and then they deadlock on the upgrade (got ${JSON.stringify(upgrade.codes)})`);

  // v1.3 (§8.6 LO3): take the lock you will need, once. They queue; everybody commits; no code —
  // with two writers and with three, which is what LO5 asks for.
  for (const writers of [2, 3]) {
    const noUpgrade = await race('FOR NO KEY UPDATE', writers);
    assert.equal(noUpgrade.blocked, true, `${writers} writers: all but the first must wait`);
    assert.deepEqual(noUpgrade.codes, new Array(writers).fill(null), `${writers} writers: everybody commits — queuing, not deadlocking`);
  }
});

test('PC-CX-18 on real Postgres: DONE and every acceptance-fact write share one gate', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // §13.4 AE10. The move writes only the task row, so without the project lock the two
  // transactions have no write conflict and Postgres has no reason to order them — which is
  // exactly how a project ends up DONE with a task set it never accepted.
  async function race(order: 'FACT_FIRST' | 'DONE_FIRST', mutator: 'task.status' | 'task.project_id', gated: boolean): Promise<{ status: string; digest: string; evidence: string | null; doneBlocked: boolean }> {
    const [setup, mover, done] = await Promise.all([connect(), connect(), connect()]);
    try {
      await setup.query(`
        ${ACCEPTANCE_SCHEMA}
        INSERT INTO acc_project (id) VALUES ('p-a'), ('p-b');
        INSERT INTO acc_task (id, project_id) VALUES ('t1','p-a'), ('t2','p-a'), ('moved','p-b');
      `);
      const digestOf = async (c: Client): Promise<string> => (await c.query<{ d: string }>(`SELECT (${DIGEST_SQL}) AS d`, ['p-a'])).rows[0].d;

      // AE6-a / AE10: lock the project rows this write moves — one for a status change, both for a
      // cross-project move, ascending by id (LO1/LO2) — then write the task row.
      const locked = mutator === 'task.project_id' ? ['p-a', 'p-b'] : ['p-a'];
      const write =
        mutator === 'task.project_id'
          ? `UPDATE acc_task SET project_id = 'p-a' WHERE id = 'moved'`
          : `UPDATE acc_task SET status = 'OPEN' WHERE id = 't1'`;
      const move = async (): Promise<void> => {
        if (gated) await mover.query(`SELECT 1 FROM acc_project WHERE id = ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`, [locked]);
        await mover.query(write);
        if (gated) {
          // AE8, for each project whose evidence no longer matches.
          await mover.query(
            `UPDATE acc_project SET status = 'OPEN'
              WHERE id = 'p-a' AND status = 'DONE' AND evidence_hash IS DISTINCT FROM (${DIGEST_SQL})`,
            ['p-a'],
          );
        }
      };
      // AE7 + AE2: exclusive lock, recompute inside the transaction, only then write DONE.
      const markDone = async (): Promise<void> => {
        await done.query(`SELECT 1 FROM acc_project WHERE id = 'p-a' FOR UPDATE`);
        await done.query(
          `UPDATE acc_project SET status = 'DONE', evidence_hash = (${DIGEST_SQL})
            WHERE id = 'p-a' AND evidence_hash IS NOT DISTINCT FROM (${DIGEST_SQL})`,
          ['p-a'],
        );
      };

      await mover.query('BEGIN');
      await done.query('BEGIN');
      // The evidence is written on the pre-move facts, the way an acceptance run would have.
      await setup.query(`UPDATE acc_project SET evidence_hash = (${DIGEST_SQL}) WHERE id = 'p-a'`, ['p-a']);

      let doneBlocked = false;
      if (order === 'DONE_FIRST') {
        await markDone();
        const pending = watch(move());
        await settle();
        doneBlocked = !pending.settled(); // here it is the fact write that waits
        await done.query('COMMIT');
        await pending.promise;
        await mover.query('COMMIT');
      } else {
        await move();
        const pending = watch(markDone());
        await settle();
        doneBlocked = !pending.settled();
        await mover.query('COMMIT');
        await pending.promise;
        await done.query('COMMIT');
      }

      const row = (await setup.query<{ status: string; evidence_hash: string | null }>(`SELECT status, evidence_hash FROM acc_project WHERE id = 'p-a'`)).rows[0];
      return { status: row.status, digest: await digestOf(setup), evidence: row.evidence_hash, doneBlocked };
    } finally {
      await Promise.all([setup.end(), mover.end(), done.end()]);
    }
  }

  // I10, over the committed state: DONE only ever stands on evidence that matches the facts.
  const i10 = (r: { status: string; digest: string; evidence: string | null }): boolean => r.status !== 'DONE' || r.evidence === r.digest;

  for (const mutator of ['task.status', 'task.project_id'] as const) {
    const factFirst = await race('FACT_FIRST', mutator, true);
    assert.equal(factFirst.doneBlocked, true, `${mutator}: DONE must wait behind the fact write holding the project row`);
    assert.equal(factFirst.status, 'OPEN', `${mutator}: and then find the facts moved, so it refuses (ACCEPTANCE_EVIDENCE_STALE)`);
    assert.ok(i10(factFirst), `${mutator}: I10 on the committed state`);

    const doneFirst = await race('DONE_FIRST', mutator, true);
    assert.equal(doneFirst.doneBlocked, true, `${mutator}: the fact write must wait behind DONE…`);
    assert.equal(doneFirst.status, 'OPEN', `${mutator}: …and then reopen the project atomically (AE8)`);
    assert.ok(i10(doneFirst), `${mutator}: I10 on the committed state`);
  }

  // Without the gate, a plain status change is ordered by nothing at all: it writes the task row,
  // DONE writes the project row, and Postgres has no reason to sequence two transactions that
  // touch different rows. Both orders commit, and both leave the state I10 forbids.
  for (const order of ['FACT_FIRST', 'DONE_FIRST'] as const) {
    const ungated = await race(order, 'task.status', false);
    assert.equal(ungated.doneBlocked, false, `${order}: nothing orders them without the shared lock`);
    assert.equal(ungated.status, 'DONE', order);
    assert.equal(i10(ungated), false, `PC-CX-13/18 must reproduce on a real server (${order})`);
  }

  // Negative control: v1.2 never listed `task.project_id` as an acceptance-fact write, so the move
  // takes no project lock at all. What happens then is worth stating precisely, because it is not
  // what a reading of the contract would predict — and because it is the argument for AE10 rather
  // than against it.
  //
  // Moving a task writes `task.project_id`, which is a foreign key, and Postgres takes a
  // `FOR KEY SHARE` lock on the referenced project row to check it. `FOR KEY SHARE` conflicts with
  // `FOR UPDATE`, so in one direction the DONE gate *is* incidentally ordered behind the move and
  // then correctly refuses. That is luck, not a gate: it exists only for this one projection (the
  // other three touch no foreign key of `project`), and in the other direction it does nothing at
  // all, because nothing makes the mover look at a project that is already DONE.
  const ungatedMoveFirst = await race('FACT_FIRST', 'task.project_id', false);
  assert.equal(ungatedMoveFirst.status, 'OPEN', 'the FK key-share lock happens to order this direction');
  assert.ok(i10(ungatedMoveFirst), 'so this one is accidentally safe — and only this one');

  const ungatedDoneFirst = await race('DONE_FIRST', 'task.project_id', false);
  assert.equal(ungatedDoneFirst.status, 'DONE', 'DONE commits first, and then the task set moves under it');
  assert.equal(i10(ungatedDoneFirst), false, 'PC-CX-18 must reproduce on a real server');
});

/** §7.7 D6 with the v1.3 predicate, D9's deferred constraint, and the CHECK. `v12` = the old guard. */
function attributionSchema(version: 'v12' | 'v13'): string {
  const guard =
    version === 'v13'
      ? `IF NEW.dispatch_origin = 'USER' THEN
           IF NEW.project_action_id IS NOT NULL THEN
             RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: user-origin session % carries an action id', NEW.id;
           END IF;
           RETURN NEW;
         END IF;
         IF NEW.dispatch_origin = 'COORDINATOR' AND NEW.project_action_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM project_action a
                JOIN task t2 ON t2.id = NEW.task_id
                JOIN project_runtime r ON r.project_id = a.project_id
               WHERE a.id = NEW.project_action_id
                 AND a.type = 'DISPATCH_TASK' AND a.status IN ('CLAIMED','APPLIED')
                 AND a.subject_type = 'TASK' AND a.subject_id = NEW.task_id
                 AND a.project_id = t2.project_id AND a.fencing_token = r.fencing_token
            ) THEN RETURN NEW; END IF;`
      : `IF NEW.dispatch_origin = 'USER' THEN RETURN NEW; END IF;
         IF NEW.dispatch_origin = 'COORDINATOR' AND NEW.project_action_id IS NOT NULL THEN RETURN NEW; END IF;`;
  const deferred =
    version === 'v13'
      ? `CREATE OR REPLACE FUNCTION session_dispatch_attribution_check() RETURNS trigger AS $fn2$
         DECLARE ok boolean;
         BEGIN
           IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
           SELECT EXISTS (
             SELECT 1 FROM project_action a
               JOIN task t ON t.id = NEW.task_id
               JOIN project_runtime r ON r.project_id = a.project_id
              WHERE a.id = NEW.project_action_id
                AND a.type = 'DISPATCH_TASK' AND a.status = 'APPLIED'
                AND a.subject_type = 'TASK' AND a.subject_id = NEW.task_id
                AND a.project_id = t.project_id AND a.fencing_token = r.fencing_token
           ) INTO ok;
           IF NOT ok THEN
             RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: session % is not attributable to an applied dispatch', NEW.id;
           END IF;
           RETURN NULL;
         END;
         $fn2$ LANGUAGE plpgsql;
         CREATE CONSTRAINT TRIGGER session_dispatch_attribution_check
           AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id ON session
           DEFERRABLE INITIALLY DEFERRED
           FOR EACH ROW EXECUTE FUNCTION session_dispatch_attribution_check();`
      : '';
  return `
    DROP TABLE IF EXISTS session, project_action, task, project_runtime, project CASCADE;
    CREATE TABLE project (id text PRIMARY KEY);
    CREATE TABLE project_runtime (project_id text PRIMARY KEY REFERENCES project(id), fencing_token bigint NOT NULL DEFAULT 0);
    CREATE TABLE task (id text PRIMARY KEY, project_id text REFERENCES project(id), dispatch_authority text NOT NULL DEFAULT 'COORDINATOR');
    CREATE TABLE project_action (
      id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id),
      type text NOT NULL, status text NOT NULL, subject_type text, subject_id text, fencing_token bigint NOT NULL
    );
    CREATE TABLE session (
      id text PRIMARY KEY, task_id text REFERENCES task(id), status text NOT NULL,
      deleted_at timestamptz, dispatch_origin text NOT NULL DEFAULT 'LEGACY_SWEEP',
      project_action_id text REFERENCES project_action(id)
      ${version === 'v13' ? `, CONSTRAINT session_action_only_for_coordinator_chk CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL)` : ''}
    );

    CREATE OR REPLACE FUNCTION session_dispatch_authority_guard() RETURNS trigger AS $fn$
    DECLARE authority text;
    BEGIN
      IF NEW.task_id IS NULL THEN RETURN NEW; END IF;
      SELECT t.dispatch_authority INTO authority FROM task t WHERE t.id = NEW.task_id FOR SHARE;
      IF authority IS DISTINCT FROM 'COORDINATOR' THEN
        IF NEW.dispatch_origin = 'COORDINATOR' THEN
          RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: coordinator dispatch on a LEGACY task %', NEW.task_id;
        END IF;
        RETURN NEW;
      END IF;
      ${guard}
      RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is COORDINATOR-authority', NEW.task_id;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS session_dispatch_authority_guard ON session;
    CREATE TRIGGER session_dispatch_authority_guard
      BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION session_dispatch_authority_guard();
    ${deferred}

    INSERT INTO project (id) VALUES ('p1'), ('p2');
    INSERT INTO project_runtime (project_id, fencing_token) VALUES ('p1', 42), ('p2', 7);
    INSERT INTO task (id, project_id) VALUES ('X', 'p1'), ('Y', 'p1');
  `;
}

test('PC-CX-20 on real Postgres: the deferred constraint proves I11 on the committed state', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // I11 is a statement about committed rows, so this asserts after COMMIT and nowhere else. The
  // action table is real here, with a foreign key, which is the thing the v1.2 spec could not do
  // and therefore the thing that let `project_action_id IS NOT NULL` look like a check.
  const c = await connect();
  try {
    await c.query(attributionSchema('v13'));

    /** One attempt at the §8.3 sequence: claim the action, insert the session, apply the action. */
    async function attempt(sql: { action: string; session: string; after?: string }): Promise<string | null> {
      await c.query('BEGIN');
      try {
        await c.query(sql.action);
        await c.query(sql.session);
        if (sql.after) await c.query(sql.after);
        await c.query('COMMIT');
        return null;
      } catch (e) {
        await c.query('ROLLBACK');
        return /DISPATCH_(AUTHORITY|ATTRIBUTION)_VIOLATION/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`;
      }
    }
    const claim = (over: Partial<Record<'id' | 'project' | 'type' | 'status' | 'subject' | 'token', string>> = {}): string =>
      `INSERT INTO project_action (id, project_id, type, status, subject_type, subject_id, fencing_token)
       VALUES ('${over.id ?? 'a1'}', '${over.project ?? 'p1'}', '${over.type ?? 'DISPATCH_TASK'}', '${over.status ?? 'CLAIMED'}', 'TASK', '${over.subject ?? 'X'}', ${over.token ?? 42})`;
    const insert = (over: { id?: string; origin?: string; action?: string | null; task?: string } = {}): string =>
      `INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
       VALUES ('${over.id ?? 's1'}', '${over.task ?? 'X'}', 'PENDING', '${over.origin ?? 'COORDINATOR'}', ${over.action === null ? 'NULL' : `'${over.action ?? 'a1'}'`})`;
    const apply = (id = 'a1'): string => `UPDATE project_action SET status = 'APPLIED' WHERE id = '${id}'`;

    // The legitimate sequence. It only commits because the constraint is deferred: at the moment
    // the session row goes in, the action it points at is still CLAIMED (D9-b).
    assert.equal(await attempt({ action: claim(), session: insert(), after: apply() }), null, 'the normal dispatch must still commit');
    const live = await c.query<{ origin: string; type: string; status: string }>(
      `SELECT s.dispatch_origin AS origin, a.type, a.status
         FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id = 's1'`,
    );
    assert.deepEqual(live.rows, [{ origin: 'COORDINATOR', type: 'DISPATCH_TASK', status: 'APPLIED' }], 'I11 on the committed state');

    // Six refusals, one per column the review said D6 was not reading.
    const refusals: [string, { action: string; session: string; after?: string }][] = [
      ['wrong type', { action: claim({ id: 'a2', type: 'NOOP' }), session: insert({ id: 's2', action: 'a2' }), after: apply('a2') }],
      ['never applied', { action: claim({ id: 'a3' }), session: insert({ id: 's3', action: 'a3' }) }],
      ['another task', { action: claim({ id: 'a4', subject: 'Y' }), session: insert({ id: 's4', action: 'a4' }), after: apply('a4') }],
      ['another project', { action: claim({ id: 'a5', project: 'p2', token: '7' }), session: insert({ id: 's5', action: 'a5' }), after: apply('a5') }],
      ['stale fencing token', { action: claim({ id: 'a6', token: '41' }), session: insert({ id: 's6', action: 'a6' }), after: apply('a6') }],
      ['user origin carrying an action', { action: claim({ id: 'a7' }), session: insert({ id: 's7', origin: 'USER', action: 'a7' }), after: apply('a7') }],
    ];
    for (const [name, sql] of refusals) {
      const refusal = await attempt(sql);
      assert.match(refusal ?? 'committed', /DISPATCH_(AUTHORITY|ATTRIBUTION)_VIOLATION/, `${name} must not reach a committed state (got ${refusal})`);
    }

    // A session spoiled *after* its insert is the case a BEFORE trigger structurally cannot see.
    const spoiled = await attempt({ action: claim({ id: 'a8' }), session: insert({ id: 's8', action: 'a8' }), after: `UPDATE project_action SET status = 'SUPERSEDED' WHERE id = 'a8'` });
    assert.match(spoiled ?? 'committed', /DISPATCH_ATTRIBUTION_VIOLATION/, 'D9 re-reads at commit, so the late rewrite is refused');

    // And the two legal origins still work: a person, and a coordinator with a real applied action.
    assert.equal(await attempt({ action: `SELECT 1`, session: insert({ id: 's9', task: 'Y', origin: 'USER', action: null }) }), null, 'a person may still start a task');
    const all = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM session`);
    assert.equal(all.rows[0].n, '2', 'exactly the two sessions that were attributable');
  } finally {
    await c.end();
  }
});

test('PC-CX-20 on real Postgres: the v1.2 predicate admits a session it cannot attribute', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // The negative control, and the review's own reproduction: with `project_action_id IS NOT NULL`
  // as the whole check, a NOOP that was never applied is enough to get a COORDINATOR claim
  // committed — and `i11Satisfied` is false on the state that is actually in the database.
  const c = await connect();
  try {
    await c.query(attributionSchema('v12'));
    await c.query('BEGIN');
    await c.query(`INSERT INTO project_action (id, project_id, type, status, subject_type, subject_id, fencing_token)
                   VALUES ('a1','p1','NOOP','CLAIMED','TASK','X',42)`);
    await c.query(`INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
                   VALUES ('s1','X','PENDING','COORDINATOR','a1')`);
    await c.query('COMMIT');

    const linked = await c.query<{ type: string; status: string }>(
      `SELECT a.type, a.status FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id = 's1'`,
    );
    assert.deepEqual(linked.rows, [{ type: 'NOOP', status: 'CLAIMED' }], 'committed, and pointing at a NOOP');
    const i11 = linked.rows.every((r) => r.type === 'DISPATCH_TASK' && r.status === 'APPLIED');
    assert.equal(i11, false, 'PC-CX-20 must reproduce on a real server');

    // …and so is a USER-origin session carrying somebody else's action row.
    await c.query(`INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
                   VALUES ('s2','Y','PENDING','USER','a1')`);
    const user = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM session WHERE dispatch_origin = 'USER' AND project_action_id IS NOT NULL`);
    assert.equal(user.rows[0].n, '1', 'v1.2 had nothing that forbade this');
  } finally {
    await c.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.4 — the three findings of `PC-CX-21..27` whose claims are about the database itself.
//
// Everything here lives in its own schema. The v1.3 re-review lost a run to two spec files racing
// to rebuild `public.task`, and the lesson generalises: a fixture that owns a schema cannot collide
// with one that owns another, no matter what the runner decides to parallelise.
// ─────────────────────────────────────────────────────────────────────────────

const V14_SCHEMA = 'pcc_v14';

/** Session-scoped isolation for every v1.4 fixture below. */
function isolated(body: string): string {
  return `
    DROP SCHEMA IF EXISTS ${V14_SCHEMA} CASCADE;
    CREATE SCHEMA ${V14_SCHEMA};
    SET search_path TO ${V14_SCHEMA};
    ${body}
  `;
}

/** §7.7 D9 + D10 + D11 — attribution, plus the mutator protocols for the rows D9 reads. */
const ATTRIBUTION_V14 = isolated(`
  CREATE TABLE project (id text PRIMARY KEY);
  CREATE TABLE project_runtime (project_id text PRIMARY KEY REFERENCES project(id), fencing_token bigint NOT NULL);
  CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id));
  CREATE TABLE project_action (
    id text PRIMARY KEY,
    idempotency_key text UNIQUE NOT NULL,
    project_id text NOT NULL REFERENCES project(id),
    type text NOT NULL, status text NOT NULL,
    subject_type text NOT NULL, subject_id text NOT NULL,
    fencing_token bigint NOT NULL,
    result_session_id text, detail text
  );
  CREATE TABLE session (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES task(id),
    status text NOT NULL,
    deleted_at timestamptz,
    dispatch_origin text NOT NULL,
    project_action_id text REFERENCES project_action(id),
    CONSTRAINT session_action_only_for_coordinator_chk
      CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL)
  );

  -- D9, verbatim from §7.7: the commit-time authorisation proof (I11-B).
  CREATE OR REPLACE FUNCTION session_dispatch_attribution_check() RETURNS trigger AS $fn$
  DECLARE ok boolean;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT EXISTS (
      SELECT 1 FROM project_action a
        JOIN task t ON t.id = NEW.task_id
        JOIN project_runtime r ON r.project_id = a.project_id
       WHERE a.id = NEW.project_action_id
         AND a.type = 'DISPATCH_TASK' AND a.status = 'APPLIED'
         AND a.subject_type = 'TASK' AND a.subject_id = NEW.task_id
         AND a.project_id = t.project_id AND a.fencing_token = r.fencing_token
    ) INTO ok;
    IF NOT ok THEN RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION: session % is not attributable', NEW.id; END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
  CREATE CONSTRAINT TRIGGER session_dispatch_attribution_check
    AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id ON session
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION session_dispatch_attribution_check();

  -- D10: a claimed task refuses to change project, so a.project_id = t.project_id cannot decay.
  CREATE OR REPLACE FUNCTION task_claimed_project_move_guard() RETURNS trigger AS $fn$
  BEGIN
    IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM session s WHERE s.task_id = NEW.id AND s.deleted_at IS NULL
                 AND s.status IN ('PENDING','RUNNING')) THEN
      RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live claim and cannot change project', NEW.id;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
  CREATE CONSTRAINT TRIGGER task_claimed_project_move_guard
    AFTER UPDATE OF project_id ON task
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task_claimed_project_move_guard();

  -- D11: APPLIED is terminal, and its attribution columns are frozen with it.
  CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
  BEGIN
    IF OLD.status <> 'APPLIED' THEN RETURN NEW; END IF;
    IF NEW.status <> 'APPLIED'
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE: action % is APPLIED', OLD.id;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
  CREATE TRIGGER project_action_applied_immutable_guard
    BEFORE UPDATE ON project_action FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard();

  INSERT INTO project VALUES ('p1'), ('p2');
  INSERT INTO project_runtime VALUES ('p1', 42), ('p2', 7);
  INSERT INTO task VALUES ('X', 'p1');
`);

test('PC-CX-21 on real Postgres: the next lease keeps I11-A and a live task move is refused', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const c = await connect();
  try {
    await c.query(ATTRIBUTION_V14);

    /** §4.3 I11-A — the standing half, as one query over committed rows. */
    const i11A = async (sessionId: string): Promise<boolean> => {
      const q = await c.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM session s
             JOIN task t ON t.id = s.task_id
             JOIN project_action a ON a.id = s.project_action_id
             JOIN project_runtime r ON r.project_id = a.project_id
            WHERE s.id = $1
              AND a.type = 'DISPATCH_TASK' AND a.status = 'APPLIED'
              AND a.subject_type = 'TASK' AND a.subject_id = s.task_id
              AND a.project_id = t.project_id
              AND a.fencing_token <= r.fencing_token
         ) AS ok`, [sessionId]);
      return q.rows[0].ok;
    };
    /** The v1.3 reading of the same sentence — the equality, taken as standing. */
    const i11Equality = async (sessionId: string): Promise<boolean> => {
      const q = await c.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM session s
             JOIN project_action a ON a.id = s.project_action_id
             JOIN project_runtime r ON r.project_id = a.project_id
            WHERE s.id = $1 AND a.fencing_token = r.fencing_token
         ) AS ok`, [sessionId]);
      return q.rows[0].ok;
    };

    // §8.3's statement order, which only commits because D9 is deferred (D9-b).
    await c.query('BEGIN');
    await c.query(`INSERT INTO project_action (id, idempotency_key, project_id, type, status, subject_type, subject_id, fencing_token)
                   VALUES ('a1','pc:v1:p1:dispatch:X:0','p1','DISPATCH_TASK','CLAIMED','TASK','X',42)`);
    await c.query(`INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
                   VALUES ('s1','X','PENDING','COORDINATOR','a1')`);
    await c.query(`UPDATE project_action SET status = 'APPLIED', result_session_id = 's1' WHERE id = 'a1'`);
    await c.query('COMMIT');
    assert.equal(await i11A('s1'), true, 'the dispatch is attributable the moment it commits');
    assert.equal(await i11Equality('s1'), true, 'and so is the commit-time equality, at that moment');

    // Interleaving A: the next few ordinary leases. §8.1 makes the token monotone; the session's
    // three columns never move, so D9 is not scheduled again — and does not need to be.
    for (const token of [43, 44, 45]) {
      await c.query(`UPDATE project_runtime SET fencing_token = $1 WHERE project_id = 'p1'`, [token]);
      assert.equal(await i11A('s1'), true, `I11-A must still hold at token ${token}`);
    }
    assert.equal(await i11Equality('s1'), false, 'negative control: the equality reading is false after one normal lease');
    await c.query(`UPDATE project_runtime SET fencing_token = 42 WHERE project_id = 'p1'`);

    // Interleaving B: a legal AE10 move while the claim is live. D10 refuses at COMMIT.
    let refusal: string | null = null;
    await c.query('BEGIN');
    try {
      await c.query(`UPDATE task SET project_id = 'p2' WHERE id = 'X'`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      refusal = /TASK_CLAIMED_PROJECT_MOVE/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`;
    }
    assert.equal(refusal, 'TASK_CLAIMED_PROJECT_MOVE', 'a live claim must refuse the move');
    const stillHome = await c.query<{ project_id: string }>(`SELECT project_id FROM task WHERE id = 'X'`);
    assert.equal(stillHome.rows[0].project_id, 'p1', 'a refused move leaves the row untouched');
    assert.equal(await i11A('s1'), true);

    // D10-c: it is a refusal, not a prohibition. Release the claim and the move is ordinary again.
    await c.query(`UPDATE session SET status = 'SUCCEEDED' WHERE id = 's1'`);
    await c.query(`UPDATE task SET project_id = 'p2' WHERE id = 'X'`);
    const moved = await c.query<{ project_id: string }>(`SELECT project_id FROM task WHERE id = 'X'`);
    assert.equal(moved.rows[0].project_id, 'p2', 'an unclaimed task moves exactly as AE10 always allowed');
    await c.query(`UPDATE task SET project_id = 'p1' WHERE id = 'X'`);

    // D11: the other rows D9 reads are frozen once the action is APPLIED — and only those.
    const frozen: [string, string][] = [
      ['type', `UPDATE project_action SET type = 'NOOP' WHERE id = 'a1'`],
      ['status', `UPDATE project_action SET status = 'SUPERSEDED' WHERE id = 'a1'`],
      ['subject_id', `UPDATE project_action SET subject_id = 'Y' WHERE id = 'a1'`],
      ['project_id', `UPDATE project_action SET project_id = 'p2' WHERE id = 'a1'`],
      ['fencing_token', `UPDATE project_action SET fencing_token = 99 WHERE id = 'a1'`],
      ['idempotency_key', `UPDATE project_action SET idempotency_key = 'other' WHERE id = 'a1'`],
    ];
    for (const [name, sql] of frozen) {
      let refused: string | null = null;
      try { await c.query(sql); } catch (e) { refused = /ACTION_APPLIED_IMMUTABLE/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`; }
      assert.equal(refused, 'ACTION_APPLIED_IMMUTABLE', `${name} must be immutable on an APPLIED action`);
    }
    await c.query(`UPDATE project_action SET detail = 'still writable' WHERE id = 'a1'`); // D11-b
    assert.equal(await i11A('s1'), true, 'attribution survives every mutation attempt');

    // …and the normal ledger transition is untouched, or §8.3's own path would be blocked.
    await c.query(`INSERT INTO project_action (id, idempotency_key, project_id, type, status, subject_type, subject_id, fencing_token)
                   VALUES ('a2','pc:v1:p1:dispatch:X:1','p1','DISPATCH_TASK','CLAIMED','TASK','X',42)`);
    await c.query(`UPDATE project_action SET status = 'SUPERSEDED' WHERE id = 'a2'`);
    const a2 = await c.query<{ status: string }>(`SELECT status FROM project_action WHERE id = 'a2'`);
    assert.equal(a2.rows[0].status, 'SUPERSEDED', 'CLAIMED → SUPERSEDED is the normal path (D11-a)');
  } finally {
    await c.end();
  }
});

/** §7.7 D8-a/D12 + D6. `projection` off = v1.2, where the column was a service-layer duty. */
function authoritySchema(projection: boolean): string {
  return isolated(`
    CREATE TABLE project (id text PRIMARY KEY, coordinator_enabled boolean NOT NULL DEFAULT false);
    CREATE TABLE task (
      id text PRIMARY KEY,
      project_id text REFERENCES project(id),
      dispatch_authority text NOT NULL DEFAULT 'LEGACY'
    );
    CREATE TABLE session (
      id text PRIMARY KEY, task_id text NOT NULL REFERENCES task(id),
      status text NOT NULL, deleted_at timestamptz,
      dispatch_origin text NOT NULL DEFAULT 'LEGACY_SWEEP'
    );
    CREATE UNIQUE INDEX session_task_execution_claim_idx ON session (task_id)
      WHERE deleted_at IS NULL AND status IN ('PENDING','RUNNING');

    -- D6, unchanged: the insert-time admission that makes I12-B true.
    CREATE OR REPLACE FUNCTION session_dispatch_authority_guard() RETURNS trigger AS $fn$
    DECLARE authority text;
    BEGIN
      SELECT t.dispatch_authority INTO authority FROM task t WHERE t.id = NEW.task_id FOR SHARE;
      IF authority IS DISTINCT FROM 'COORDINATOR' THEN
        IF NEW.dispatch_origin = 'COORDINATOR' THEN
          RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: coordinator dispatch on a LEGACY task %', NEW.task_id;
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.dispatch_origin IN ('COORDINATOR','USER') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'DISPATCH_AUTHORITY_VIOLATION: task % is COORDINATOR-authority', NEW.task_id;
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER session_dispatch_authority_guard
      BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION session_dispatch_authority_guard();

    ${projection ? `
    CREATE OR REPLACE FUNCTION task_dispatch_authority_projection() RETURNS trigger AS $fn$
    DECLARE enabled boolean;
    BEGIN
      IF NEW.project_id IS NULL THEN NEW.dispatch_authority := 'LEGACY'; RETURN NEW; END IF;
      SELECT p.coordinator_enabled INTO enabled FROM project p WHERE p.id = NEW.project_id FOR SHARE;
      NEW.dispatch_authority := CASE WHEN enabled THEN 'COORDINATOR' ELSE 'LEGACY' END;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER task_dispatch_authority_projection
      BEFORE INSERT OR UPDATE OF project_id, dispatch_authority ON task
      FOR EACH ROW EXECUTE FUNCTION task_dispatch_authority_projection();

    CREATE OR REPLACE FUNCTION project_dispatch_authority_fanout() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.coordinator_enabled IS NOT DISTINCT FROM OLD.coordinator_enabled THEN RETURN NULL; END IF;
      UPDATE task SET dispatch_authority = dispatch_authority
       WHERE id IN (SELECT id FROM task WHERE project_id = NEW.id ORDER BY id FOR NO KEY UPDATE);
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql;
    CREATE TRIGGER project_dispatch_authority_fanout
      AFTER UPDATE OF coordinator_enabled ON project
      FOR EACH ROW EXECUTE FUNCTION project_dispatch_authority_fanout();
    ` : ''}

    INSERT INTO project (id, coordinator_enabled) VALUES ('p1', true), ('p0', false);
    INSERT INTO task (id, project_id) VALUES ('legacy', 'p0'), ('owned', 'p1'), ('orphan', NULL);
    -- Both fixtures start consistent, so what the test measures is the old writer's writes rather
    -- than the seed. Under v1.2 that consistency is the *service layer's* job at insert time, which
    -- is exactly the assumption the finding is about — so here it is written out by hand.
    ${projection ? '' : `UPDATE task SET dispatch_authority = 'COORDINATOR' WHERE project_id = 'p1';`}
  `);
}

/** §7.7 D13 — the drift query, run against whatever is committed. */
const DRIFT_SQL = `
  SELECT t.id FROM task t LEFT JOIN project p ON p.id = t.project_id
   WHERE t.dispatch_authority IS DISTINCT FROM
         (CASE WHEN p.id IS NOT NULL AND p.coordinator_enabled THEN 'COORDINATOR' ELSE 'LEGACY' END)
   ORDER BY t.id`;

test('PC-CX-25 on real Postgres: an old writer cannot leave the authority projection stale', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // Every write below is SQL an apiserver that has never heard of `dispatch_authority` would emit:
  // it names `project_id`, `coordinator_enabled` or `session.status`, and nothing else. That is the
  // whole point — the review's counterexample needs no race, only an old binary.
  const c = await connect();
  try {
    for (const projection of [true, false]) {
      await c.query(authoritySchema(projection));
      const drift = async (): Promise<string[]> => (await c.query<{ id: string }>(DRIFT_SQL)).rows.map((r) => r.id);
      const authorityOf = async (id: string): Promise<string> =>
        (await c.query<{ a: string }>(`SELECT dispatch_authority AS a FROM task WHERE id = $1`, [id])).rows[0].a;
      const label = projection ? 'v1.4' : 'negative control (v1.2)';

      assert.deepEqual(await drift(), [], `${label}: the fixture starts consistent`);

      // A. move-in: a legacy task lands in a coordinator-enabled project.
      await c.query(`UPDATE task SET project_id = 'p1' WHERE id = 'legacy'`);
      assert.deepEqual(await drift(), projection ? [] : ['legacy'], `${label}: after an old-writer move-in`);
      const sweep = async (task: string, id: string): Promise<string | null> => {
        try {
          await c.query(`INSERT INTO session (id, task_id, status) VALUES ($1, $2, 'PENDING')`, [id, task]);
          return null;
        } catch (e) { return /DISPATCH_AUTHORITY_VIOLATION/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`; }
      };
      assert.equal(
        await sweep('legacy', 'sweep-1'),
        projection ? 'DISPATCH_AUTHORITY_VIOLATION' : null,
        `${label}: D6 can only be as good as the column it reads`,
      );

      // B. a claim in flight when the project is enabled, released by an old writer. v1.2 needed a
      // repair inside that transaction; v1.4 never skipped, so there is nothing to repair.
      await c.query(`UPDATE project SET coordinator_enabled = false WHERE id = 'p1'`);
      if (!projection) await c.query(`UPDATE task SET dispatch_authority = 'LEGACY' WHERE project_id = 'p1'`);
      await c.query(`INSERT INTO session (id, task_id, status) VALUES ('claim-1', 'owned', 'RUNNING')`);
      await c.query(`UPDATE project SET coordinator_enabled = true WHERE id = 'p1'`);
      await c.query(`UPDATE session SET status = 'SUCCEEDED' WHERE id = 'claim-1'`);
      assert.equal(
        (await drift()).includes('owned'),
        !projection,
        `${label}: after an old writer ends a claim`,
      );

      // C. the remaining write paths, each emitted by a writer that does not know the column.
      for (const [why, sql] of [
        ['move-out', `UPDATE task SET project_id = NULL WHERE id = 'legacy'`],
        ['cross-project move', `UPDATE task SET project_id = 'p0' WHERE id = 'legacy'`],
        ['insert', `INSERT INTO task (id, project_id) VALUES ('fresh', 'p1')`],
        ['disable', `UPDATE project SET coordinator_enabled = false WHERE id = 'p1'`],
        ['enable', `UPDATE project SET coordinator_enabled = true WHERE id = 'p1'`],
      ] as [string, string][]) {
        await c.query(sql);
        if (projection) assert.deepEqual(await drift(), [], `v1.4: ${why} must keep I12-A true`);
      }
      if (!projection) assert.ok((await drift()).length > 0, 'negative control: the projection is stale in several places at once');

      // D. even a writer that sets the column directly cannot set it wrong: it is derived.
      await c.query(`UPDATE task SET dispatch_authority = 'LEGACY' WHERE id = 'fresh'`);
      assert.equal(await authorityOf('fresh'), projection ? 'COORDINATOR' : 'LEGACY', `${label}: a direct write to a derived column`);

      // E. I12-B: after a flip, no new legacy claim can be admitted — that is what replaces v1.2's
      // "the flip waits for the claim", and it is proved by D6 rather than by a skip.
      if (projection) {
        assert.deepEqual(await drift(), []);
        assert.equal(await sweep('fresh', 'sweep-2'), 'DISPATCH_AUTHORITY_VIOLATION', 'no post-flip legacy claim');

        // …and the other direction, because v1.4's flip no longer waits for a claim: after a
        // disable, a COORDINATOR claim is the one that can no longer be admitted. I12-B is stated
        // for both directions, so both are run.
        const coordinatorClaim = async (task: string, id: string): Promise<string | null> => {
          try {
            await c.query(`INSERT INTO session (id, task_id, status, dispatch_origin) VALUES ($1, $2, 'PENDING', 'COORDINATOR')`, [id, task]);
            return null;
          } catch (e) { return /DISPATCH_AUTHORITY_VIOLATION/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`; }
        };
        assert.equal(await coordinatorClaim('fresh', 'auto-1'), null, 'a coordinator claim is legal while the project is enabled');
        await c.query(`UPDATE session SET status = 'SUCCEEDED' WHERE id = 'auto-1'`);
        await c.query(`UPDATE project SET coordinator_enabled = false WHERE id = 'p1'`);
        assert.deepEqual(await drift(), [], 'the disable is projected too');
        assert.equal(await coordinatorClaim('fresh', 'auto-2'), 'DISPATCH_AUTHORITY_VIOLATION', 'no post-disable coordinator claim');
      }
    }
  } finally {
    await c.end();
  }
});

/** §9.6 AU1/CAP1 — the gate is LO1's first level, which the human write takes automatically. */
const GATE_SCHEMA = isolated(`
  CREATE TABLE project (
    id text PRIMARY KEY,
    coordinator_enabled boolean NOT NULL,
    automation_policy text NOT NULL,
    max_concurrent_tasks int NOT NULL,
    config_revision bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id));
  CREATE TABLE session (id text PRIMARY KEY, task_id text NOT NULL REFERENCES task(id), status text NOT NULL, deleted_at timestamptz);
  CREATE UNIQUE INDEX session_task_execution_claim_idx ON session (task_id)
    WHERE deleted_at IS NULL AND status IN ('PENDING','RUNNING');
  INSERT INTO project VALUES ('p1', true, 'AUTO', 1, 7);
  INSERT INTO task VALUES ('A', 'p1'), ('B', 'p1');
`);

interface GateOutcome {
  dispatched: boolean;
  refusalCode: string | null;
  blocked: boolean;
  claims: number;
  coordinatorEnabled: boolean;
}

/**
 * One barrier between a human write and a coordinator commit. `gated` off = v1.3, whose only commit
 * predicate was the fencing token — a value the human write never advances.
 */
async function gateRacePg(order: 'HUMAN_FIRST' | 'COORDINATOR_FIRST', gated: boolean): Promise<GateOutcome> {
  const [setup, human, loop] = await Promise.all([connect(), connect(), connect()]);
  let blocked = false;
  try {
    await setup.query(GATE_SCHEMA);
    for (const c of [human, loop]) await c.query(`SET search_path TO ${V14_SCHEMA}`);

    const humanRevoke = async (): Promise<void> => {
      await human.query('BEGIN');
      await human.query(`UPDATE project SET coordinator_enabled = false, config_revision = config_revision + 1 WHERE id = 'p1'`);
      await human.query('COMMIT');
    };
    /** §6.3 step 8a: take LO1's first level, then re-read, then decide. */
    const coordinatorCommit = async (): Promise<string | null> => {
      await loop.query('BEGIN');
      if (gated) {
        const row = await loop.query<{ coordinator_enabled: boolean; automation_policy: string }>(
          `SELECT coordinator_enabled, automation_policy FROM project WHERE id = 'p1' FOR NO KEY UPDATE`);
        const allowed = row.rows[0].coordinator_enabled && row.rows[0].automation_policy !== 'MANUAL';
        if (!allowed) { await loop.query('ROLLBACK'); return 'AUTHORITY_REVOKED'; }
      }
      await loop.query(`INSERT INTO session (id, task_id, status) VALUES ('auto-1', 'A', 'PENDING')`);
      await loop.query('COMMIT');
      return null;
    };

    let refusalCode: string | null;
    if (order === 'HUMAN_FIRST') {
      await humanRevoke();
      refusalCode = await coordinatorCommit();
    } else {
      // The coordinator takes the lock first and holds it; the human write must wait for it.
      await loop.query('BEGIN');
      if (gated) await loop.query(`SELECT coordinator_enabled FROM project WHERE id = 'p1' FOR NO KEY UPDATE`);
      const waiting = watch(humanRevoke());
      await settle();
      blocked = gated && !waiting.settled();
      await loop.query(`INSERT INTO session (id, task_id, status) VALUES ('auto-1', 'A', 'PENDING')`);
      await loop.query('COMMIT');
      await waiting.promise;
      refusalCode = null;
    }

    const claims = Number((await setup.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id = s.task_id
        WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
    const enabled = (await setup.query<{ coordinator_enabled: boolean }>(
      `SELECT coordinator_enabled FROM project WHERE id = 'p1'`)).rows[0].coordinator_enabled;
    return { dispatched: refusalCode === null, refusalCode, blocked, claims, coordinatorEnabled: enabled };
  } finally {
    await Promise.all([setup.end(), human.end(), loop.end()]);
  }
}

/** Two entry points racing for the last slot, both taking the same row lock (CAP1). */
async function capRacePg(gated: boolean): Promise<{ inserted: string[]; refusals: string[]; blocked: boolean }> {
  const [setup, manual, loop] = await Promise.all([connect(), connect(), connect()]);
  try {
    await setup.query(GATE_SCHEMA);
    for (const c of [manual, loop]) await c.query(`SET search_path TO ${V14_SCHEMA}`);
    const inserted: string[] = [];
    const refusals: string[] = [];

    const claim = async (c: Client, who: string, task: string): Promise<void> => {
      await c.query('BEGIN');
      if (gated) {
        const max = (await c.query<{ max_concurrent_tasks: number }>(
          `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
        const n = Number((await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id = s.task_id
            WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
        if (n >= max) { await c.query('ROLLBACK'); refusals.push(who); return; }
      }
      await c.query(`INSERT INTO session (id, task_id, status) VALUES ($1, $2, 'PENDING')`, [who, task]);
      await c.query('COMMIT');
      inserted.push(who);
    };

    // The human takes the lock and holds it; the coordinator must queue behind the same row.
    await manual.query('BEGIN');
    let blocked = false;
    if (gated) {
      await manual.query(`SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`);
      const queued = watch(claim(loop, 'auto', 'A'));
      await settle();
      blocked = !queued.settled();
      await manual.query(`INSERT INTO session (id, task_id, status) VALUES ('manual', 'B', 'PENDING')`);
      await manual.query('COMMIT');
      inserted.push('manual');
      await queued.promise;
    } else {
      await manual.query(`INSERT INTO session (id, task_id, status) VALUES ('manual', 'B', 'PENDING')`);
      await manual.query('COMMIT');
      inserted.push('manual');
      await claim(loop, 'auto', 'A');
    }
    return { inserted, refusals, blocked };
  } finally {
    await Promise.all([setup.end(), manual.end(), loop.end()]);
  }
}

test('PC-CX-26 on real Postgres: policy revocation and the project cap are one gate', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // AU1-a says exactly two outcomes exist. This runs both orders against a real server, and the
  // "blocked" flag is how the shared lock is observed rather than assumed.
  const humanFirst = await gateRacePg('HUMAN_FIRST', true);
  assert.equal(humanFirst.dispatched, false, 'the human write wins and the stale AUTO decision is refused');
  assert.equal(humanFirst.refusalCode, 'AUTHORITY_REVOKED', 'and the refusal is recorded, not silent');
  assert.equal(humanFirst.claims, 0, 'no session is created after automation was revoked');

  const loopFirst = await gateRacePg('COORDINATOR_FIRST', true);
  assert.equal(loopFirst.blocked, true, 'the human write must wait on the same project row the dispatch locked');
  assert.equal(loopFirst.dispatched, true, 'a dispatch committed while it was still authorised is legal');
  assert.equal(loopFirst.claims, 1);
  assert.equal(loopFirst.coordinatorEnabled, false, 'and the human write then takes effect');

  // Negative control: without the gate, the token alone lets the revoked decision through.
  const ungated = await gateRacePg('HUMAN_FIRST', false);
  assert.equal(ungated.dispatched, true, 'PC-CX-26 A must reproduce on a real server');
  assert.equal(ungated.coordinatorEnabled, false);
  assert.equal(ungated.claims, 1, 'automation off, and a session automation created after it was off');

  // CAP1: two entry points, one slot. D5 is per task, so only the shared row lock can bound this.
  const capped = await capRacePg(true);
  assert.equal(capped.blocked, true, 'both entry points queue on the same project row');
  assert.deepEqual(capped.inserted, ['manual', 'auto'].slice(0, 1), 'exactly one claim is created');
  assert.deepEqual(capped.refusals, ['auto'], 'the loser is refused, and it is the automatic one');

  const uncapped = await capRacePg(false);
  assert.deepEqual(uncapped.inserted.sort(), ['auto', 'manual'], 'PC-CX-26 B must reproduce: the per-task index cannot bound a project');
  assert.deepEqual(uncapped.refusals, []);
});
