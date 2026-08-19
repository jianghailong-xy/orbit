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

// ─────────────────────────────────────────────────────────────────────────────
// v1.5 · `PC-CX-28..31` — the three claims that are about the server, not about the contract's
// own rules.
//
//   - `PC-CX-28`: a shared row lock linearises the two writes, but it cannot make a *later* legal
//     cap decrease retroactively forbid an *earlier* legal admission. That is a statement about
//     what a row lock does and does not buy, so it runs against a real server.
//   - `PC-CX-29`: `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` that `UPDATE agent SET
//     enabled = false` takes, and `FOR KEY SHARE` does not. A model asserting that is asserting
//     that its author read the lock-conflict table correctly.
//   - `PC-CX-31`: the pending request is a row behind a partial unique index, and "it survives a
//     restart" means "re-reading the same rows gives the same answer" — again a database claim.
// ─────────────────────────────────────────────────────────────────────────────

const V15_SCHEMA = 'pcc_v15';

function isolated15(body: string): string {
  return `
    DROP SCHEMA IF EXISTS ${V15_SCHEMA} CASCADE;
    CREATE SCHEMA ${V15_SCHEMA};
    SET search_path TO ${V15_SCHEMA};
    ${body}
  `;
}

/**
 * §9.6 CAP0/CAP1 — admission, and the audit that makes I16-A checkable after the fact. `admitted_*`
 * is what CAP0-c requires the inserting transaction to record: the pair `(count, max)` it read
 * under the shared row lock. Without it the invariant would need a reconstruction of history.
 */
const CAP_SCHEMA_V15 = isolated15(`
  CREATE TABLE project (id text PRIMARY KEY, max_concurrent_tasks int NOT NULL, config_revision bigint NOT NULL DEFAULT 0);
  CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id));
  CREATE TABLE session (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES task(id),
    status text NOT NULL,
    deleted_at timestamptz,
    admitted_in_flight int NOT NULL,
    admitted_max int NOT NULL
  );
  CREATE UNIQUE INDEX session_task_execution_claim_idx ON session (task_id)
    WHERE deleted_at IS NULL AND status IN ('PENDING','RUNNING');
  CREATE TABLE cap_write (id bigserial PRIMARY KEY, old_max int NOT NULL, new_max int NOT NULL, in_flight_at_write int NOT NULL);
  INSERT INTO project VALUES ('p1', 2, 7);
  INSERT INTO task VALUES ('A', 'p1'), ('B', 'p1'), ('C', 'p1');
  INSERT INTO session VALUES ('pre-existing', 'A', 'RUNNING', NULL, 0, 2);
`);

/** CAP0-a, as an entry point would write it: one row lock, one count, one decision. */
async function admitPg(c: Client, id: string, task: string): Promise<boolean> {
  await c.query('BEGIN');
  const max = (await c.query<{ max_concurrent_tasks: number }>(
    `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
  const inFlight = Number((await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id = s.task_id
      WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
  if (inFlight >= max) { await c.query('ROLLBACK'); return false; }
  await c.query(
    `INSERT INTO session (id, task_id, status, admitted_in_flight, admitted_max) VALUES ($1, $2, 'PENDING', $3, $4)`,
    [id, task, inFlight, max]);
  await c.query('COMMIT');
  return true;
}

/** CAP0-b: the human write is never refused, and it records what it saw (CAP4.2). */
async function lowerCapPg(c: Client, newMax: number): Promise<void> {
  await c.query('BEGIN');
  const max = (await c.query<{ max_concurrent_tasks: number }>(
    `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
  const inFlight = Number((await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id = s.task_id
      WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
  await c.query(`INSERT INTO cap_write (old_max, new_max, in_flight_at_write) VALUES ($1, $2, $3)`, [max, newMax, inFlight]);
  await c.query(`UPDATE project SET max_concurrent_tasks = $1, config_revision = config_revision + 1 WHERE id = 'p1'`, [newMax]);
  await c.query('COMMIT');
}

/** I16-A on the committed state: no claim was admitted while it was already at the cap. */
async function admissionInvariantPg(c: Client): Promise<{ violations: number; overCapBy: number; claims: number; max: number }> {
  const row = (await c.query<{ violations: string; over_cap_by: string; claims: string; max: number }>(`
    SELECT
      (SELECT count(*)::text FROM session WHERE admitted_in_flight >= admitted_max) AS violations,
      GREATEST(0, (SELECT count(*) FROM session s JOIN task t ON t.id = s.task_id
                    WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING'))
                  - (SELECT max_concurrent_tasks FROM project WHERE id = 'p1'))::text AS over_cap_by,
      (SELECT count(*)::text FROM session s JOIN task t ON t.id = s.task_id
        WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING')) AS claims,
      (SELECT max_concurrent_tasks FROM project WHERE id = 'p1') AS max
  `)).rows[0];
  return { violations: Number(row.violations), overCapBy: Number(row.over_cap_by), claims: Number(row.claims), max: row.max };
}

test('PC-CX-28 on real Postgres: lowering the cap never breaks the admission invariant',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    for (const order of ['USER_FIRST', 'COORDINATOR_FIRST'] as const) {
      const [setup, human, loop] = await Promise.all([connect(), connect(), connect()]);
      try {
        await setup.query(CAP_SCHEMA_V15);
        for (const c of [human, loop]) await c.query(`SET search_path TO ${V15_SCHEMA}`);

        let admitted: boolean;
        if (order === 'USER_FIRST') {
          await lowerCapPg(human, 1);
          admitted = await admitPg(loop, 'coordinator', 'B');
        } else {
          // The coordinator takes the same row lock and holds it; the human write queues behind it.
          await loop.query('BEGIN');
          const max = (await loop.query<{ max_concurrent_tasks: number }>(
            `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
          const inFlight = Number((await loop.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id = s.task_id
              WHERE t.project_id = 'p1' AND s.deleted_at IS NULL AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
          const queued = watch(lowerCapPg(human, 1));
          await settle();
          assert.equal(queued.settled(), false, 'the cap write must wait on the same project row the admission locked');
          assert.ok(inFlight < max);
          await loop.query(
            `INSERT INTO session (id, task_id, status, admitted_in_flight, admitted_max) VALUES ('coordinator','B','PENDING',$1,$2)`,
            [inFlight, max]);
          await loop.query('COMMIT');
          await queued.promise;
          admitted = true;
        }

        const state = await admissionInvariantPg(setup);
        assert.equal(state.violations, 0, `${order}: I16-A must hold on the committed state`);
        assert.equal(state.max, 1, `${order}: the human cap write is never refused (CAP0-b)`);
        const writes = (await setup.query<{ old_max: number; new_max: number; in_flight_at_write: number }>(
          `SELECT old_max, new_max, in_flight_at_write FROM cap_write ORDER BY id`)).rows;
        assert.equal(writes.length, 1, `${order}: exactly one cap write, and it committed`);

        if (order === 'USER_FIRST') {
          assert.equal(admitted, false, 'USER_FIRST: the cap is already 1, so the dispatch is refused admission');
          assert.equal(state.claims, 1);
          assert.equal(state.overCapBy, 0);
          assert.deepEqual(writes[0], { old_max: 2, new_max: 1, in_flight_at_write: 1 });
        } else {
          assert.equal(admitted, true, 'COORDINATOR_FIRST: admitted while count < max, which is legal');
          assert.equal(state.claims, 2);
          assert.equal(state.overCapBy, 1, 'and the result is a visible over-cap state, not a violated invariant');
          assert.deepEqual(writes[0], { old_max: 2, new_max: 1, in_flight_at_write: 2 }, 'CAP4.2: the write records what it saw');
          // v1.4's sentence, on this committed state. It is the state the review published.
          assert.ok(state.claims > state.max, 'PC-CX-28 must reproduce: "committed claims <= max" is false here');

          // CAP4.1 — bounded and self-draining. Nothing is admitted while over cap; when enough
          // in-flight work ends that `count < max`, admission resumes with no human action.
          assert.equal(await admitPg(loop, 'while-over-cap', 'C'), false, 'no entry point is admitted while over cap');
          await setup.query(`UPDATE session SET status = 'SUCCEEDED' WHERE id = 'pre-existing'`);
          assert.equal((await admissionInvariantPg(setup)).overCapBy, 0, 'over cap converges as sessions end');
          assert.equal(await admitPg(loop, 'still-at-cap', 'C'), false, 'at the cap is still not below it');
          await setup.query(`UPDATE session SET status = 'SUCCEEDED' WHERE id = 'coordinator'`);
          assert.equal(await admitPg(loop, 'after-drain', 'C'), true, 'and admission resumes as soon as count < max');
          assert.equal((await admissionInvariantPg(setup)).violations, 0, 'I16-A held through the whole sequence');
        }
      } finally {
        await Promise.all([setup.end(), human.end(), loop.end()]);
      }
    }
  });

/**
 * §7.4 EC1 + §7.7 D14 — the eight rows, and the deferred guard that re-reads them at COMMIT.
 * `resolve_execution_context_locked` is D14-a: it takes `FOR SHARE` on every row it reads, so a
 * concurrent revocation must queue behind it rather than slip past an MVCC snapshot.
 */
const EC_SCHEMA_V15 = isolated15(`
  CREATE TABLE project (id text PRIMARY KEY, coordinator_workspace_id text NOT NULL);
  CREATE TABLE agent (id text PRIMARY KEY, enabled boolean NOT NULL, deleted_at timestamptz);
  CREATE TABLE project_member (project_id text NOT NULL REFERENCES project(id), agent_id text NOT NULL REFERENCES agent(id), PRIMARY KEY (project_id, agent_id));
  CREATE TABLE provider (slug text PRIMARY KEY, available boolean NOT NULL);
  CREATE TABLE workspace (id text PRIMARY KEY, deleted_at timestamptz, runner_id text NOT NULL);
  CREATE TABLE runner (id text PRIMARY KEY, online boolean NOT NULL);
  CREATE TABLE task (
    id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id),
    assignee_agent_id text NOT NULL REFERENCES agent(id), provider text NOT NULL, model text NOT NULL,
    workspace_id text NOT NULL REFERENCES workspace(id)
  );
  CREATE TABLE project_action (
    id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id),
    type text NOT NULL, status text NOT NULL, execution_context text[], execution_context_digest text
  );
  CREATE TABLE session (
    id text PRIMARY KEY, task_id text NOT NULL REFERENCES task(id), status text NOT NULL,
    dispatch_origin text NOT NULL, project_action_id text REFERENCES project_action(id), agent_id text REFERENCES agent(id),
    -- PAC §6's execution snapshot: written at create, read-only afterwards. §4.3 I17-A is a query
    -- over these columns and the action row, which is why both sides have to be here.
    provider text, model text, workspace_id text, assigned_runner_id text
  );

  -- D14-a. Reads exactly EC1's eight inputs, all FOR SHARE, in §8.6 LO1's order, and returns the
  -- resolved context (EC2's nine components, in EC1 row order), its digest, and — when the chain
  -- cannot resolve at all — the input that stopped it.
  -- D14-f: a function that takes FOR SHARE must be VOLATILE. v1.5's fixture left the marker out
  -- and PostgreSQL defaulted it to VOLATILE, so the suite was green against an object the contract
  -- did not specify; the contract said STABLE, and that object raises 0A000 on every call.
  CREATE FUNCTION resolve_execution_context_locked(p_task text, p_agent text)
    RETURNS TABLE (digest text, ctx text[], revoked_input text) AS $fn$
  DECLARE t record; a record; m record; pv record; w record; r record; p record; c text[];
  BEGIN
    SELECT * INTO p FROM project WHERE id = (SELECT project_id FROM task WHERE id = p_task) FOR SHARE;
    SELECT * INTO m FROM project_member WHERE project_id = p.id AND agent_id = p_agent FOR SHARE;
    SELECT * INTO a FROM agent WHERE id = p_agent FOR SHARE;
    SELECT * INTO t FROM task WHERE id = p_task FOR SHARE;
    SELECT * INTO w FROM workspace WHERE id = t.workspace_id FOR SHARE;
    SELECT * INTO r FROM runner WHERE id = w.runner_id FOR SHARE;
    SELECT * INTO pv FROM provider WHERE slug = t.provider FOR SHARE;

    IF a.id IS NULL OR NOT a.enabled OR a.deleted_at IS NOT NULL THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'AGENT'; RETURN; END IF;
    IF m.agent_id IS NULL THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'MEMBERSHIP'; RETURN; END IF;
    IF t.assignee_agent_id <> p_agent THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'TASK'; RETURN; END IF;
    IF pv.slug IS NULL OR NOT pv.available THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'PROVIDER'; RETURN; END IF;
    IF t.model IS NULL THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'MODEL'; RETURN; END IF;
    IF w.deleted_at IS NOT NULL THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'WORKSPACE'; RETURN; END IF;
    IF NOT r.online THEN RETURN QUERY SELECT NULL::text, NULL::text[], 'RUNNER'; RETURN; END IF;

    c := ARRAY[p_agent, m.agent_id, t.id, t.assignee_agent_id, pv.slug, t.model, w.id, r.id, p.coordinator_workspace_id];
    RETURN QUERY SELECT md5(array_to_string(c, '|')), c, NULL::text;
  END;
  $fn$ LANGUAGE plpgsql VOLATILE;

  CREATE FUNCTION session_execution_context_guard() RETURNS trigger AS $fn$
  DECLARE frozen text; frozen_ctx text[]; observed text; observed_ctx text[]; revoked text;
          -- EC1's row number per EC2 component, so "first difference" is "smallest EC1 row" (EC4).
          labels text[] := ARRAY['AGENT','MEMBERSHIP','TASK','TASK','PROVIDER','MODEL','WORKSPACE','RUNNER','COORDINATOR_WORKSPACE'];
          i int;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT a.execution_context_digest, a.execution_context INTO frozen, frozen_ctx
      FROM project_action a WHERE a.id = NEW.project_action_id;
    SELECT ec.digest, ec.ctx, ec.revoked_input INTO observed, observed_ctx, revoked
      FROM resolve_execution_context_locked(NEW.task_id, NEW.agent_id) ec;
    IF observed IS DISTINCT FROM frozen THEN
      IF revoked IS NULL AND observed_ctx IS NOT NULL AND frozen_ctx IS NOT NULL THEN
        FOR i IN 1 .. array_length(labels, 1) LOOP
          IF observed_ctx[i] IS DISTINCT FROM frozen_ctx[i] THEN revoked := labels[i]; EXIT; END IF;
        END LOOP;
      END IF;
      RAISE EXCEPTION 'EXECUTION_CONTEXT_REVOKED: %', COALESCE(revoked, 'UNKNOWN');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql VOLATILE;

  CREATE CONSTRAINT TRIGGER session_execution_context_guard
    AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id, agent_id ON session
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION session_execution_context_guard();

  INSERT INTO project VALUES ('p1', 'w-coord');
  INSERT INTO agent VALUES ('a1', true, NULL), ('a2', true, NULL);
  INSERT INTO project_member VALUES ('p1', 'a1');
  INSERT INTO provider VALUES ('claude', true);
  INSERT INTO runner VALUES ('r1', true);
  INSERT INTO workspace VALUES ('w1', NULL, 'r1'), ('w-coord', NULL, 'r1');
  INSERT INTO task VALUES ('t1', 'p1', 'a1', 'claude', 'claude-opus-5', 'w1');
`);

/** The eight revocations of EC1, as the single statement a human entry point would run. */
const EC_REVOCATIONS: { input: string; sql: string }[] = [
  { input: 'AGENT', sql: `UPDATE agent SET enabled = false WHERE id = 'a1'` },
  { input: 'MEMBERSHIP', sql: `DELETE FROM project_member WHERE project_id = 'p1' AND agent_id = 'a1'` },
  { input: 'TASK', sql: `UPDATE task SET assignee_agent_id = 'a2' WHERE id = 't1'` },
  { input: 'PROVIDER', sql: `UPDATE provider SET available = false WHERE slug = 'claude'` },
  { input: 'MODEL', sql: `UPDATE task SET model = 'claude-sonnet-5' WHERE id = 't1'` },
  { input: 'WORKSPACE', sql: `UPDATE workspace SET deleted_at = now() WHERE id = 'w1'` },
  { input: 'RUNNER', sql: `UPDATE runner SET online = false WHERE id = 'r1'` },
  { input: 'COORDINATOR_WORKSPACE', sql: `UPDATE project SET coordinator_workspace_id = 'w1' WHERE id = 'p1'` },
];

test('PC-CX-29 on real Postgres: the deferred guard refuses a revoked execution context',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const [setup, human, loop] = await Promise.all([connect(), connect(), connect()]);
    try {
      await setup.query(EC_SCHEMA_V15);
      for (const c of [human, loop]) await c.query(`SET search_path TO ${V15_SCHEMA}`);
      const resolved = (await setup.query<{ digest: string; ctx: string[] }>(
        `SELECT digest, ctx FROM resolve_execution_context_locked('t1', 'a1')`)).rows[0];
      const { digest: frozen, ctx: frozenCtx } = resolved;
      assert.ok(frozen, 'the fixture must resolve before anything is revoked');

      const reset = async (): Promise<void> => {
        await setup.query(`DELETE FROM session; DELETE FROM project_action`);
        await setup.query(`UPDATE agent SET enabled = true, deleted_at = NULL`);
        await setup.query(`INSERT INTO project_member VALUES ('p1','a1') ON CONFLICT DO NOTHING`);
        await setup.query(`UPDATE provider SET available = true`);
        await setup.query(`UPDATE runner SET online = true`);
        await setup.query(`UPDATE workspace SET deleted_at = NULL`);
        await setup.query(`UPDATE task SET assignee_agent_id = 'a1', model = 'claude-opus-5', provider = 'claude'`);
        await setup.query(`UPDATE project SET coordinator_workspace_id = 'w-coord'`);
        await setup.query(`INSERT INTO project_action VALUES ('act-1','p1','DISPATCH_TASK','APPLIED',$1,$2)`, [frozenCtx, frozen]);
      };

      // USER_FIRST: the revocation commits first, and the coordinator's insert is refused at COMMIT
      // — by the database, so it holds for any binary. `revokedInput` names the EC1 row.
      for (const { input, sql } of EC_REVOCATIONS) {
        await reset();
        await human.query(sql);
        let refusal: string | null = null;
        await loop.query('BEGIN');
        await loop.query(`INSERT INTO session VALUES ('stale','t1','PENDING','COORDINATOR','act-1','a1')`);
        try { await loop.query('COMMIT'); } catch (e) {
          refusal = /EXECUTION_CONTEXT_REVOKED: [A-Z_]+/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`;
          await loop.query('ROLLBACK');
        }
        assert.equal(refusal, `EXECUTION_CONTEXT_REVOKED: ${input}`, `${input}/USER_FIRST: the guard must refuse, and name the input`);
        const n = Number((await setup.query<{ n: string }>(`SELECT count(*)::text AS n FROM session`)).rows[0].n);
        assert.equal(n, 0, `${input}/USER_FIRST: no session may exist after a revoked context`);
      }

      // COORDINATOR_FIRST: §7.4 EC3 is what makes this order reachable. A DEFERRABLE INITIALLY
      // DEFERRED trigger takes its locks at COMMIT, not at INSERT — so D14 alone would let a
      // revocation slip in between the two and then refuse. EC3 has the service take the same
      // FOR SHARE *before* inserting, inside the same transaction, and from that point the
      // revocation has to queue. That is the division of labour between EC3 and D14, observed.
      await reset();
      await loop.query('BEGIN');
      const atCommit = (await loop.query<{ digest: string }>(
        `SELECT digest FROM resolve_execution_context_locked('t1', 'a1')`)).rows[0].digest;
      assert.equal(atCommit, frozen, 'EC3: the re-resolution matches the frozen digest, so the dispatch is still authorised');
      const queued = watch(human.query(`UPDATE agent SET enabled = false WHERE id = 'a1'`));
      await settle();
      assert.equal(queued.settled(), false, 'the revocation must queue behind the FOR SHARE EC3 took');
      await loop.query(`INSERT INTO session VALUES ('legal','t1','PENDING','COORDINATOR','act-1','a1')`);
      await loop.query('COMMIT');
      await queued.promise;
      assert.equal(Number((await setup.query<{ n: string }>(`SELECT count(*)::text AS n FROM session`)).rows[0].n), 1,
        'COORDINATOR_FIRST: a dispatch committed while still authorised is legal');
      assert.equal((await setup.query<{ enabled: boolean }>(`SELECT enabled FROM agent WHERE id = 'a1'`)).rows[0].enabled, false,
        'and the human write then takes effect');

      // The version-independent half: an old binary that skips EC3 entirely still cannot commit a
      // revoked context, because the deferred guard re-reads at COMMIT. Here the revocation lands
      // *after* the insert and *before* the commit — the window EC3 closes and D14 backstops.
      await reset();
      await loop.query('BEGIN');
      await loop.query(`INSERT INTO session VALUES ('stale','t1','PENDING','COORDINATOR','act-1','a1')`);
      await human.query(`UPDATE agent SET enabled = false WHERE id = 'a1'`);
      let lateRefusal: string | null = null;
      try { await loop.query('COMMIT'); } catch (e) {
        lateRefusal = /EXECUTION_CONTEXT_REVOKED: [A-Z_]+/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`;
        await loop.query('ROLLBACK');
      }
      assert.equal(lateRefusal, 'EXECUTION_CONTEXT_REVOKED: AGENT', 'D14 must catch a revocation that lands after the insert');
      assert.equal(Number((await setup.query<{ n: string }>(`SELECT count(*)::text AS n FROM session`)).rows[0].n), 0);

      // Negative control: drop the guard (leaving §9.6 AU1's four project fields as the only gate)
      // and the published counterexample commits — "agent disabled + a session resolved to it".
      await reset();
      await setup.query(`DROP TRIGGER session_execution_context_guard ON session`);
      await human.query(`UPDATE agent SET enabled = false WHERE id = 'a1'`);
      await loop.query(`INSERT INTO session VALUES ('stale','t1','PENDING','COORDINATOR','act-1','a1')`);
      const bad = (await setup.query<{ enabled: boolean; sessions: string }>(`
        SELECT a.enabled, count(s.id)::text AS sessions FROM agent a LEFT JOIN session s ON s.agent_id = a.id
         WHERE a.id = 'a1' GROUP BY a.enabled`)).rows[0];
      assert.equal(bad.enabled, false);
      assert.equal(Number(bad.sessions), 1, 'PC-CX-29 must reproduce on a real server without D14');
    } finally {
      await Promise.all([setup.end(), human.end(), loop.end()]);
    }
  });

/**
 * §7.6 TR2-a–TR2-e — the pending request is a `project_event` row behind §5.4's partial unique
 * index, and the window anchor is a `project_action` row. Both claims ("it survives a restart",
 * "a redelivery collapses onto one row") are about the database.
 */
const RATE_LIMIT_SCHEMA_V15 = isolated15(`
  CREATE TABLE project_runtime (project_id text PRIMARY KEY, next_wake_at bigint, next_wake_reason text);
  CREATE TABLE project_action (
    idempotency_key text PRIMARY KEY, project_id text NOT NULL, type text NOT NULL,
    status text NOT NULL, reason_code text, generation bigint NOT NULL, created_at bigint NOT NULL
  );
  CREATE TABLE project_event (
    id bigserial PRIMARY KEY, project_id text NOT NULL, kind text NOT NULL, dedupe_key text NOT NULL,
    occurrences int NOT NULL DEFAULT 1, consumed_at bigint, next_attempt_at bigint
  );
  CREATE UNIQUE INDEX project_event_open_dedupe_idx ON project_event (project_id, dedupe_key) WHERE consumed_at IS NULL;
  INSERT INTO project_runtime VALUES ('p1', NULL, NULL);
`);

test('PC-CX-31 on real Postgres: a rate-limited manual trigger survives, and fires once',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    const WINDOW = 60_000;
    try {
      await c.query(RATE_LIMIT_SCHEMA_V15);
      const raise = async (dedupeKey: string): Promise<void> => {
        await c.query(
          `INSERT INTO project_event (project_id, kind, dedupe_key) VALUES ('p1','user.manual_trigger',$1)
             ON CONFLICT (project_id, dedupe_key) WHERE consumed_at IS NULL
             DO UPDATE SET occurrences = project_event.occurrences + 1`, [dedupeKey]);
      };
      const pending = async (): Promise<{ dedupe_key: string; next_attempt_at: string | null }[]> =>
        (await c.query<{ dedupe_key: string; next_attempt_at: string | null }>(
          `SELECT dedupe_key, next_attempt_at::text FROM project_event
            WHERE consumed_at IS NULL AND kind = 'user.manual_trigger' ORDER BY dedupe_key`)).rows;

      /** One reconcile, at `now`. TR2-a reads the anchor from the ledger, never from memory. */
      const reconcile = async (now: number): Promise<'TURN' | 'RATE_LIMITED' | 'IDLE'> => {
        const requests = await pending();
        if (requests.length === 0) return 'IDLE';
        const anchor = (await c.query<{ idempotency_key: string; created_at: string }>(
          `SELECT idempotency_key, created_at::text FROM project_action
            WHERE project_id='p1' AND type='OPEN_COORDINATOR_TURN' AND status='APPLIED' AND reason_code='MANUAL' AND generation=0
            ORDER BY created_at DESC LIMIT 1`)).rows[0];
        const windowEndsAt = anchor ? Number(anchor.created_at) + WINDOW : -1;
        if (now < windowEndsAt) {
          await c.query(`UPDATE project_event SET next_attempt_at = $1 WHERE consumed_at IS NULL AND kind='user.manual_trigger'`, [windowEndsAt]);
          await c.query(`UPDATE project_runtime SET next_wake_at = $1, next_wake_reason = 'manual trigger rate-limited' WHERE project_id='p1'`, [windowEndsAt]);
          return 'RATE_LIMITED';
        }
        // TF5: one digest over the whole pending set, so N requests collapse onto one turn.
        const digest = requests.map((r) => r.dedupe_key).sort().join(',');
        await c.query(
          `INSERT INTO project_action VALUES ($1,'p1','OPEN_COORDINATOR_TURN','APPLIED','MANUAL',0,$2)`,
          [`pc:v1:p1:turn:0:${digest}`, now]);
        await c.query(`UPDATE project_event SET consumed_at = $1, next_attempt_at = NULL WHERE consumed_at IS NULL AND kind='user.manual_trigger'`, [now]);
        await c.query(`UPDATE project_runtime SET next_wake_at = $1, next_wake_reason = 'turn in flight' WHERE project_id='p1'`, [now + WINDOW]);
        return 'TURN';
      };

      await raise('manual:1');
      assert.equal(await reconcile(0), 'TURN', 'the first request opens a turn');

      await raise('manual:2');
      assert.equal(await reconcile(10_000), 'RATE_LIMITED', 'a second request inside the window is refused a turn');
      assert.deepEqual(await pending(), [{ dedupe_key: 'manual:2', next_attempt_at: '60000' }],
        'TR2-b/c: the request stays, and its retry time is the window boundary');
      const runtime = (await c.query<{ next_wake_at: string; next_wake_reason: string }>(
        `SELECT next_wake_at::text, next_wake_reason FROM project_runtime WHERE project_id='p1'`)).rows[0];
      assert.deepEqual(runtime, { next_wake_at: '60000', next_wake_reason: 'manual trigger rate-limited' },
        '§10.4 item 7: the wake points at the same boundary and says why');

      // Redelivery: §5.4's partial unique index collapses it onto the same row, so `occurrences`
      // moves and nothing else does — TF5's digest, and therefore the turn key, is unchanged (I14).
      await raise('manual:2');
      await raise('manual:2');
      const dup = (await c.query<{ n: string; occ: number }>(
        `SELECT count(*)::text AS n, max(occurrences) AS occ FROM project_event WHERE consumed_at IS NULL`)).rows[0];
      assert.deepEqual({ n: Number(dup.n), occ: dup.occ }, { n: 1, occ: 3 }, 'redelivery is one row with a counter, not three requests');

      // A third distinct request inside the same window joins the pending set — it does not queue
      // a third turn.
      await raise('manual:3');
      assert.equal(await reconcile(30_000), 'RATE_LIMITED');
      assert.equal((await pending()).length, 2);

      // "Survives a restart" is literally "re-read the same rows": nothing above lives in memory.
      const fresh = await connect();
      try {
        await fresh.query(`SET search_path TO ${V15_SCHEMA}`);
        const anchor = (await fresh.query<{ created_at: string }>(
          `SELECT created_at::text FROM project_action WHERE reason_code='MANUAL' ORDER BY created_at DESC LIMIT 1`)).rows[0];
        assert.equal(Number(anchor.created_at) + WINDOW, 60_000, 'the window anchor is a committed row, not process state');
      } finally { await fresh.end(); }

      // The boundary: exactly one turn, answering and consuming the whole pending set.
      assert.equal(await reconcile(60_000), 'TURN');
      assert.deepEqual(await pending(), [], 'TR2-c: answered, therefore consumed');
      const turns = (await c.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM project_action WHERE type='OPEN_COORDINATOR_TURN' ORDER BY created_at`)).rows;
      assert.deepEqual(turns.map((t) => t.idempotency_key), ['pc:v1:p1:turn:0:manual:1', 'pc:v1:p1:turn:0:manual:2,manual:3'],
        'two turns in total: one per window, the second answering both pending requests');

      // Negative control — v1.4 reading A: consume the rate-limited request. It is gone, and the
      // boundary passes without it ever running.
      await c.query(`DELETE FROM project_event; DELETE FROM project_action`);
      await raise('manual:1');
      await reconcile(0);
      await raise('manual:2');
      await c.query(`UPDATE project_event SET consumed_at = 10000 WHERE consumed_at IS NULL`); // "consume it anyway"
      assert.deepEqual(await pending(), [], 'PC-CX-31 reading A must reproduce: the request is gone');
      assert.equal(await reconcile(60_000), 'IDLE', 'and the boundary passes with nothing to run');
    } finally {
      await c.end();
    }
  });

/**
 * v1.6 — `PC-CX-32` and `PC-CX-34`, both about D14 and both only answerable by a server.
 *
 * `PC-CX-32` is the round's P0 and it is invisible in every check the contract had: the specified
 * resolver promised `STABLE` and took `FOR SHARE`, PostgreSQL accepts the `CREATE` and refuses
 * every *call*, and the function body — the thing §12.1 G5 greps — is byte-identical either way.
 * So this builds both objects, reads `pg_proc.provolatile`, and calls the real deferred trigger.
 *
 * `PC-CX-34` is the same barrier `PC-CX-29` runs, read on the committed state afterwards: I17-A
 * (snapshot columns = frozen context) has to hold in all sixteen cells, while v1.5's "equivalent
 * current-state query" legitimately returns rows once a human revokes after a legal dispatch.
 */
const EC_CONTEXT_SQL = `SELECT digest, ctx FROM resolve_execution_context_locked('t1','a1')`;

/** The columns PAC §6 freezes on the session, taken from EC2's component order (EC1 row order). */
const INSERT_PLACEHOLDER = `
  INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id, agent_id,
                       provider, model, workspace_id, assigned_runner_id)
  SELECT $1, 't1', 'PENDING', 'COORDINATOR', 'act-1',
         execution_context[1], execution_context[5], execution_context[6], execution_context[7], execution_context[8]
    FROM project_action WHERE id = 'act-1'`;

/** §4.3 I17-A, as the zero-row query §12.1 G5 has to run after the migration. */
const I17A_SQL = `
  SELECT count(*)::text AS n
    FROM session s
    LEFT JOIN project_action a ON a.id = s.project_action_id
   WHERE s.dispatch_origin = 'COORDINATOR' AND s.status IN ('PENDING','RUNNING')
     AND (a.id IS NULL OR a.status <> 'APPLIED'
          OR a.execution_context_digest IS DISTINCT FROM md5(array_to_string(a.execution_context, '|'))
          OR s.agent_id           IS DISTINCT FROM a.execution_context[1]
          OR s.provider           IS DISTINCT FROM a.execution_context[5]
          OR s.model              IS DISTINCT FROM a.execution_context[6]
          OR s.workspace_id       IS DISTINCT FROM a.execution_context[7]
          OR s.assigned_runner_id IS DISTINCT FROM a.execution_context[8])`;

/** v1.5's deleted "equivalent queryable form", verbatim enough to reproduce its `false|1|1`. */
const I17_V15_CURRENT_STATE_SQL = `
  SELECT count(*)::text AS n
    FROM session s
    JOIN task t ON t.id = s.task_id
    LEFT JOIN agent ag ON ag.id = s.agent_id
    LEFT JOIN project_member m ON m.project_id = 'p1' AND m.agent_id = s.agent_id
    LEFT JOIN provider pv ON pv.slug = s.provider
    LEFT JOIN workspace w ON w.id = s.workspace_id
    LEFT JOIN runner r ON r.id = s.assigned_runner_id
   WHERE s.dispatch_origin = 'COORDINATOR' AND s.status IN ('PENDING','RUNNING')
     AND (ag.id IS NULL OR NOT ag.enabled OR ag.deleted_at IS NOT NULL
          OR m.agent_id IS NULL
          OR t.assignee_agent_id IS DISTINCT FROM s.agent_id
          OR t.provider IS DISTINCT FROM s.provider
          OR t.model IS DISTINCT FROM s.model
          OR pv.slug IS NULL OR NOT pv.available
          OR w.deleted_at IS NOT NULL
          OR r.id IS NULL OR NOT r.online)`;

async function ecReset(c: Client, frozenCtx: string[], frozen: string): Promise<void> {
  await c.query(`DELETE FROM session; DELETE FROM project_action`);
  await c.query(`UPDATE agent SET enabled = true, deleted_at = NULL`);
  await c.query(`INSERT INTO project_member VALUES ('p1','a1') ON CONFLICT DO NOTHING`);
  await c.query(`UPDATE provider SET available = true`);
  await c.query(`UPDATE runner SET online = true`);
  await c.query(`UPDATE workspace SET deleted_at = NULL`);
  await c.query(`UPDATE task SET assignee_agent_id = 'a1', model = 'claude-opus-5', provider = 'claude'`);
  await c.query(`UPDATE project SET coordinator_workspace_id = 'w-coord'`);
  await c.query(`INSERT INTO project_action VALUES ('act-1','p1','DISPATCH_TASK','APPLIED',$1,$2)`, [frozenCtx, frozen]);
}

const countOf = async (c: Client, sql: string): Promise<number> =>
  Number((await c.query<{ n: string }>(sql)).rows[0].n);

test('PC-CX-32 on real Postgres: the D14 objects are VOLATILE, and the deferred trigger really runs',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const [setup, human, loop] = await Promise.all([connect(), connect(), connect()]);
    try {
      await setup.query(EC_SCHEMA_V15);
      for (const c of [human, loop]) await c.query(`SET search_path TO ${V15_SCHEMA}`);

      // 1. The metadata assertion. Both D14 functions take row locks, so both must be VOLATILE —
      //    and this column is the *only* place the difference shows.
      const volatility = (await setup.query<{ proname: string; provolatile: string }>(`
        SELECT proname, provolatile FROM pg_proc
         WHERE pronamespace = '${V15_SCHEMA}'::regnamespace
           AND proname IN ('resolve_execution_context_locked','session_execution_context_guard')
         ORDER BY proname`)).rows;
      assert.deepEqual(volatility, [
        { proname: 'resolve_execution_context_locked', provolatile: 'v' },
        { proname: 'session_execution_context_guard', provolatile: 'v' },
      ], 'D14-f: a function that takes FOR SHARE has to be VOLATILE, and the migration must assert it');

      // 2. The trigger is the deferred constraint trigger D14 specifies, not an immediate one.
      const trigger = (await setup.query<{ tgdeferrable: boolean; tginitdeferred: boolean; tgconstraint: string }>(`
        SELECT tgdeferrable, tginitdeferred, tgconstraint::text FROM pg_trigger
         WHERE tgname = 'session_execution_context_guard' AND NOT tgisinternal`)).rows[0];
      assert.deepEqual({ d: trigger.tgdeferrable, i: trigger.tginitdeferred }, { d: true, i: true },
        'an immediate trigger would read the action row before it is written');
      assert.notEqual(trigger.tgconstraint, '0', 'it has to be a constraint trigger to be deferrable at all');

      // 3. Calling it — which is the part `CREATE FUNCTION` succeeding does not prove. The function
      //    resolves, and the constraint trigger it feeds admits a legal placeholder at COMMIT.
      const resolved = (await setup.query<{ digest: string; ctx: string[] }>(EC_CONTEXT_SQL)).rows[0];
      assert.ok(resolved.digest, 'the specified resolver has to be callable, not merely creatable');
      await ecReset(setup, resolved.ctx, resolved.digest);
      await loop.query('BEGIN');
      await loop.query(INSERT_PLACEHOLDER, ['legal']);
      await loop.query('COMMIT');
      assert.equal(await countOf(setup, `SELECT count(*)::text AS n FROM session`), 1,
        'the deferred guard must let an authorised dispatch commit');

      // …and refuses a revoked one, through the same call path.
      await ecReset(setup, resolved.ctx, resolved.digest);
      await human.query(`UPDATE agent SET enabled = false WHERE id = 'a1'`);
      let refusal: string | null = null;
      await loop.query('BEGIN');
      await loop.query(INSERT_PLACEHOLDER, ['stale']);
      try { await loop.query('COMMIT'); } catch (e) {
        refusal = /EXECUTION_CONTEXT_REVOKED: [A-Z_]+/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`;
        await loop.query('ROLLBACK');
      }
      assert.equal(refusal, 'EXECUTION_CONTEXT_REVOKED: AGENT', 'the guard has to run at COMMIT, not merely exist');
      await human.query(`UPDATE agent SET enabled = true WHERE id = 'a1'`);

      // 4. The negative control: rebuild the resolver exactly as v1.5 specified it — `STABLE` — and
      //    the same body stops working. First directly, then through the trigger, which is the path
      //    that matters: every COORDINATOR dispatch would abort at COMMIT.
      await setup.query(`
        CREATE OR REPLACE FUNCTION resolve_execution_context_locked(p_task text, p_agent text)
          RETURNS TABLE (digest text, ctx text[], revoked_input text) AS $fn$
        DECLARE a record;
        BEGIN
          SELECT * INTO a FROM agent WHERE id = p_agent FOR SHARE;
          RETURN QUERY SELECT md5(p_agent), ARRAY[p_agent], NULL::text;
        END;
        $fn$ LANGUAGE plpgsql STABLE;
      `);
      assert.equal((await setup.query<{ provolatile: string }>(
        `SELECT provolatile FROM pg_proc WHERE proname = 'resolve_execution_context_locked'
           AND pronamespace = '${V15_SCHEMA}'::regnamespace`)).rows[0].provolatile, 's',
        'the negative control has to really be the volatility the contract used to specify');

      let direct: { code?: string; message: string } | null = null;
      try { await setup.query(EC_CONTEXT_SQL); } catch (e) {
        const err = e as Error & { code?: string };
        direct = { code: err.code, message: err.message };
      }
      assert.equal(direct?.code, '0A000', 'PC-CX-32 must reproduce: the specified object cannot take its locks');
      assert.match(direct!.message, /SELECT FOR SHARE is not allowed in a non-volatile function/);

      await ecReset(setup, resolved.ctx, resolved.digest);
      let viaTrigger: string | undefined;
      await loop.query('BEGIN');
      await loop.query(INSERT_PLACEHOLDER, ['blocked']);
      try { await loop.query('COMMIT'); } catch (e) {
        viaTrigger = (e as Error & { code?: string }).code;
        await loop.query('ROLLBACK');
      }
      assert.equal(viaTrigger, '0A000',
        'and it fails on the real path: every COORDINATOR dispatch aborts at COMMIT, with a code EC4 does not list');
      assert.equal(await countOf(setup, `SELECT count(*)::text AS n FROM session`), 0);
    } finally {
      await Promise.all([setup.end(), human.end(), loop.end()]);
    }
  });

test('PC-CX-34 on real Postgres: I17-A holds on the committed state while the v1.5 current-state query legitimately does not',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const [setup, human, loop] = await Promise.all([connect(), connect(), connect()]);
    try {
      await setup.query(EC_SCHEMA_V15);
      for (const c of [human, loop]) await c.query(`SET search_path TO ${V15_SCHEMA}`);
      const resolved = (await setup.query<{ digest: string; ctx: string[] }>(EC_CONTEXT_SQL)).rows[0];

      // Sixteen cells. USER_FIRST is PC-CX-29's half and is re-read here only for I17-A; the
      // interesting half is COORDINATOR_FIRST, where every step is legal and the state v1.5 called
      // impossible is the one the contract elsewhere requires.
      const visibleToV15: string[] = [];
      for (const { input, sql } of EC_REVOCATIONS) {
        await ecReset(setup, resolved.ctx, resolved.digest);
        await human.query(sql);
        await loop.query('BEGIN');
        await loop.query(INSERT_PLACEHOLDER, ['stale']);
        try { await loop.query('COMMIT'); } catch { await loop.query('ROLLBACK'); }
        assert.equal(await countOf(setup, I17A_SQL), 0, `${input}/USER_FIRST: I17-A holds — there is no placeholder at all`);
        assert.equal(await countOf(setup, `SELECT count(*)::text AS n FROM session`), 0);

        // COORDINATOR_FIRST: EC3 takes the shared locks before inserting, so the revocation queues
        // behind it and takes effect afterwards — AU1-a row 2, F35, and PAC §6 all require this.
        await ecReset(setup, resolved.ctx, resolved.digest);
        await loop.query('BEGIN');
        const atCommit = (await loop.query<{ digest: string }>(EC_CONTEXT_SQL)).rows[0].digest;
        assert.equal(atCommit, resolved.digest, `${input}/COORDINATOR_FIRST: I17-B is what is required, and it held`);
        await loop.query(INSERT_PLACEHOLDER, ['legal']);
        await loop.query('COMMIT');
        await human.query(sql);

        assert.equal(await countOf(setup, `SELECT count(*)::text AS n FROM session`), 1,
          `${input}/COORDINATOR_FIRST: the dispatch was authorised when it committed, so it stands`);
        assert.equal(await countOf(setup, I17A_SQL), 0,
          `${input}/COORDINATOR_FIRST: I17-A still holds — it reads only columns that stopped changing at commit`);
        if (await countOf(setup, I17_V15_CURRENT_STATE_SQL) > 0) visibleToV15.push(input);
      }

      // The published output, reproduced: `enabled = false | live = 1 | i17_current_violations = 1`.
      await ecReset(setup, resolved.ctx, resolved.digest);
      await loop.query('BEGIN');
      await loop.query(INSERT_PLACEHOLDER, ['legal']);
      await loop.query('COMMIT');
      await human.query(`UPDATE agent SET enabled = false WHERE id = 'a1'`);
      const published = (await setup.query<{ enabled: boolean; live: string; violations: string }>(`
        SELECT (SELECT enabled FROM agent WHERE id='a1') AS enabled,
               (SELECT count(*)::text FROM session WHERE status IN ('PENDING','RUNNING')) AS live,
               (${I17_V15_CURRENT_STATE_SQL}) AS violations`)).rows[0];
      assert.deepEqual([published.enabled, Number(published.live), Number(published.violations)], [false, 1, 1],
        'PC-CX-34 must reproduce on a real server: a legal order makes v1.5\'s current-state query non-zero');
      assert.equal(await countOf(setup, I17A_SQL), 0, 'while I17-A — the one G5 now runs — stays at zero rows');

      // Seven of EC1's eight inputs are visible to that query at all; the coordinator workspace is
      // not an input to a DISPATCH placeholder, which is a second hole in the same sentence.
      assert.deepEqual(visibleToV15, ['AGENT', 'MEMBERSHIP', 'TASK', 'PROVIDER', 'MODEL', 'WORKSPACE', 'RUNNER'],
        'every revocation a dispatch resolves must reproduce the non-zero current-state query');

      // I17-A can fail — it is a real assertion, not a tautology. Tamper with the frozen side (the
      // action row is pinned by D11 in production; here we do by hand what D11 forbids) and it goes
      // non-zero, which is what makes running it after a migration worth anything.
      await setup.query(`UPDATE project_action SET execution_context = array_replace(execution_context, 'claude', 'codex') WHERE id = 'act-1'`);
      assert.equal(await countOf(setup, I17A_SQL), 1, 'I17-A must catch a placeholder that disagrees with its own action row');
    } finally {
      await Promise.all([setup.end(), human.end(), loop.end()]);
    }
  });

/**
 * v1.6 — `PC-CX-35` and `PC-CX-36`: the wake, and the state of an event nobody has looked at yet.
 *
 * Neither is a concurrency claim, but both are claims about *queries* — "what does §10.4 compute
 * from these rows" and "what does the §10.2 W4 predicate return for this project" — and a query is
 * exactly the thing a model cannot check on its own behalf. Both fixtures are the real shapes:
 * `project_event` behind §5.4's partial unique index, the window anchor as a `project_action` row,
 * and the backstop predicate as the four-branch SQL §10.2 freezes.
 */
const WAKE_SCHEMA_V16 = isolated15(`
  CREATE TABLE project (id text PRIMARY KEY, status text NOT NULL DEFAULT 'OPEN', coordinator_enabled boolean NOT NULL DEFAULT true);
  CREATE TABLE project_runtime (project_id text PRIMARY KEY REFERENCES project(id), run_state text NOT NULL DEFAULT 'PLANNING',
                                next_wake_at timestamptz, next_wake_reason text);
  CREATE TABLE project_action (
    idempotency_key text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id), type text NOT NULL,
    status text NOT NULL, reason_code text, generation bigint NOT NULL, created_at timestamptz NOT NULL
  );
  CREATE TABLE project_event (
    id bigserial PRIMARY KEY, project_id text NOT NULL REFERENCES project(id), kind text NOT NULL, dedupe_key text NOT NULL,
    occurred_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0, consumed_at timestamptz, next_attempt_at timestamptz
  );
  CREATE UNIQUE INDEX project_event_open_dedupe_idx ON project_event (project_id, dedupe_key) WHERE consumed_at IS NULL;
  CREATE INDEX project_event_next_attempt_idx ON project_event (next_attempt_at) WHERE consumed_at IS NULL;
  CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id), run_at timestamptz);
  CREATE TABLE project_blocker (
    id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id), recovery text NOT NULL,
    resolved_at timestamptz, escalated_at timestamptz, next_check_at timestamptz
  );
  INSERT INTO project VALUES ('p1', 'OPEN', true);
  INSERT INTO project_runtime (project_id) VALUES ('p1');
`);

/**
 * §10.4 W5 as one query: build the candidate table, take the minimum with the item number as the
 * tie-break, then apply W3's floor. `reason` is the chosen candidate's, not the floor's.
 */
const W5_SQL = `
  WITH now_at AS (SELECT $1::timestamptz AS t),
  candidates AS (
      SELECT 3 AS source, b.next_check_at AS at, 'blocker recheck' AS reason
        FROM project_blocker b, now_at
       WHERE b.project_id = 'p1' AND b.resolved_at IS NULL AND b.recovery <> 'HUMAN' AND b.next_check_at > now_at.t
    UNION ALL
      SELECT 4, t.run_at, 'task runAt due'
        FROM task t, now_at
       WHERE t.project_id = 'p1' AND t.run_at > now_at.t
    UNION ALL
      SELECT 7, a.created_at + interval '60 seconds', 'manual trigger rate-limited'
        FROM project_action a, now_at
       WHERE a.project_id = 'p1' AND a.type = 'OPEN_COORDINATOR_TURN' AND a.status = 'APPLIED'
         AND a.reason_code = 'MANUAL' AND a.generation = 0
         AND a.created_at + interval '60 seconds' > now_at.t
         AND EXISTS (SELECT 1 FROM project_event e
                      WHERE e.project_id = 'p1' AND e.kind = 'user.manual_trigger' AND e.consumed_at IS NULL)
  ),
  chosen AS (SELECT * FROM candidates ORDER BY at, source LIMIT 1)
  SELECT GREATEST(chosen.at, now_at.t + interval '5 seconds')::text AS next_wake_at,
         chosen.reason AS next_wake_reason,
         (GREATEST(chosen.at, now_at.t + interval '5 seconds') > chosen.at) AS floored,
         (SELECT count(*)::text FROM candidates) AS candidate_count
    FROM chosen, now_at`;

const T0 = '2026-08-19T00:00:00.000Z';
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

test('PC-CX-35 on real Postgres: the window boundary and the floor are one deterministic timestamp',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(WAKE_SCHEMA_V16);
      // t0: a MANUAL turn was opened and applied — TR2-a's anchor. A second request arrives inside
      // the window and stays pending (TR2-b/c), so item 7 is applicable.
      await c.query(`INSERT INTO project_action VALUES ('pc:v1:p1:turn:0:d1','p1','OPEN_COORDINATOR_TURN','APPLIED','MANUAL',0,$1)`, [at(0)]);
      await c.query(`INSERT INTO project_event (project_id, kind, dedupe_key, occurred_at) VALUES ('p1','user.manual_trigger','manual:2',$1)`, [at(10_000)]);

      const wake = async (now: number): Promise<{ next_wake_at: string; next_wake_reason: string; floored: boolean; candidate_count: string }> =>
        (await c.query<{ next_wake_at: string; next_wake_reason: string; floored: boolean; candidate_count: string }>(W5_SQL, [at(now)])).rows[0];

      // The review's parametrisation, on real timestamps: the last five seconds are the cells where
      // v1.5's three sentences have no common solution.
      for (const remaining of [0, 1, 2, 4, 5, 6, 59]) {
        const now = 60_000 - remaining * 1_000;
        if (remaining === 0) continue;                       // the window has expired; item 7 no longer applies
        const w = await wake(now);
        const chosen = Date.parse(w.next_wake_at);
        const nextAttemptAt = Date.parse(at(60_000));
        assert.ok(chosen >= Date.parse(at(now)) + 5_000, `remaining=${remaining}s: W3's floor holds`);
        assert.ok(chosen <= nextAttemptAt + 5_000, `remaining=${remaining}s: I18-C's bound holds`);
        assert.ok(chosen >= nextAttemptAt, `remaining=${remaining}s: the window has expired by the time it fires`);
        assert.equal(w.next_wake_reason, 'manual trigger rate-limited', `remaining=${remaining}s: the reason names the candidate`);
        assert.equal(w.floored, remaining < 5, `remaining=${remaining}s: the audit records whether the floor moved it`);
      }

      // v1.5's bound, run as a query over the same rows: `next_wake_at <= window boundary` and
      // `>= now + 5s` have no common solution in the last five seconds. This is the arithmetic the
      // review published, evaluated by the server rather than asserted in prose.
      const unsatisfiable = (await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM generate_series(0, 4) AS remaining
         WHERE $1::timestamptz - (remaining || ' seconds')::interval + interval '5 seconds' > $1::timestamptz`,
        [at(60_000)])).rows[0];
      assert.equal(Number(unsatisfiable.n), 5, 'five of the seven parametrised cells are inside the floor');

      // A second, earlier candidate: §10.4 takes the minimum, and TR2-e's "point at the boundary"
      // must not override it. The earlier wake re-evaluates the pending request anyway.
      await c.query(`INSERT INTO task VALUES ('t1','p1',$1)`, [at(59_000)]);
      const withRunAt = await wake(50_000);
      assert.equal(Date.parse(withRunAt.next_wake_at), Date.parse(at(59_000)), 'the minimum wins');
      assert.equal(withRunAt.next_wake_reason, 'task runAt due', 'and the reason is the candidate it woke for');
      assert.equal(withRunAt.candidate_count, '2', 'both candidates go to the audit');

      // A tie at the same instant is decided by §10.4's item numbers, and the answer does not depend
      // on the order the rows come back in.
      await c.query(`UPDATE task SET run_at = $1 WHERE id = 't1'`, [at(60_000)]);
      const tie = await wake(30_000);
      assert.equal(tie.next_wake_reason, 'task runAt due', 'item 4 beats item 7 at the same instant (W5 step 2)');
      assert.equal(Date.parse(tie.next_wake_at), Date.parse(at(60_000)));
      await c.query(`INSERT INTO project_blocker VALUES ('b1','p1','TIME',NULL,NULL,$1)`, [at(60_000)]);
      const threeWay = await wake(30_000);
      assert.equal(threeWay.next_wake_reason, 'blocker recheck', 'item 3 beats both, by the same total order');
      assert.equal(threeWay.candidate_count, '3');

      // Once the request is answered, item 7 stops applying — the candidate table is derived from
      // rows, so "the pending request is gone" needs no separate bookkeeping.
      await c.query(`UPDATE project_event SET consumed_at = $1 WHERE consumed_at IS NULL`, [at(31_000)]);
      const answered = await wake(30_000);
      assert.equal(answered.candidate_count, '2', 'a consumed request contributes no wake candidate');
    } finally {
      await c.end();
    }
  });

/** §10.2 W4, all four branches, as the migration would create it. `version` picks v1.5 (three). */
function w4Sql(version: 'v15' | 'v16'): string {
  return `
    SELECT p.id
      FROM project p
      JOIN project_runtime r ON r.project_id = p.id
     WHERE p.status = 'OPEN' AND p.coordinator_enabled
       AND r.run_state <> 'SETTLED'
       AND (
             (r.next_wake_at IS NOT NULL AND r.next_wake_at < $1::timestamptz - interval '5 minutes')
          OR (r.next_wake_at IS NULL AND EXISTS (
                SELECT 1 FROM project_blocker b
                 WHERE b.project_id = p.id AND b.resolved_at IS NULL
                   AND (b.recovery <> 'HUMAN' OR b.escalated_at IS NULL)))
          OR (r.next_wake_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM project_blocker b
                 WHERE b.project_id = p.id AND b.resolved_at IS NULL))
          ${version === 'v16' ? `OR EXISTS (
                SELECT 1 FROM project_event e
                 WHERE e.project_id = p.id AND e.consumed_at IS NULL
                   AND COALESCE(e.next_attempt_at, e.occurred_at) < $1::timestamptz - interval '5 minutes')` : ''}
           )
     ORDER BY r.next_wake_at NULLS FIRST
     LIMIT 200`;
}

/** §4.3 I18, as the three-branch classification a production snapshot can be run through. */
const I18_SHAPE_SQL = `
  SELECT e.dedupe_key,
         CASE
           WHEN e.consumed_at IS NOT NULL THEN 'A'
           WHEN e.next_attempt_at IS NULL AND e.attempts = 0 THEN 'B'
           WHEN e.next_attempt_at IS NOT NULL AND r.next_wake_at IS NOT NULL
                AND r.next_wake_at <= e.next_attempt_at + interval '5 seconds' THEN 'C'
           ELSE 'NONE'
         END AS shape
    FROM project_event e JOIN project_runtime r ON r.project_id = e.project_id
   WHERE e.kind = 'user.manual_trigger' ORDER BY e.dedupe_key`;

test('PC-CX-36 on real Postgres: the backstop sees an event no consumer took',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(WAKE_SCHEMA_V16);
      const hits = async (version: 'v15' | 'v16', now: number): Promise<string[]> =>
        (await c.query<{ id: string }>(w4Sql(version), [at(now)])).rows.map((r) => r.id);
      const shapes = async (): Promise<Record<string, string>> =>
        Object.fromEntries((await c.query<{ dedupe_key: string; shape: string }>(I18_SHAPE_SQL)).rows
          .map((r) => [r.dedupe_key, r.shape]));

      // The project has stopped its clock legally: every open blocker is HUMAN and escalated, so
      // §10.4 N-null permits `next_wake_at IS NULL` and §10.3 (c) keeps it visible.
      await c.query(`INSERT INTO project_blocker VALUES ('b1','p1','HUMAN',NULL,$1,NULL)`, [at(0)]);
      assert.deepEqual(await hits('v16', 60_000), [], 'a legally stopped clock is not a backstop hit');

      // The user presses "run it now". The row is committed with the business transaction (§5.3 N4)
      // and the consumer is asynchronous (§5.4) — this is every explicit request's first state.
      await c.query(`INSERT INTO project_event (project_id, kind, dedupe_key, occurred_at) VALUES ('p1','user.manual_trigger','manual:1',$1)`, [at(0)]);
      assert.deepEqual(await shapes(), { 'manual:1': 'B' }, 'I18-B: committed, not yet consumed, nothing attempted');
      assert.deepEqual(await hits('v16', 60_000), [], 'inside the L cap the backstop stays quiet (PC-CX-05: a permanent alarm is no alarm)');

      // The consumer dies. Five minutes later nothing in v1.5 points at this row: the three v1.5
      // branches all read the clock, and this project legitimately has none.
      assert.deepEqual(await hits('v15', 6 * 60_000), [],
        'PC-CX-36 must reproduce: no v1.5 branch sees an event no consumer took');
      assert.deepEqual(await hits('v16', 6 * 60_000), ['p1'], 'the (iv) branch does, and it logs a WARN');

      // Rate-limited: the row is now shape C, and the wake is inside the floor slack W5 allows.
      await c.query(`UPDATE project_event SET next_attempt_at = $1 WHERE dedupe_key = 'manual:1'`, [at(60_000)]);
      await c.query(`UPDATE project_runtime SET next_wake_at = $1, next_wake_reason = 'manual trigger rate-limited' WHERE project_id = 'p1'`, [at(63_000)]);
      assert.deepEqual(await shapes(), { 'manual:1': 'C' }, 'I18-C: the wake may be up to five seconds past the boundary (W5)');
      assert.deepEqual(await hits('v16', 120_000), [], 'a scheduled retry that has not come due is not a hit');

      // …and once the retry time is five minutes in the past, the (iv) branch catches that too —
      // the same predicate covers "never taken" and "taken, rescheduled, then dropped".
      assert.deepEqual(await hits('v16', 6 * 60_000 + 60_000), ['p1'], 'a missed retry is late in exactly the same sense');

      // Answered: consumed, and nothing fires for it again.
      await c.query(`UPDATE project_event SET consumed_at = $1, next_attempt_at = NULL WHERE dedupe_key = 'manual:1'`, [at(60_000)]);
      await c.query(`UPDATE project_runtime SET next_wake_at = NULL, next_wake_reason = NULL WHERE project_id = 'p1'`);
      assert.deepEqual(await shapes(), { 'manual:1': 'A' }, 'I18-A: answered');
      assert.deepEqual(await hits('v16', 10 * 60_000), [], 'an answered request is not a backstop hit, however old it is');

      // The fourth shape stays a defect: attempted, neither consumed nor rescheduled.
      await c.query(`INSERT INTO project_event (project_id, kind, dedupe_key, occurred_at, attempts) VALUES ('p1','user.manual_trigger','manual:2',$1,3)`, [at(0)]);
      assert.equal((await shapes())['manual:2'], 'NONE', 'attempted but neither consumed nor rescheduled must remain a defect');
      assert.deepEqual(await hits('v16', 6 * 60_000), ['p1'], 'and the backstop sees it as well');
    } finally {
      await c.end();
    }
  });
