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

// ─────────────────────────────────────────────────────────────────────────────
// Round seven (`PC-CX-37..42`, §25). Four of the six make claims that only a real server settles:
// what a trigger that compares whole rows does when the schema grows, what a `BEFORE UPDATE`
// mutator protocol admits across a session's three phases, whether an `ORDER BY` is deterministic
// without a third key, and whether `text` ordering depends on the database collation.
// ─────────────────────────────────────────────────────────────────────────────

const V17_SCHEMA = 'pcc_v17';

function isolated17(body: string): string {
  return `
    DROP SCHEMA IF EXISTS ${V17_SCHEMA} CASCADE;
    CREATE SCHEMA ${V17_SCHEMA};
    SET search_path TO ${V17_SCHEMA};
    ${body}
  `;
}

/** §7.7 D11 as v1.7 specifies it: whole-row comparison minus a two-column allowlist. */
const D11_V17 = `
  CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
  DECLARE writable text[] := ARRAY['result_session_id', 'detail'];
          changed  text;
  BEGIN
    IF OLD.status <> 'APPLIED' THEN RETURN NEW; END IF;
    IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
      SELECT string_agg(e.key, ',' ORDER BY e.key) INTO changed
        FROM jsonb_each(to_jsonb(NEW) - writable) e
       WHERE e.value IS DISTINCT FROM ((to_jsonb(OLD) - writable) -> e.key);
      RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE: action % is APPLIED; identity, attribution, frozen execution context and reason code are frozen (changed: %)',
        OLD.id, changed;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** …and as v1.4 wrote it: the six-column denylist that did not learn about v1.5's three columns. */
const D11_V14 = `
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
`;

const ACTION_SCHEMA_V17 = isolated17(`
  CREATE TABLE project_action (
    id                     text PRIMARY KEY,
    idempotency_key        text UNIQUE NOT NULL,
    project_id             text NOT NULL,
    type                   text NOT NULL,
    status                 text NOT NULL,
    subject_type           text NOT NULL,
    subject_id             text NOT NULL,
    fencing_token          bigint NOT NULL,
    result_session_id      text,
    detail                 jsonb,
    execution_context      jsonb,
    execution_context_digest text,
    execution_result_digest  text,
    reason_code            text
  );
  CREATE TABLE session (
    id                       text PRIMARY KEY,
    task_id                  text NOT NULL,
    project_action_id        text REFERENCES project_action(id),
    dispatch_origin          text NOT NULL,
    status                   text NOT NULL,
    agent_id                 text,
    workspace_id             text,
    assigned_runner_id       text,
    provider                 text,
    provider_builtin         boolean,
    required_capabilities    text[],
    model                    text,
    effort                   text,
    execution_pin_generation bigint NOT NULL DEFAULT 0
  );
`);

/** Every column of `project_action`, read from the catalog rather than from a list in this file. */
async function actionColumns(c: Client): Promise<string[]> {
  const rows = (await c.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = '${V17_SCHEMA}' AND table_name = 'project_action'
     ORDER BY ordinal_position`)).rows;
  return rows.map((r) => r.column_name);
}

/** A value that is guaranteed to differ from the current one, whatever the column's type is. */
function mutationFor(column: string): string {
  if (column === 'fencing_token') return '999';
  if (column === 'execution_context' || column === 'detail') return `'{"provider":"codex"}'::jsonb`;
  return `'mutated-${column}'`;
}

test('PC-CX-37 on real Postgres: the applied action row is frozen column by column, whatever the schema is',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(ACTION_SCHEMA_V17);
      const seed = async (): Promise<void> => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(`
          INSERT INTO project_action VALUES
            ('act1','pc:v1:p1:dispatch:t1:0','p1','DISPATCH_TASK','APPLIED','TASK','t1',1,NULL,NULL,
             '{"provider":"claude"}'::jsonb,'digest-a','digest-b','MANUAL')`);
        await c.query(`
          INSERT INTO session (id, task_id, project_action_id, dispatch_origin, status, provider)
          VALUES ('s1','t1','act1','COORDINATOR','PENDING','claude')`);
      };
      const i17aViolations = async (): Promise<string> => (await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM session s JOIN project_action a ON a.id = s.project_action_id
         WHERE s.provider IS DISTINCT FROM a.execution_context->>'provider'`)).rows[0].n;
      const tryRewrite = async (column: string): Promise<string | null> => {
        await c.query('BEGIN');
        try {
          await c.query(`UPDATE project_action SET ${column} = ${mutationFor(column)} WHERE id = 'act1'`);
          await c.query('COMMIT');
          return null;
        } catch (error) {
          await c.query('ROLLBACK');
          return (error as Error).message;
        }
      };

      // The allowlist, driven by the catalog. `id` is the primary key the trigger reports on, and
      // rewriting it would change which row we are talking about, so it is excluded from the sweep.
      const columns = (await actionColumns(c)).filter((col) => col !== 'id');
      assert.ok(columns.includes('execution_result_digest'), 'the fixture must carry the column v1.7 adds');

      await c.query(D11_V17);
      await c.query(`DROP TRIGGER IF EXISTS project_action_applied_immutable_guard ON project_action;
                     CREATE TRIGGER project_action_applied_immutable_guard BEFORE UPDATE ON project_action
                       FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard()`);
      const writable: string[] = [];
      for (const col of columns) {
        await seed();
        const failure = await tryRewrite(col);
        if (failure === null) writable.push(col);
        else assert.match(failure, /ACTION_APPLIED_IMMUTABLE/, `${col}: refused, but not by D11`);
      }
      assert.deepEqual(writable, ['result_session_id', 'detail'],
        'exactly the allowlist stays writable, and it is read from the schema rather than from a list');

      // The normal path still commits: §8.3 inserts CLAIMED, flips it, then backfills the session id.
      await c.query(`DELETE FROM session; DELETE FROM project_action`);
      await c.query(`INSERT INTO project_action VALUES ('act2','k2','p1','DISPATCH_TASK','CLAIMED','TASK','t2',1,NULL,NULL,NULL,NULL,NULL,NULL)`);
      await c.query(`UPDATE project_action SET status = 'APPLIED' WHERE id = 'act2'`);
      await c.query(`UPDATE project_action SET result_session_id = 's2' WHERE id = 'act2'`);
      await c.query(`INSERT INTO project_action VALUES ('act3','k3','p1','DISPATCH_TASK','CLAIMED','TASK','t3',1,NULL,NULL,NULL,NULL,NULL,NULL)`);
      await c.query(`UPDATE project_action SET status = 'SUPERSEDED' WHERE id = 'act3'`);
      assert.equal((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM project_action`)).rows[0].n, '2',
        'CLAIMED → APPLIED and CLAIMED → SUPERSEDED are the normal path and must not be blocked');

      // Reverse control — v1.4's denylist, rebuilt verbatim. The three columns v1.5 added commit,
      // and the review's exact observation comes back: a committed state that violates I17-A.
      await c.query(D11_V14);
      await seed();
      await c.query(`UPDATE project_action
                        SET execution_context = '{"provider":"codex"}'::jsonb,
                            execution_context_digest = 'digest-codex',
                            reason_code = 'REPLAN'
                      WHERE id = 'act1'`);
      const row = (await c.query<{ reason_code: string; provider: string; frozen_provider: string }>(`
        SELECT a.reason_code, s.provider, a.execution_context->>'provider' AS frozen_provider
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id = 's1'`)).rows[0];
      assert.deepEqual(row, { reason_code: 'REPLAN', provider: 'claude', frozen_provider: 'codex' },
        'the v1.4 shape must still be reproducible — that is what makes the fix meaningful');
      assert.equal(await i17aViolations(), '1', 'and it leaves a committed state that violates I17-A');

      // …while the v1.7 object refuses the same statement and leaves the row alone.
      await c.query(D11_V17);
      await seed();
      let message = '';
      try {
        await c.query(`UPDATE project_action SET execution_context = '{"provider":"codex"}'::jsonb, reason_code = 'REPLAN' WHERE id = 'act1'`);
      } catch (error) {
        message = (error as Error).message;
      }
      assert.match(message, /ACTION_APPLIED_IMMUTABLE/, 'the v1.7 object refuses the review\'s UPDATE');
      assert.match(message, /changed: execution_context,reason_code/, 'and it names the columns that moved');
      assert.equal(await i17aViolations(), '0', 'so I17-A still returns zero rows');
    } finally {
      await c.end();
    }
  });

/** §7.7 D15: the create-frozen columns come from the action row, and the claim-frozen ones have a generation. */
const D15_V17 = `
  CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $fn$
  DECLARE ctx jsonb;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;
      IF ctx IS NULL
         OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
         OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
         OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
         OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
         OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
         OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities' THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % does not carry the frozen execution context of action %',
          NEW.id, NEW.project_action_id;
      END IF;
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL OR NEW.execution_pin_generation <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % materializes claim-frozen columns at create', NEW.id;
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.assigned_runner_id IS DISTINCT FROM OLD.assigned_runner_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_builtin IS DISTINCT FROM OLD.provider_builtin
       OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities
       OR NEW.project_action_id IS DISTINCT FROM OLD.project_action_id THEN
      RAISE EXCEPTION 'EXECUTION_SNAPSHOT_FROZEN: session % cannot rewrite a create-frozen column', OLD.id;
    END IF;
    IF NEW.model IS DISTINCT FROM OLD.model OR NEW.effort IS DISTINCT FROM OLD.effort THEN
      IF NEW.execution_pin_generation <> OLD.execution_pin_generation + 1 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % rewrote model/effort without advancing the generation', OLD.id;
      END IF;
    ELSIF NEW.execution_pin_generation IS DISTINCT FROM OLD.execution_pin_generation THEN
      RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % advanced the generation without rewriting anything', OLD.id;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

const FROZEN_CONTEXT = `'{"agentId":"a1","workspaceId":"w1","assignedRunnerId":"r1","provider":"claude",` +
  `"providerBuiltin":true,"requiredCapabilities":["linux"],"model":"model-v1","effort":"high"}'::jsonb`;

async function seedSnapshotFixture(c: Client): Promise<void> {
  await c.query(`DELETE FROM session; DELETE FROM project_action`);
  await c.query(`
    INSERT INTO project_action VALUES
      ('act1','pc:v1:p1:dispatch:t1:0','p1','DISPATCH_TASK','APPLIED','TASK','t1',1,NULL,NULL,
       ${FROZEN_CONTEXT},'digest-a','digest-b','MANUAL')`);
}

const INSERT_PLACEHOLDER_V17 = `
  INSERT INTO session (id, task_id, project_action_id, dispatch_origin, status,
                       agent_id, workspace_id, assigned_runner_id, provider, provider_builtin, required_capabilities)
  VALUES ('s1','t1','act1','COORDINATOR','PENDING','a1','w1','r1','claude',true,ARRAY['linux'])`;

test('PC-CX-38 on real Postgres: the placeholder snapshot has three phases and one monotone generation',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(ACTION_SCHEMA_V17);
      await c.query(D15_V17);
      await c.query(`DROP TRIGGER IF EXISTS session_execution_snapshot_guard ON session;
                     CREATE TRIGGER session_execution_snapshot_guard BEFORE INSERT OR UPDATE ON session
                       FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard()`);
      // I17-A: only the create-frozen columns. I17-A2: the phase-indexed statement about the two
      // columns PAC §6 freezes at first claim, read straight off the row.
      const i17a = async (): Promise<string> => (await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM session s JOIN project_action a ON a.id = s.project_action_id
         WHERE s.dispatch_origin = 'COORDINATOR'
           AND (s.agent_id           IS DISTINCT FROM a.execution_context->>'agentId'
             OR s.workspace_id       IS DISTINCT FROM a.execution_context->>'workspaceId'
             OR s.assigned_runner_id IS DISTINCT FROM a.execution_context->>'assignedRunnerId'
             OR s.provider           IS DISTINCT FROM a.execution_context->>'provider'
             OR to_jsonb(s.required_capabilities) IS DISTINCT FROM a.execution_context->'requiredCapabilities')`)).rows[0].n;
      const i17a2 = async (): Promise<string> => (await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM session s JOIN project_action a ON a.id = s.project_action_id
         WHERE s.dispatch_origin = 'COORDINATOR'
           AND NOT (
                 (s.execution_pin_generation = 0 AND s.model IS NULL AND s.effort IS NULL)
              OR (s.execution_pin_generation = 1
                  AND (a.execution_context->>'model' IS NULL
                       OR s.model IS NOT DISTINCT FROM a.execution_context->>'model'))
              OR (s.execution_pin_generation >= 2
                  AND jsonb_array_length(COALESCE(a.detail->'retiredPins','[]'::jsonb)) = s.execution_pin_generation - 1))`)).rows[0].n;
      const phase = async (): Promise<{ model: string | null; effort: string | null; gen: string }> => {
        const r = (await c.query<{ model: string | null; effort: string | null; gen: string }>(
          `SELECT model, effort, execution_pin_generation::text AS gen FROM session WHERE id = 's1'`)).rows[0];
        return r;
      };
      const refuses = async (sql: string): Promise<string> => {
        try {
          await c.query(sql);
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      };

      await seedSnapshotFixture(c);
      // Phase 0 — create. PAC §6 does not freeze model/effort here, so a NULL is the correct state.
      await c.query(INSERT_PLACEHOLDER_V17);
      assert.deepEqual(await phase(), { model: null, effort: null, gen: '0' });
      assert.equal(await i17a(), '0', 'I17-A holds at create');
      assert.equal(await i17a2(), '0', 'I17-A2 phase 0: the claim-frozen columns are not materialized yet');

      // Phase 1 — first claim materializes them, and the generation records that it happened once.
      await c.query(`UPDATE session SET model = 'model-v1', effort = 'high', execution_pin_generation = 1 WHERE id = 's1'`);
      assert.deepEqual(await phase(), { model: 'model-v1', effort: 'high', gen: '1' });
      assert.equal(await i17a2(), '0', 'I17-A2 phase 1: the materialized value equals the frozen one');

      // Phase 2 — the runtime retires the pin. PAC §6 permits exactly this one rewrite, and D15
      // makes it impossible to do it silently: the generation and the record move together.
      await c.query(`UPDATE project_action SET detail = '{"retiredPins":[{"from":"model-v1","to":"model-v2"}]}'::jsonb WHERE id = 'act1'`);
      await c.query(`UPDATE session SET model = 'model-v2', execution_pin_generation = 2 WHERE id = 's1'`);
      assert.deepEqual(await phase(), { model: 'model-v2', effort: 'high', gen: '2' });
      assert.equal(await i17a(), '0', 'the create-frozen columns never moved');
      assert.equal(await i17a2(), '0', 'I17-A2 phase 2: one recorded retirement for one advanced generation');

      // The four refusals D15-e names.
      assert.match(await refuses(`UPDATE session SET provider = 'codex' WHERE id = 's1'`), /EXECUTION_SNAPSHOT_FROZEN/);
      assert.match(await refuses(`UPDATE session SET model = 'model-v3' WHERE id = 's1'`), /EXECUTION_PIN_GENERATION/);
      assert.match(await refuses(`UPDATE session SET execution_pin_generation = 5 WHERE id = 's1'`), /EXECUTION_PIN_GENERATION/);
      await seedSnapshotFixture(c);
      assert.match(
        await refuses(`${INSERT_PLACEHOLDER_V17.replace("'PENDING',", "'PENDING',")} `.replace('required_capabilities)', 'required_capabilities, model)').replace("ARRAY['linux'])", "ARRAY['linux'],'model-v1')")),
        /EXECUTION_SNAPSHOT_MISMATCH/, 'materializing a claim-frozen column at create must be refused');

      // Reverse control — v1.6's I17-A, which compared `model` too. Phases 0 and 2 are legal states
      // of a normal lifecycle, and it calls both of them violations.
      await seedSnapshotFixture(c);
      await c.query(INSERT_PLACEHOLDER_V17);
      const i17aV16 = async (): Promise<string> => (await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM session s JOIN project_action a ON a.id = s.project_action_id
         WHERE s.dispatch_origin = 'COORDINATOR' AND s.model IS DISTINCT FROM a.execution_context->>'model'`)).rows[0].n;
      assert.equal(await i17aV16(), '1', 'PC-CX-38 must reproduce: v1.6 I17-A is false on a freshly created placeholder');
      await c.query(`UPDATE session SET model = 'model-v1', effort = 'high', execution_pin_generation = 1 WHERE id = 's1'`);
      assert.equal(await i17aV16(), '0', 'it is true only in the middle phase');
      await c.query(`UPDATE session SET model = 'model-v2', execution_pin_generation = 2 WHERE id = 's1'`);
      assert.equal(await i17aV16(), '1', 'and false again after the legal retiredPin rewrite');
      assert.equal(await i17a2(), '1', 'I17-A2 also catches this one: the generation advanced with no record');
    } finally {
      await c.end();
    }
  });

const WAKE_CANDIDATES_V17 = isolated17(`
  CREATE TABLE wake_candidate (
    at timestamptz NOT NULL, source int NOT NULL, subject_type text NOT NULL, subject_id text NOT NULL, reason text NOT NULL
  );
`);

test('PC-CX-39 on real Postgres: the candidate order is total, and it does not depend on the collation',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(WAKE_CANDIDATES_V17);
      const chosen = async (version: 'v16' | 'v17'): Promise<{ reason: string; rows: string }> => {
        const order = version === 'v16'
          ? 'at, source'
          : 'at, source, subject_type COLLATE "C", subject_id COLLATE "C"';
        const r = (await c.query<{ reason: string }>(`SELECT reason FROM wake_candidate ORDER BY ${order} LIMIT 1`)).rows[0];
        const all = (await c.query<{ reason: string }>(`SELECT reason FROM wake_candidate ORDER BY ${order}`)).rows;
        return { reason: r.reason, rows: all.map((x) => x.reason).join('|') };
      };

      // Two open blockers, both §10.4 item 1, both due at the same instant — the review's example.
      const insert = async (order: 'forward' | 'reverse'): Promise<void> => {
        await c.query('DELETE FROM wake_candidate');
        const rows = [
          `('${at(60_000)}',1,'BLOCKER','b1','provider blocker b1')`,
          `('${at(60_000)}',1,'BLOCKER','b2','runner blocker b2')`,
        ];
        await c.query(`INSERT INTO wake_candidate VALUES ${(order === 'forward' ? rows : [...rows].reverse()).join(',')}`);
      };

      // v1.6's two keys leave the choice to the plan and the physical row order. `LIMIT 1` after an
      // unstable sort is exactly the shape that looks deterministic in a test and is not.
      await insert('forward');
      const v16Forward = await chosen('v16');
      await insert('reverse');
      const v16Reverse = await chosen('v16');
      assert.notEqual(v16Forward.reason, v16Reverse.reason,
        'PC-CX-39 must reproduce: without a third key the winner follows the insertion order');

      // v1.7: the same table, either way round, one answer — and the whole audit row matches too.
      await insert('forward');
      const v17Forward = await chosen('v17');
      await insert('reverse');
      const v17Reverse = await chosen('v17');
      assert.deepEqual(v17Forward, v17Reverse, 'the four-key order does not depend on insertion order');
      assert.equal(v17Forward.reason, 'provider blocker b1', 'and b1 < b2 by bytes');

      // The fourth key is compared as bytes. `_` is 0x5f and `a` is 0x61, so C order puts `a_b`
      // first; a locale that ignores punctuation puts `aab` first. The contract picks one.
      await c.query(`DELETE FROM wake_candidate;
        INSERT INTO wake_candidate VALUES
          ('${at(60_000)}',3,'TASK','a_b','task a_b'),
          ('${at(60_000)}',3,'TASK','aab','task aab')`);
      const byBytes = (await c.query<{ reason: string }>(
        `SELECT reason FROM wake_candidate ORDER BY at, source, subject_type COLLATE "C", subject_id COLLATE "C" LIMIT 1`)).rows[0];
      assert.equal(byBytes.reason, 'task a_b', 'byte order is the one W5 specifies');
      const byLocale = (await c.query<{ reason: string; ordered: boolean }>(`
        SELECT reason, ('a_b' COLLATE "C") < ('aab' COLLATE "C") AS ordered FROM wake_candidate
         ORDER BY at, source, subject_id COLLATE "C" LIMIT 1`)).rows[0];
      assert.equal(byLocale.ordered, true, 'and it is the server, not this test, that decides what byte order means');
    } finally {
      await c.end();
    }
  });

test('PC-CX-40 on real Postgres: the same declared input yields the same wake at two wall clocks',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(WAKE_SCHEMA_V16);
      // One declared input: the anchor action at t0 and one unconsumed manual trigger, so §10.4's
      // item 7 offers the window boundary at 60s. `epoch` is what the decision read (58s).
      await c.query(`INSERT INTO project_action VALUES ('k1','p1','OPEN_COORDINATOR_TURN','APPLIED','MANUAL',0,$1)`, [at(0)]);
      await c.query(`INSERT INTO project_event (project_id, kind, dedupe_key, occurred_at) VALUES ('p1','user.manual_trigger','manual:1',$1)`, [at(0)]);

      const wakeAt = async (clock: number): Promise<string> =>
        (await c.query<{ next_wake_at: string }>(W5_SQL, [at(clock)])).rows[0].next_wake_at;

      // v1.6 floored against the wall clock, which is not in the hash: two executions of the same
      // declared input, one second apart, produce two wakes. S3 asks for one.
      const epoch = 58_000;
      const v16 = await Promise.all([58_000, 59_000].map((wall) => wakeAt(wall)));
      assert.notEqual(v16[0], v16[1], 'PC-CX-40 must reproduce: the wall clock alone changes the answer');
      assert.equal(Date.parse(v16[0]) - Date.parse(T0), 63_000);
      assert.equal(Date.parse(v16[1]) - Date.parse(T0), 64_000);

      // v1.7 floors against `evaluation.epoch`, which is in the hash. The wall clock the reconcile
      // happens to run at cannot move it, so the same declared input has one answer.
      const v17 = await Promise.all([0, 1, 4].map(() => wakeAt(epoch)));
      assert.equal(new Set(v17).size, 1, 'one declared input, one wake');
      assert.equal(Date.parse(v17[0]) - Date.parse(T0), 63_000, 'and it is the one the frozen epoch determines');

      // A different epoch is a different declared input (it is inside `decisionInputHash`), so it
      // may legitimately give a different wake — that is the half that keeps S5 and S3 consistent.
      assert.equal(Date.parse(await wakeAt(59_000)) - Date.parse(T0), 64_000);
    } finally {
      await c.end();
    }
  });

/** §5.5 EV3: the out-of-loop predicate, and the one statement that answers it. */
const EV3_DISCARD = `
  UPDATE project_event e
     SET consumed_at = $1, disposition = 'DISCARDED_OUT_OF_LOOP'
    FROM project p JOIN project_runtime r ON r.project_id = p.id
   WHERE e.project_id = p.id AND e.consumed_at IS NULL
     AND (p.status <> 'OPEN' OR NOT p.coordinator_enabled OR r.run_state = 'SETTLED')
  RETURNING e.id`;

test('PC-CX-41 on real Postgres: an out-of-loop event is discarded exactly once, and re-entry consumes instead',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(WAKE_SCHEMA_V16);
      await c.query(`ALTER TABLE project_event ADD COLUMN disposition text`);
      await c.query(`INSERT INTO project VALUES ('legacy','OPEN',false), ('settled','DONE',true)`);
      await c.query(`INSERT INTO project_runtime (project_id, run_state) VALUES ('legacy','PLANNING'), ('settled','SETTLED')`);
      // §5.3 N1 produces these: it filters on task.project_id being non-null, nothing else.
      await c.query(`INSERT INTO project_event (project_id, kind, dedupe_key, occurred_at)
                     VALUES ('legacy','task.updated','task.updated:t1',$1), ('settled','session.ended','session.ended:s1',$1)`, [at(0)]);

      // The shared fixture also seeds an in-loop `p1` with no wake and no blockers, which branch
      // (iii) rightly calls silent idling. This test is about the other two rows, so it reads the
      // backstop's answer for them and leaves that one alone.
      const backstop = async (now: number): Promise<string[]> =>
        (await c.query<{ id: string }>(w4Sql('v16'), [at(now)])).rows
          .map((r) => r.id).filter((id) => id === 'legacy' || id === 'settled');
      const unowned = async (): Promise<string[]> => (await c.query<{ project_id: string }>(`
        SELECT e.project_id FROM project_event e WHERE e.consumed_at IS NULL
           AND e.project_id NOT IN (SELECT id FROM project WHERE status = 'OPEN' AND coordinator_enabled)
         ORDER BY e.project_id`)).rows.map((r) => r.project_id);

      // PC-CX-41 must reproduce: six minutes later, no backstop branch sees either row, and I6
      // forbids reconciling them — so nothing at all is responsible for them.
      assert.deepEqual(await backstop(6 * 60_000), [], 'W4 only scans in-loop projects, by design');
      assert.deepEqual(await unowned(), ['legacy', 'settled'], 'and both rows are unconsumed with no owner');

      // §5.5 EV3: one statement, and it is the consumer that runs it — no lease, no action row.
      const discarded = (await c.query<{ id: string }>(EV3_DISCARD, [at(1_000)])).rows;
      assert.equal(discarded.length, 2, 'both out-of-loop rows get a terminal disposition');
      assert.deepEqual(await unowned(), [], 'and nothing is left unowned');
      assert.deepEqual((await c.query<{ disposition: string }>(
        `SELECT DISTINCT disposition FROM project_event WHERE consumed_at IS NOT NULL`)).rows,
      [{ disposition: 'DISCARDED_OUT_OF_LOOP' }], 'EV2: the disposition is recorded, not implied');

      // EV4: replaying it affects zero rows. The condition is on the row, not on a bookkeeping flag.
      assert.equal((await c.query(EV3_DISCARD, [at(2_000)])).rowCount, 0, 'a replayed discard is a no-op');
      // …and the same cause recurring inserts a fresh row, because the partial unique index only
      // constrains unconsumed rows. It is judged again, at the moment it is taken.
      await c.query(`INSERT INTO project_event (project_id, kind, dedupe_key, occurred_at)
                     VALUES ('legacy','task.updated','task.updated:t1',$1)`, [at(3_000)]);
      assert.equal((await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM project_event WHERE dedupe_key = 'task.updated:t1'`)).rows[0].n, '2');

      // EV1: re-entry. The user enables the coordinator (G3) — the queued row is now in the loop,
      // so the discard does not select it and a reconcile will consume it instead.
      await c.query(`UPDATE project SET coordinator_enabled = true WHERE id = 'legacy'`);
      assert.equal((await c.query(EV3_DISCARD, [at(4_000)])).rowCount, 0,
        'an event queued while out of the loop is consumed after re-entry, not discarded');
      assert.deepEqual(await backstop(6 * 60_000 + 4_000), ['legacy'],
        'and it is back under the branch that owns a late in-loop event');
    } finally {
      await c.end();
    }
  });

test('PC-CX-42 on real Postgres: the snapshot guard admits only the frozen result',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await c.query(ACTION_SCHEMA_V17);
      await c.query(D15_V17);
      await c.query(`DROP TRIGGER IF EXISTS session_execution_snapshot_guard ON session;
                     CREATE TRIGGER session_execution_snapshot_guard BEFORE INSERT OR UPDATE ON session
                       FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard()`);
      const insertWith = async (overrides: Record<string, string>): Promise<string> => {
        await seedSnapshotFixture(c);
        const values: Record<string, string> = {
          agent_id: `'a1'`, workspace_id: `'w1'`, assigned_runner_id: `'r1'`, provider: `'claude'`,
          provider_builtin: 'true', required_capabilities: `ARRAY['linux']`, ...overrides,
        };
        try {
          await c.query(`
            INSERT INTO session (id, task_id, project_action_id, dispatch_origin, status,
                                 agent_id, workspace_id, assigned_runner_id, provider, provider_builtin, required_capabilities)
            VALUES ('s1','t1','act1','COORDINATOR','PENDING',
                    ${values.agent_id}, ${values.workspace_id}, ${values.assigned_runner_id},
                    ${values.provider}, ${values.provider_builtin}, ${values.required_capabilities})`);
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      };

      // EC6-a/EC6-b: the placeholder's create-frozen columns must *be* the frozen context, so a
      // passing digest comparison cannot be followed by a different insert.
      assert.equal(await insertWith({}), '', 'the frozen result inserts');
      // Every create-frozen component, one at a time. This is the half D14 does not prove: it
      // re-resolves the nine identities, it does not check what was written into the row.
      for (const [column, drift] of Object.entries({
        agent_id: `'a2'`, workspace_id: `'w2'`, assigned_runner_id: `'r2'`, provider: `'codex'`,
        provider_builtin: 'false', required_capabilities: `ARRAY['linux','docker']`,
      })) {
        const failure = await insertWith({ [column]: drift });
        assert.match(failure, /EXECUTION_SNAPSHOT_MISMATCH/, `${column}: a drifted create-frozen column must not commit`);
      }
      // `requiredCapabilities` is the one the review used, and it is not one of EC2-a's nine
      // identities — so this is the case where the authorization digest is *right* and the result
      // is still wrong. That is the whole of PC-CX-42, on a real server.
      assert.match(await insertWith({ required_capabilities: `ARRAY['linux','docker']` }), /EXECUTION_SNAPSHOT_MISMATCH/);

      // Reverse control — drop the guard, and the same INSERT commits a session whose result is
      // not the one the decision froze, while every one of EC2-a's identities still matches.
      await c.query(`DROP TRIGGER session_execution_snapshot_guard ON session`);
      assert.equal(await insertWith({ required_capabilities: `ARRAY['linux','docker']` }), '',
        'PC-CX-42 must reproduce: without D15 the drifted result commits');
      const committed = (await c.query<{ caps: string[]; frozen: string }>(`
        SELECT s.required_capabilities AS caps, a.execution_context->>'requiredCapabilities' AS frozen
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id = 's1'`)).rows[0];
      assert.deepEqual(committed.caps, ['linux', 'docker']);
      assert.equal(committed.frozen, '["linux"]', 'and the row now disagrees with the context it was dispatched from');
    } finally {
      await c.end();
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Round eight (`PC-CX-43..46`, §26). Three questions a hard gate has to answer on a real server:
// after it runs, what write is still left in the transaction (D11 and the publishing UPDATE);
// who decides whether it applies (D9/D14/D15 and `NEW`); and is the closed set it compares against
// really the closed set the other contract froze (D15 and PAC §6's table). Plus one two-way
// proposition that needed an object on each side (D16 and the pin ledger).
// ---------------------------------------------------------------------------------------------

const V18_SCHEMA = 'pcc_v18';

function isolated18(body: string): string {
  return `
    DROP SCHEMA IF EXISTS ${V18_SCHEMA} CASCADE;
    CREATE SCHEMA ${V18_SCHEMA};
    SET search_path TO ${V18_SCHEMA};
    ${body}
  `;
}

/** §7.7 D11 as v1.8 specifies it: two closed allowlists, chosen by `OLD.status`. */
const D11_V18 = `
  CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
  DECLARE writable text[] := ARRAY['result_session_id', 'detail'];
          code     text   := 'ACTION_APPLIED_IMMUTABLE';
          changed  text;
  BEGIN
    IF OLD.status = 'CLAIMED' THEN
      IF NEW.status IS NULL OR NEW.status NOT IN ('CLAIMED','APPLIED','REFUSED','SUPERSEDED') THEN
        RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: action % cannot go CLAIMED -> %',
          OLD.id, COALESCE(NEW.status, 'NULL');
      END IF;
      writable := writable || ARRAY['status', 'refusal_code'];
      code     := 'ACTION_PUBLISH_IMMUTABLE';
    ELSIF OLD.status NOT IN ('APPLIED','REFUSED','SUPERSEDED') THEN
      RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: action % has an unrecognised status %', OLD.id, OLD.status;
    END IF;
    IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
      SELECT string_agg(e.key, ',' ORDER BY e.key) INTO changed
        FROM jsonb_each(to_jsonb(NEW) - writable) e
       WHERE e.value IS DISTINCT FROM ((to_jsonb(OLD) - writable) -> e.key);
      RAISE EXCEPTION '%: action % is %; frozen (changed: %)', code, OLD.id, OLD.status, changed;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** §7.7 D15 as v1.8 specifies it: OLD-aware scope, PAC §6's whole create-frozen set, frozen lineage. */
const D15_V18 = `
  CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $fn$
  DECLARE ctx jsonb;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
      SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;
      IF ctx IS NULL
         OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
         OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
         OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
         OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
         OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
         OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
         OR NEW.permission_mode    IS DISTINCT FROM ctx->>'permissionMode'
         OR NEW.resolution         IS DISTINCT FROM ctx->'resolution'
         OR NEW.snapshot_frozen_at IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % does not carry the frozen execution context of action %',
          NEW.id, NEW.project_action_id;
      END IF;
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL OR NEW.execution_pin_generation <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_SNAPSHOT_MISMATCH: session % materializes claim-frozen columns at create', NEW.id;
      END IF;
      RETURN NEW;
    END IF;
    IF (OLD.task_id IS NULL OR OLD.dispatch_origin <> 'COORDINATOR')
       AND (NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR') THEN RETURN NEW; END IF;
    IF NEW.task_id            IS DISTINCT FROM OLD.task_id
       OR NEW.dispatch_origin IS DISTINCT FROM OLD.dispatch_origin
       OR NEW.project_action_id IS DISTINCT FROM OLD.project_action_id
       OR NEW.agent_id        IS DISTINCT FROM OLD.agent_id
       OR NEW.workspace_id    IS DISTINCT FROM OLD.workspace_id
       OR NEW.assigned_runner_id IS DISTINCT FROM OLD.assigned_runner_id
       OR NEW.provider        IS DISTINCT FROM OLD.provider
       OR NEW.provider_builtin IS DISTINCT FROM OLD.provider_builtin
       OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities
       OR NEW.permission_mode IS DISTINCT FROM OLD.permission_mode
       OR NEW.resolution      IS DISTINCT FROM OLD.resolution
       OR NEW.snapshot_frozen_at IS DISTINCT FROM OLD.snapshot_frozen_at THEN
      RAISE EXCEPTION 'EXECUTION_SNAPSHOT_FROZEN: session % cannot rewrite a create-frozen or lineage column', OLD.id;
    END IF;
    IF NEW.model IS DISTINCT FROM OLD.model OR NEW.effort IS DISTINCT FROM OLD.effort THEN
      IF NEW.execution_pin_generation <> OLD.execution_pin_generation + 1 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % rewrote model/effort without advancing the generation', OLD.id;
      END IF;
    ELSIF NEW.execution_pin_generation IS DISTINCT FROM OLD.execution_pin_generation THEN
      RAISE EXCEPTION 'EXECUTION_PIN_GENERATION: session % advanced the generation without rewriting anything', OLD.id;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** §7.7 D16: the commit point, in both directions. */
const D16_V18 = `
  CREATE OR REPLACE FUNCTION session_execution_result_check() RETURNS trigger AS $fn$
  DECLARE ctx jsonb; action_status text; ledger jsonb; claim jsonb;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT a.execution_context, a.status,
           COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), a.detail -> 'claimResolution'
      INTO ctx, action_status, ledger, claim
      FROM project_action a WHERE a.id = NEW.project_action_id;
    IF ctx IS NULL OR action_status <> 'APPLIED'
       OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
       OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
       OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
       OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
       OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
       OR NEW.permission_mode    IS DISTINCT FROM ctx->>'permissionMode'
       OR NEW.resolution         IS DISTINCT FROM ctx->'resolution'
       OR NEW.snapshot_frozen_at IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
        NEW.id, NEW.project_action_id;
    END IF;
    IF NEW.execution_pin_generation = 0 THEN
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL
         OR claim IS NOT NULL OR jsonb_array_length(ledger) <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation 0 but a claim is already recorded', NEW.id;
      END IF;
    ELSIF claim IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation % but action % records no first claim',
        NEW.id, NEW.execution_pin_generation, NEW.project_action_id;
    ELSIF jsonb_array_length(ledger) <> NEW.execution_pin_generation - 1 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation % but action % records % retired pins',
        NEW.id, NEW.execution_pin_generation, NEW.project_action_id, jsonb_array_length(ledger);
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION project_action_pin_ledger_check() RETURNS trigger AS $fn$
  DECLARE generation bigint; ledger jsonb; claim jsonb;
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' OR NEW.result_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT s.execution_pin_generation INTO generation
      FROM session s WHERE s.id = NEW.result_session_id AND s.dispatch_origin = 'COORDINATOR';
    IF generation IS NULL THEN RETURN NULL; END IF;
    ledger := COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb);
    claim  := NEW.detail -> 'claimResolution';
    IF generation = 0 THEN
      IF claim IS NOT NULL OR jsonb_array_length(ledger) <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records a claim session % has not made', NEW.id, NEW.result_session_id;
      END IF;
    ELSIF claim IS NULL OR jsonb_array_length(ledger) <> generation - 1 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records % retired pins for generation %',
        NEW.id, jsonb_array_length(ledger), generation;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** The minimal projection round eight and round nine both build their fixtures on. */
const V18_TABLES = `
  CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL);
  CREATE TABLE project_action (
    id                       text PRIMARY KEY,
    idempotency_key          text UNIQUE NOT NULL,
    project_id               text NOT NULL,
    type                     text NOT NULL,
    status                   text NOT NULL,
    subject_type             text NOT NULL,
    subject_id               text NOT NULL,
    fencing_token            bigint NOT NULL,
    result_session_id        text,
    detail                   jsonb,
    execution_context        jsonb,
    execution_context_digest text,
    execution_result_digest  text,
    reason_code              text,
    refusal_code             text
  );
  CREATE TABLE session (
    id                       text PRIMARY KEY,
    task_id                  text REFERENCES task(id),
    project_action_id        text UNIQUE REFERENCES project_action(id),
    dispatch_origin          text NOT NULL,
    status                   text NOT NULL,
    deleted_at               timestamptz,
    agent_id                 text,
    workspace_id             text,
    assigned_runner_id       text,
    provider                 text,
    provider_builtin         boolean,
    required_capabilities    text[],
    permission_mode          text,
    resolution               jsonb,
    snapshot_frozen_at       timestamptz,
    model                    text,
    effort                   text,
    execution_pin_generation bigint NOT NULL DEFAULT 0,
    CONSTRAINT session_action_only_for_coordinator_chk
      CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL)
  );
  CREATE UNIQUE INDEX session_task_execution_claim_idx ON session (task_id)
    WHERE task_id IS NOT NULL AND deleted_at IS NULL AND status IN ('PENDING','RUNNING');
  INSERT INTO task VALUES ('t1','p1');
`;

const SCHEMA_V18 = isolated18(V18_TABLES);

const V18_FROZEN_AT = '2026-08-19T00:00:00.000Z';
const V18_CONTEXT = `'{"agentId":"a1","workspaceId":"w1","assignedRunnerId":"r1","provider":"claude",` +
  `"providerBuiltin":true,"requiredCapabilities":["linux"],"permissionMode":"read-only",` +
  `"resolution":{"v":1,"who":{"source":"task"},"with":{"source":"agent"},"where":{"source":"workspace"}},"snapshotFrozenAt":"${V18_FROZEN_AT}",` +
  `"model":"model-v1","effort":"high"}'::jsonb`;

const CLAIM_ACTION = (id: string, key: string): string => `
  INSERT INTO project_action (id,idempotency_key,project_id,type,status,subject_type,subject_id,
    fencing_token,result_session_id,detail,execution_context,execution_context_digest,
    execution_result_digest,reason_code,refusal_code)
  VALUES ('${id}','${key}','p1','DISPATCH_TASK','CLAIMED','TASK','t1',1,NULL,'{}'::jsonb,
    ${V18_CONTEXT},'digest-a','digest-b','MANUAL',NULL)`;

const MATCHING_SESSION = (id: string, action: string): string => `
  INSERT INTO session (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,
    assigned_runner_id,provider,provider_builtin,required_capabilities,permission_mode,resolution,
    snapshot_frozen_at)
  VALUES ('${id}','t1','${action}','COORDINATOR','PENDING','a1','w1','r1','claude',true,ARRAY['linux'],
    'read-only','{"v":1,"who":{"source":"task"},"with":{"source":"agent"},"where":{"source":"workspace"}}'::jsonb,'${V18_FROZEN_AT}'::timestamptz)`;

/** Install v1.8's objects. `only` narrows the install so one gate can be shown to carry its half. */
async function installV18(c: Client, only: ('d11' | 'd15' | 'd16')[] = ['d11', 'd15', 'd16']): Promise<void> {
  await c.query(SCHEMA_V18);
  if (only.includes('d11')) {
    await c.query(D11_V18);
    await c.query(`CREATE TRIGGER project_action_applied_immutable_guard BEFORE UPDATE ON project_action
                     FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard()`);
  }
  if (only.includes('d15')) {
    await c.query(D15_V18);
    await c.query(`CREATE TRIGGER session_execution_snapshot_guard BEFORE INSERT OR UPDATE ON session
                     FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard()`);
  }
  if (only.includes('d16')) {
    await c.query(D16_V18);
    await c.query(`CREATE CONSTRAINT TRIGGER session_execution_result_check
                     AFTER INSERT OR UPDATE ON session DEFERRABLE INITIALLY DEFERRED
                     FOR EACH ROW EXECUTE FUNCTION session_execution_result_check()`);
    await c.query(`CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
                     AFTER INSERT OR UPDATE OF detail, result_session_id ON project_action
                     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check()`);
  }
}

/** Run `body` in one transaction; return the refusal message, or `''` if it committed. */
async function txn(c: Client, body: () => Promise<void>): Promise<string> {
  await c.query('BEGIN');
  try {
    await body();
    await c.query('COMMIT');
    return '';
  } catch (error) {
    await c.query('ROLLBACK');
    return (error as Error).message;
  }
}

test('PC-CX-43 on real Postgres: the publishing UPDATE is frozen column by column',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await installV18(c, ['d11', 'd15']);
      const publish = async (extra = ''): Promise<string> => txn(c, async () => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(CLAIM_ACTION('act1', 'k1'));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1'${extra} WHERE id='act1'`);
      });

      // §8.3's normal path, unchanged. If this ever fails the fix has blocked the contract.
      assert.equal(await publish(), '', 'a clean CLAIMED → APPLIED publish must commit');
      assert.equal(await txn(c, async () => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(CLAIM_ACTION('act2', 'k2'));
        await c.query(`UPDATE project_action SET status='SUPERSEDED', refusal_code='TASK_ALREADY_RUNNING' WHERE id='act2'`);
      }), '', 'CLAIMED → SUPERSEDED with a refusal code must commit');

      // The review's transaction: the same publish, plus one forged frozen column.
      assert.match(await publish(`, execution_result_digest='forged-after-session-insert'`),
        /ACTION_PUBLISH_IMMUTABLE.*execution_result_digest/s,
        'the publishing statement must not be able to rewrite the frozen result digest');

      // Schema-driven, so a column added tomorrow is covered without anyone editing this file.
      const columns = (await c.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${V18_SCHEMA}' AND table_name = 'project_action'
         ORDER BY ordinal_position`)).rows.map((r) => r.column_name)
        // `id` names the row; `status` is the publish itself and its target set is asserted below.
        .filter((col) => col !== 'id' && col !== 'status' && col !== 'result_session_id');
      const mutation = (col: string): string => col === 'fencing_token' ? '999'
        : (col === 'execution_context' || col === 'detail') ? `'{"provider":"codex"}'::jsonb`
          : `'mutated-${col}'`;
      const moved: string[] = [];
      for (const col of columns) {
        const failure = await publish(`, ${col} = ${mutation(col)}`);
        if (failure === '') moved.push(col);
        else assert.match(failure, /ACTION_PUBLISH_IMMUTABLE/, `${col}: refused, but not by D11`);
      }
      assert.deepEqual(moved, ['detail', 'refusal_code'],
        'besides status and result_session_id, only detail and refusal_code may move in the publish');

      // The transition target set is closed in both directions.
      assert.match(await txn(c, async () => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(CLAIM_ACTION('act3', 'k3'));
        await c.query(`UPDATE project_action SET status='PENDING' WHERE id='act3'`);
      }), /ACTION_TRANSITION_ILLEGAL/, 'CLAIMED may only reach the three terminal states');
      assert.match(await txn(c, async () => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(CLAIM_ACTION('act4', 'k4'));
        await c.query(`UPDATE project_action SET status='REFUSED', refusal_code='WHO_DISABLED' WHERE id='act4'`);
        await c.query(`UPDATE project_action SET status='CLAIMED' WHERE id='act4'`);
      }), /ACTION_APPLIED_IMMUTABLE/, 'a terminal state may not go back out — D11-a, by construction');

      // Reverse control — v1.7's first statement, rebuilt verbatim. The forged publish commits.
      await c.query(`
        CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
        DECLARE writable text[] := ARRAY['result_session_id', 'detail'];
        BEGIN
          IF OLD.status <> 'APPLIED' THEN RETURN NEW; END IF;
          IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
            RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE';
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;`);
      assert.equal(await publish(`, execution_result_digest='forged-after-session-insert'`), '',
        'PC-CX-43 must reproduce: v1.7 lets the publish forge the frozen result digest');
      assert.deepEqual((await c.query<{ status: string; execution_result_digest: string }>(
        `SELECT status, execution_result_digest FROM project_action WHERE id='act1'`)).rows[0],
        { status: 'APPLIED', execution_result_digest: 'forged-after-session-insert' },
        'and it leaves the review’s exact committed observation');
    } finally {
      await c.end();
    }
  });

test('PC-CX-44 on real Postgres: the whole PAC create-frozen set is proved at insert and at commit',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await installV18(c);
      // One INSERT, built from PAC §6's create-frozen columns so a single override is a one-liner.
      const overrideInsert = (over: Record<string, string>): string => {
        const base: Record<string, string> = {
          id: `'s1'`, task_id: `'t1'`, project_action_id: `'act1'`, dispatch_origin: `'COORDINATOR'`,
          status: `'PENDING'`, agent_id: `'a1'`, workspace_id: `'w1'`, assigned_runner_id: `'r1'`,
          provider: `'claude'`, provider_builtin: 'true', required_capabilities: `ARRAY['linux']`,
          permission_mode: `'read-only'`, resolution: `'{"v":1,"who":{"source":"task"},"with":{"source":"agent"},"where":{"source":"workspace"}}'::jsonb`,
          snapshot_frozen_at: `'${V18_FROZEN_AT}'::timestamptz`, ...over,
        };
        return `INSERT INTO session (${Object.keys(base).join(',')}) VALUES (${Object.values(base).join(',')})`;
      };
      const dispatch = async (over: Record<string, string> = {}): Promise<string> => txn(c, async () => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(CLAIM_ACTION('act1', 'k1'));
        await c.query(overrideInsert(over));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });

      assert.equal(await dispatch(), '', 'a placeholder equal to its frozen context must commit');

      // The three rows v1.7's D15 did not read, one at a time.
      for (const [column, value] of [
        ['permission_mode', `'danger-full-access'`],
        ['resolution', `'{"v":1,"who":{"source":"forged"}}'::jsonb`],
        ['snapshot_frozen_at', `'2026-08-19T09:00:00.000Z'::timestamptz`],
      ] as const) {
        assert.match(await dispatch({ [column]: value }), /EXECUTION_SNAPSHOT_MISMATCH/,
          `${column} is create-frozen by PAC §6 and D15 must compare it at insert`);
      }
      // …and they are frozen after create too.
      assert.equal(await dispatch(), '');
      for (const [column, value] of [
        ['permission_mode', `'danger-full-access'`],
        ['resolution', `'{"forged":true}'::jsonb`],
        ['snapshot_frozen_at', 'now()'],
      ] as const) {
        assert.match(await txn(c, async () => {
          await c.query(`UPDATE session SET ${column} = ${value} WHERE id='s1'`);
        }), /EXECUTION_SNAPSHOT_FROZEN/, `${column} must be read-only after create`);
      }

      // The commit point carries its own half: D15 is a BEFORE trigger, so it cannot see that the
      // action never got published. Install D16 alone to show which object refuses that.
      await installV18(c, ['d16']);
      assert.match(await txn(c, async () => {
        await c.query(CLAIM_ACTION('act1', 'k1'));
        await c.query(MATCHING_SESSION('s1', 'act1'));
      }), /EXECUTION_RESULT_MISMATCH/, 'D16 must refuse a placeholder whose action never became APPLIED');
      assert.match(await txn(c, async () => {
        await c.query(CLAIM_ACTION('act1', 'k1'));
        await c.query(overrideInsert({ permission_mode: `'danger-full-access'` }));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      }), /EXECUTION_RESULT_MISMATCH/, 'D16 must compare the result on the committed state, without D15');

      // Reverse control — v1.7's six-column list, with neither of the two later gates. The review's
      // privilege escalation commits: the session runs with more permission than was ever frozen.
      await installV18(c, []);
      assert.equal(await txn(c, async () => {
        await c.query(CLAIM_ACTION('act1', 'k1'));
        await c.query(overrideInsert({ permission_mode: `'danger-full-access'`, resolution: `'{"who":"forged"}'::jsonb` }));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      }), '', 'PC-CX-44 must reproduce when the three columns are not compared');
      assert.deepEqual((await c.query<{ session_permission: string; frozen_permission: string; resolution_equal: boolean }>(`
        SELECT s.permission_mode AS session_permission,
               a.execution_context->>'permissionMode' AS frozen_permission,
               s.resolution = a.execution_context->'resolution' AS resolution_equal
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id='s1'`)).rows[0],
        { session_permission: 'danger-full-access', frozen_permission: 'read-only', resolution_equal: false },
        'and it leaves the review’s exact committed observation');
    } finally {
      await c.end();
    }
  });

test('PC-CX-45 on real Postgres: the D5 predicate columns cannot be rewritten out of the index',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const dispatch = async (action: string, key: string, session: string): Promise<string> => txn(c, async () => {
        await c.query(CLAIM_ACTION(action, key).replace(/'act1'/, `'${action}'`));
        await c.query(MATCHING_SESSION(session, action));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='${session}' WHERE id='${action}'`);
      });
      const selfExempt = `UPDATE session SET task_id=NULL, dispatch_origin='USER', project_action_id=NULL WHERE id='s1'`;
      const state = async () => (await c.query<{ claims: string; live: string; orphans: string }>(`
        SELECT count(*) FILTER (WHERE task_id='t1' AND deleted_at IS NULL
                                  AND status IN ('PENDING','RUNNING'))::text AS claims,
               count(*) FILTER (WHERE status IN ('PENDING','RUNNING'))::text AS live,
               (SELECT count(*)::text FROM project_action a
                 WHERE a.result_session_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM session x WHERE x.project_action_id = a.id)) AS orphans
          FROM session`)).rows[0];

      await installV18(c);
      assert.equal(await dispatch('act1', 'k1', 's1'), '');
      // Every predicate column of the D5 index, one at a time — that is what D15-f asks for.
      assert.match(await txn(c, async () => { await c.query(selfExempt); }), /EXECUTION_SNAPSHOT_FROZEN/);
      for (const set of ['task_id=NULL', `dispatch_origin='USER'`, `deleted_at=now()`]) {
        const failure = await txn(c, async () => { await c.query(`UPDATE session SET ${set} WHERE id='s1'`); });
        if (set.startsWith('deleted_at')) {
          // `deleted_at` is not in PAC §6's snapshot, so D15 does not freeze it. What must hold is
          // that the row cannot end up both soft-deleted and still claiming — the index sees it.
          assert.equal(failure, '', 'a soft delete is not a snapshot rewrite');
          await c.query(`UPDATE session SET deleted_at=NULL WHERE id='s1'`);
        } else {
          assert.match(failure, /EXECUTION_SNAPSHOT_FROZEN|session_action_only_for_coordinator_chk/,
            `${set} must not be writable on a live COORDINATOR placeholder`);
        }
      }
      assert.match(await dispatch('act2', 'k2', 's2'), /session_task_execution_claim_idx/,
        'the second dispatch must meet the claim, not a free index');
      assert.deepEqual(await state(), { claims: '1', live: '1', orphans: '0' });

      // The contract's own way out of the claim set still works, and then the claim is free.
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET status='COMPLETED' WHERE id='s1'`);
      }), '', 'a status change must still release the claim');
      assert.equal(await dispatch('act2', 'k2', 's2'), '', 'and the next dispatch then commits');

      // Reverse control — v1.7's NEW-only scope on all three gates, and no lineage freeze.
      await installV18(c, ['d11']);
      await c.query(`
        CREATE OR REPLACE FUNCTION session_execution_snapshot_guard() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NEW; END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER session_execution_snapshot_guard BEFORE INSERT OR UPDATE ON session
          FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard();`);
      assert.equal(await dispatch('act1', 'k1', 's1'), '');
      assert.equal(await txn(c, async () => { await c.query(selfExempt); }), '',
        'PC-CX-45 must reproduce: a NEW-only scope lets the row leave every gate');
      assert.equal(await dispatch('act2', 'k2', 's2'), '', 'and the released claim admits a second live execution');
      assert.deepEqual(await state(), { claims: '1', live: '2', orphans: '1' },
        'the review’s exact committed observation: two live rows, one claim, one orphaned action');
    } finally {
      await c.end();
    }
  });

test('PC-CX-46 on real Postgres: the pin ledger is proved in both directions at commit',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const dispatch = async (): Promise<string> => txn(c, async () => {
        await c.query(`DELETE FROM session; DELETE FROM project_action`);
        await c.query(CLAIM_ACTION('act1', 'k1'));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      const observed = async () => (await c.query<{ execution_pin_generation: string; retired_count: string }>(`
        SELECT s.execution_pin_generation::text,
               COALESCE(jsonb_array_length(a.detail->'retiredPins'),0)::text AS retired_count
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id='s1'`)).rows[0];
      const CLAIM = `UPDATE project_action SET detail = detail || jsonb_build_object('claimResolution','model-v1') WHERE id='act1'`;
      const RETIRE = `UPDATE project_action SET detail = detail || jsonb_build_object('retiredPins',
        jsonb_build_array(jsonb_build_object('from','model-v1','to','model-v2','at','${V18_FROZEN_AT}'))) WHERE id='act1'`;

      await installV18(c);
      assert.equal(await dispatch(), '');

      // The legal path, in both statement orders — that is what "deferred" buys.
      assert.equal(await txn(c, async () => {
        await c.query(CLAIM);
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      }), '', 'a first claim that records itself must commit (ledger written first)');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
        await c.query(RETIRE);
      }), '', 'a retiredPin that records itself must commit (session written first)');
      assert.deepEqual(await observed(), { execution_pin_generation: '2', retired_count: '1' });

      // Every disagreement, from whichever side it is written.
      const refusals: [string, string][] = [
        ['generation ahead of the ledger',
          `UPDATE session SET model='model-v3', execution_pin_generation=3 WHERE id='s1'`],
        ['ledger ahead of the generation',
          `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}', (detail->'retiredPins') ||
             jsonb_build_array(jsonb_build_object('from','model-v2','to','model-v3'))) WHERE id='act1'`],
      ];
      for (const [label, sql] of refusals) {
        assert.match(await txn(c, async () => { await c.query(sql); }), /EXECUTION_PIN_LEDGER/, `${label} must be refused`);
      }
      assert.equal(await dispatch(), '');
      assert.match(await txn(c, async () => {
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      }), /EXECUTION_PIN_LEDGER.*no first claim/s, 'a claim with no record must be refused');
      assert.match(await txn(c, async () => { await c.query(CLAIM); }), /EXECUTION_PIN_LEDGER/,
        'a record for a claim the session has not made must be refused');
      assert.deepEqual(await observed(), { execution_pin_generation: '0', retired_count: '0' },
        'and nothing partial is left behind');

      // Reverse control — v1.8's D15 without D16. The generation advances, the ledger stays empty.
      await installV18(c, ['d11', 'd15']);
      assert.equal(await dispatch(), '');
      await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
      assert.deepEqual(await observed(), { execution_pin_generation: '2', retired_count: '0' },
        'PC-CX-46 must reproduce: without the two ledger objects, generation 2 records nothing');
    } finally {
      await c.end();
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Round nine (`PC-CX-47..49`, §27). One question, asked after every earlier round's question has
// been answered: **this gate ran and returned success — what did it prove?** D16 proved a
// `claimResolution` existed and was read as "the session's pin equals the frozen conclusion"; both
// digest columns were declared equal to a recomputation that no database object ever performed;
// the ledger proved a row count and was read as provenance. All three are checked here against a
// real server, because all three are claims about what the database itself refuses.
// ---------------------------------------------------------------------------------------------

const V19_SCHEMA = 'pcc_v19';

function isolated19(body: string): string {
  return `
    DROP SCHEMA IF EXISTS ${V19_SCHEMA} CASCADE;
    CREATE SCHEMA ${V19_SCHEMA};
    SET search_path TO ${V19_SCHEMA};
    ${body}
  `;
}

/** §7.7 D16 ⓪ as v1.9 specifies it: EC6-c's closed shapes, EC6-e's chain, one definition. */
const PIN_FOLD_V19 = `
  CREATE OR REPLACE FUNCTION coordinator_pin_ledger_fold(
    subject text, ctx jsonb, claim jsonb, ledger jsonb, generation bigint) RETURNS jsonb AS $fn$
  DECLARE iso constant text := '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';
          pin jsonb := '{}'::jsonb; part jsonb; entry jsonb; component text;
          moment timestamptz; previous timestamptz; frozen_at timestamptz; k int := 0;
  BEGIN
    ledger := COALESCE(ledger, '[]'::jsonb);
    IF generation = 0 THEN
      IF claim IS NOT NULL OR jsonb_array_length(ledger) <> 0 THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % is at generation 0 but a claim is already recorded', subject;
      END IF;
      RETURN NULL;
    END IF;
    IF claim IS NULL OR jsonb_typeof(claim) <> 'object'
       OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(claim) AS t(k))
          IS DISTINCT FROM ARRAY['at','effort','generation','model'] THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records no first claim of EC6-c''s closed shape', subject;
    END IF;
    previous  := CASE WHEN claim->>'at' ~ iso THEN (claim->>'at')::timestamptz END;
    frozen_at := CASE WHEN ctx->>'snapshotFrozenAt' ~ iso THEN (ctx->>'snapshotFrozenAt')::timestamptz END;
    IF claim->'generation' IS DISTINCT FROM to_jsonb(1) OR previous IS NULL
       OR frozen_at IS NULL OR previous < frozen_at THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records a first claim with no generation 1 or no valid moment', subject;
    END IF;
    FOREACH component IN ARRAY ARRAY['model','effort'] LOOP
      part := claim -> component;
      IF part IS NULL OR jsonb_typeof(part) <> 'object'
         OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(part) AS t(k))
            IS DISTINCT FROM ARRAY['frozen','source','value'] THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records % without frozen/value/source', subject, component;
      END IF;
      IF part->>'frozen' IS DISTINCT FROM ctx->>component THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % claims a frozen % of % while the action froze %',
          subject, component, COALESCE(part->>'frozen','NULL'), COALESCE(ctx->>component,'NULL');
      END IF;
      IF part->>'frozen' = 'DEFERRED_TO_CLAIM' THEN
        IF part->>'source' IS DISTINCT FROM 'RESOLVED_AT_CLAIM'
           OR COALESCE(part->>'value','') = '' OR part->>'value' = 'DEFERRED_TO_CLAIM' THEN
          RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % defers % to claim but records no resolved value', subject, component;
        END IF;
      ELSIF part->>'source' IS DISTINCT FROM 'FROZEN_CONTEXT'
         OR part->>'value' IS DISTINCT FROM part->>'frozen' THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % records a % other than the concrete value the action froze',
          subject, component;
      END IF;
      pin := pin || jsonb_build_object(component, part->>'value');
    END LOOP;
    IF jsonb_array_length(ledger) <> generation - 1 THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % is at generation % but records % retired pins',
        subject, generation, jsonb_array_length(ledger);
    END IF;
    FOR entry IN SELECT t.v FROM jsonb_array_elements(ledger) AS t(v) LOOP
      k := k + 1;
      IF jsonb_typeof(entry) <> 'object'
         OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(entry) AS t(k))
            IS DISTINCT FROM ARRAY['at','component','from','generation','reason','to'] THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % retiredPins[%] is not EC6-c''s closed record', subject, k - 1;
      END IF;
      component := entry->>'component';
      moment    := CASE WHEN entry->>'at' ~ iso THEN (entry->>'at')::timestamptz END;
      IF component IS NULL OR component NOT IN ('model','effort')
         OR entry->>'reason' IS DISTINCT FROM 'RUNTIME_RETIRED'
         OR entry->'generation' IS DISTINCT FROM to_jsonb(k + 1)
         OR moment IS NULL OR moment < previous
         OR entry->>'from' IS DISTINCT FROM pin->>component
         OR COALESCE(entry->>'to','') = '' OR entry->>'to' = entry->>'from' THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % retiredPins[%] does not continue the chain (component=%, from=%, current=%)',
          subject, k - 1, COALESCE(component,'NULL'), COALESCE(entry->>'from','NULL'),
          COALESCE(pin->>COALESCE(component,'model'),'NULL');
      END IF;
      previous := moment;
      pin := pin || jsonb_build_object(component, entry->>'to');
    END LOOP;
    RETURN pin;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** §7.7 D16 as v1.9 specifies it: both directions call the one function and compare the fold. */
const D16_V19 = `
  CREATE OR REPLACE FUNCTION session_execution_result_check() RETURNS trigger AS $fn$
  DECLARE ctx jsonb; action_status text; ledger jsonb; claim jsonb; pin jsonb;
  BEGIN
    IF NEW.task_id IS NULL OR NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT a.execution_context, a.status,
           COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), a.detail -> 'claimResolution'
      INTO ctx, action_status, ledger, claim
      FROM project_action a WHERE a.id = NEW.project_action_id;
    IF ctx IS NULL OR action_status <> 'APPLIED'
       OR NEW.agent_id           IS DISTINCT FROM ctx->>'agentId'
       OR NEW.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
       OR NEW.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR NEW.provider           IS DISTINCT FROM ctx->>'provider'
       OR NEW.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
       OR to_jsonb(NEW.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
       OR NEW.permission_mode    IS DISTINCT FROM ctx->>'permissionMode'
       OR NEW.resolution         IS DISTINCT FROM ctx->'resolution'
       OR NEW.snapshot_frozen_at IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
        NEW.id, NEW.project_action_id;
    END IF;
    pin := coordinator_pin_ledger_fold(NEW.id, ctx, claim, ledger, NEW.execution_pin_generation);
    IF NEW.execution_pin_generation = 0 THEN
      IF NEW.model IS NOT NULL OR NEW.effort IS NOT NULL THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation 0 but already carries a pin', NEW.id;
      END IF;
    ELSIF NEW.model IS DISTINCT FROM pin->>'model' OR NEW.effort IS DISTINCT FROM pin->>'effort' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % runs %/% while action % records %/%',
        NEW.id, COALESCE(NEW.model,'NULL'), COALESCE(NEW.effort,'NULL'), NEW.project_action_id,
        COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION project_action_pin_ledger_check() RETURNS trigger AS $fn$
  DECLARE generation bigint; pinned_model text; pinned_effort text; pin jsonb;
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' OR NEW.result_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT s.execution_pin_generation, s.model, s.effort INTO generation, pinned_model, pinned_effort
      FROM session s WHERE s.id = NEW.result_session_id AND s.dispatch_origin = 'COORDINATOR';
    IF generation IS NULL THEN RETURN NULL; END IF;
    pin := coordinator_pin_ledger_fold(NEW.id, NEW.execution_context, NEW.detail -> 'claimResolution',
             COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb), generation);
    IF generation > 0 AND (pinned_model IS DISTINCT FROM pin->>'model'
                           OR pinned_effort IS DISTINCT FROM pin->>'effort') THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records %/% while session % runs %/%',
        NEW.id, COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL'), NEW.result_session_id,
        COALESCE(pinned_model,'NULL'), COALESCE(pinned_effort,'NULL');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/**
 * §7.7 D17: the canonicalisation, the digest, and the commit-time recomputation of both columns.
 * v1.10 re-reads the final row by its stable key (D9-f) and proves EC2-b's closed shape (EC2-b2)
 * instead of v1.9's `ctx->>'model' IS NULL OR ctx->>'effort' IS NULL`.
 */
const D17_V19 = `
  CREATE OR REPLACE FUNCTION coordinator_canonical_json(value jsonb) RETURNS text AS $fn$
  DECLARE parts text[] := ARRAY[]::text[]; k text; item jsonb;
  BEGIN
    IF value IS NULL THEN RETURN 'null'; END IF;
    IF jsonb_typeof(value) = 'object' THEN
      FOR k IN SELECT t.k FROM jsonb_object_keys(value) AS t(k) ORDER BY t.k COLLATE "C" LOOP
        parts := parts || (to_jsonb(k)::text || ':' || coordinator_canonical_json(value -> k));
      END LOOP;
      RETURN '{' || array_to_string(parts, ',') || '}';
    ELSIF jsonb_typeof(value) = 'array' THEN
      FOR item IN SELECT t.v FROM jsonb_array_elements(value) AS t(v) LOOP
        parts := parts || coordinator_canonical_json(item);
      END LOOP;
      RETURN '[' || array_to_string(parts, ',') || ']';
    END IF;
    RETURN value::text;
  END;
  $fn$ LANGUAGE plpgsql IMMUTABLE;

  CREATE OR REPLACE FUNCTION coordinator_execution_digest(value jsonb) RETURNS text AS $fn$
    SELECT encode(sha256(convert_to(coordinator_canonical_json(value), 'UTF8')), 'hex');
  $fn$ LANGUAGE sql IMMUTABLE;

  CREATE OR REPLACE FUNCTION project_action_execution_digest_check() RETURNS trigger AS $fn$
  DECLARE a project_action%ROWTYPE; ctx jsonb; auth jsonb;
          components constant text[] := ARRAY['resolvedAgentId','projectMemberId','taskId','taskAssigneeAgentId',
            'providerSlug','model','workspaceId','runnerId','coordinatorWorkspaceId'];
  BEGIN
    SELECT * INTO a FROM project_action WHERE id = NEW.id;
    IF NOT FOUND OR a.type <> 'DISPATCH_TASK' OR a.execution_context IS NULL THEN RETURN NULL; END IF;
    ctx  := a.execution_context;
    auth := ctx -> 'authorization';
    IF auth IS NULL OR jsonb_typeof(auth) <> 'object'
       OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(auth) AS t(k))
          IS DISTINCT FROM ARRAY(SELECT c FROM unnest(components) c ORDER BY c COLLATE "C") THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % does not carry EC2-a''s nine authorization components', a.id;
    END IF;
    PERFORM coordinator_execution_result_shape(a.id, ctx);
    IF a.execution_context_digest IS DISTINCT FROM coordinator_execution_digest(auth) THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores an execution_context_digest that is not the digest of its authorization half',
        a.id;
    END IF;
    IF a.execution_result_digest IS DISTINCT FROM coordinator_execution_digest(ctx - 'authorization') THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores an execution_result_digest that is not the digest of its result half',
        a.id;
    END IF;
    IF auth->>'resolvedAgentId' IS DISTINCT FROM ctx->>'agentId'
       OR auth->>'workspaceId'  IS DISTINCT FROM ctx->>'workspaceId'
       OR auth->>'runnerId'     IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR auth->>'providerSlug' IS DISTINCT FROM ctx->>'provider'
       OR auth->>'model'        IS DISTINCT FROM ctx->>'model'
       OR (a.subject_type = 'TASK' AND auth->>'taskId' IS DISTINCT FROM a.subject_id) THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % authorization and result halves describe two different dispatches',
        a.id;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** §7.7 D17 ⓪ as v1.10 specifies it: EC2-b's result half is a closed key-and-type table (EC2-b2). */
const RESULT_SHAPE_V110 = `
  CREATE OR REPLACE FUNCTION coordinator_execution_result_shape(subject text, ctx jsonb) RETURNS jsonb AS $fn$
  DECLARE iso constant text := '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$';
          shape constant jsonb := jsonb_build_object(
            'agentId','string', 'workspaceId','string', 'assignedRunnerId','string',
            'provider','string', 'providerBuiltin','boolean', 'requiredCapabilities','array',
            'permissionMode','string', 'snapshotFrozenAt','string', 'resolution','object',
            'model','string', 'effort','string');
          result jsonb; offending text; component text;
  BEGIN
    IF ctx IS NULL OR jsonb_typeof(ctx) <> 'object' THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % carries no execution context object', subject;
    END IF;
    result := ctx - 'authorization';
    SELECT string_agg(t.k, ',' ORDER BY t.k COLLATE "C") INTO offending
      FROM (SELECT jsonb_object_keys(result) AS k UNION SELECT jsonb_object_keys(shape)) t
     WHERE jsonb_typeof(result -> t.k) IS DISTINCT FROM (shape ->> t.k);
    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % result half is not EC2-b''s closed eleven-key shape (offending: %)',
        subject, offending;
    END IF;
    FOREACH component IN ARRAY ARRAY['agentId','workspaceId','assignedRunnerId','provider',
                                     'permissionMode','snapshotFrozenAt','model','effort'] LOOP
      IF result ->> component = '' THEN
        RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % freezes an empty % — an empty string is not a conclusion',
          subject, component;
      END IF;
    END LOOP;
    IF result ->> 'snapshotFrozenAt' !~ iso THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % freezes no ISO-8601 UTC snapshotFrozenAt', subject;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(result -> 'requiredCapabilities') AS t(v)
                WHERE jsonb_typeof(t.v) <> 'string' OR (t.v #>> '{}') = '') THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % freezes a requiredCapabilities that is not a list of nonempty strings',
        subject;
    END IF;
    IF (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(result -> 'resolution') AS t(k))
       IS DISTINCT FROM ARRAY['where','who','with'] THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % resolution is not PAC 7.5''s who/with/where', subject;
    END IF;
    RETURN result;
  END;
  $fn$ LANGUAGE plpgsql IMMUTABLE;
`;

/**
 * §7.7 D17 ⓪ as v1.11 specifies it (PC-CX-53). The eleven-key table is v1.10's; what changed is the
 * `resolution` row: v1.10 compared it against `ARRAY['where','who','with']`, and PAC §7.5's structure
 * starts with `v` — a key the same PAC section says "must be written". A conforming resolution was
 * therefore refused and a versionless one passed, which is why this is the only round whose closing
 * criterion is a *positive* dispatch rather than a refusal (EC2-b3 · D17-e).
 */
const V111_RESOLUTION_PREDICATE = `    SELECT string_agg(t.k, ',' ORDER BY t.k COLLATE "C") INTO offending
      FROM (SELECT jsonb_object_keys(result -> 'resolution') AS k
             UNION SELECT jsonb_object_keys(resolution_shape)) t
     WHERE jsonb_typeof(result -> 'resolution' -> t.k) IS DISTINCT FROM (resolution_shape ->> t.k);
    IF offending IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % resolution is not PAC 7.5''s closed v/who/with/where (offending: %)',
        subject, offending;
    END IF;
    version := result #>> '{resolution,v}';
    IF version !~ '^\\d+$' OR version::numeric < 1 THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % freezes a PAC 7.5 resolution version of % — not a positive integer',
        subject, version;
    END IF;
`;

const RESULT_SHAPE_V111 = RESULT_SHAPE_V110
  // A string replacement would read the `$'` inside `'^\\d+$'` as a substitution pattern, so both
  // replacements are functions. That is the same footgun in JavaScript that 22023 is in plpgsql.
  .replace(
    `    IF (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(result -> 'resolution') AS t(k))
       IS DISTINCT FROM ARRAY['where','who','with'] THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_SHAPE: % resolution is not PAC 7.5''s who/with/where', subject;
    END IF;
`,
    () => V111_RESOLUTION_PREDICATE)
  .replace(
    `          result jsonb; offending text; component text;`,
    () => `          resolution_shape constant jsonb := jsonb_build_object(
            'v','number', 'who','object', 'with','object', 'where','object');
          result jsonb; offending text; component text; version text;`);

/** §7.7 D16 ⓪ as v1.11 specifies it: the ledger's top-level type is proved before it is folded. */
const PIN_FOLD_V111 = PIN_FOLD_V19.replace(
  `    ledger := COALESCE(ledger, '[]'::jsonb);
`,
  `    ledger := COALESCE(ledger, '[]'::jsonb);
    IF jsonb_typeof(ledger) <> 'array' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: % carries a retiredPins of jsonb type % — the ledger is an array',
        subject, jsonb_typeof(ledger);
    END IF;
`);

/**
 * §7.7 D18 as v1.11 specifies it (PC-CX-55). Two things move, and both are one line: the type test
 * runs *before* any `jsonb_array_*` (v1.10 ran `jsonb_array_elements` first, and Postgres raises a
 * native 22023 on an object, so the test below it was unreachable), and the trigger observes INSERT
 * as well (v1.10 observed UPDATE only, so a malformed initial ledger had no object watching it).
 * `OLD` is only read after `TG_OP = 'UPDATE'`: on INSERT it is unassigned and reading it raises.
 */
const D18_V111 = `
  CREATE OR REPLACE FUNCTION project_action_result_ledger_mutator() RETURNS trigger AS $fn$
  DECLARE new_ledger jsonb := COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb);
          old_ledger jsonb; kept jsonb;
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' THEN RETURN NEW; END IF;
    IF jsonb_typeof(new_ledger) <> 'array' THEN
      IF TG_OP = 'UPDATE' AND new_ledger = COALESCE(OLD.detail -> 'retiredPins', '[]'::jsonb) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % writes a retiredPins of jsonb type % — the ledger is an array (owner=SYSTEM; recovery: write an array, or drop the key)',
        NEW.id, jsonb_typeof(new_ledger);
    END IF;
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    IF OLD.result_session_id IS NOT NULL
       AND NEW.result_session_id IS DISTINCT FROM OLD.result_session_id THEN
      RAISE EXCEPTION 'ACTION_RESULT_LINK_FROZEN: action % cannot detach or repoint its result session (% -> %)',
        NEW.id, OLD.result_session_id, COALESCE(NEW.result_session_id, 'NULL');
    END IF;
    IF OLD.detail ? 'claimResolution'
       AND NEW.detail -> 'claimResolution' IS DISTINCT FROM OLD.detail -> 'claimResolution' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % rewrites a claimResolution that is already recorded', NEW.id;
    END IF;
    old_ledger := COALESCE(OLD.detail -> 'retiredPins', '[]'::jsonb);
    IF jsonb_typeof(old_ledger) <> 'array' THEN RETURN NEW; END IF;
    SELECT jsonb_agg(t.v ORDER BY t.i) INTO kept
      FROM jsonb_array_elements(new_ledger) WITH ORDINALITY AS t(v, i)
     WHERE t.i <= jsonb_array_length(old_ledger);
    IF jsonb_array_length(new_ledger) < jsonb_array_length(old_ledger)
       OR (jsonb_array_length(old_ledger) > 0 AND kept IS DISTINCT FROM old_ledger) THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % rewrites or truncates a retired pin that is already recorded (% -> %)',
        NEW.id, jsonb_array_length(old_ledger), jsonb_array_length(new_ledger);
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/**
 * §7.7 D18 as v1.12 specifies it (PC-CX-57). Three lines move, and they are the whole finding: the
 * legacy-ledger outlet records a flag instead of returning out of the function, so ① (the published
 * result link) and ② (the recorded first claim) run on a malformed row exactly as they run on a
 * legal one, and the only thing skipped is ③ — the array expansion that cannot run on a non-array.
 */
const D18_V112 = D18_V111
  .replace('          old_ledger jsonb; kept jsonb;',
    '          old_ledger jsonb; kept jsonb; ledger_untouched boolean := false;')
  .replace(`        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % writes a retiredPins of jsonb type % — the ledger is an array (owner=SYSTEM; recovery: write an array, or drop the key)',
        NEW.id, jsonb_typeof(new_ledger);`,
  `        ledger_untouched := true;
      ELSE
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % writes a retiredPins of jsonb type % — the ledger is an array (owner=SYSTEM; recovery: write an array, or drop the key)',
          NEW.id, jsonb_typeof(new_ledger);
      END IF;`)
  .replace(`    old_ledger := COALESCE(OLD.detail -> 'retiredPins', '[]'::jsonb);`,
    `    IF ledger_untouched THEN RETURN NEW; END IF;
    old_ledger := COALESCE(OLD.detail -> 'retiredPins', '[]'::jsonb);`);

/**
 * §7.7 D19 as v1.11 specifies it (PC-CX-54). Two objects for one sentence, the same split D18-d and
 * D16-d already use: the foreign key makes an orphan unwritable for any binary, and the BEFORE
 * DELETE trigger turns the refusal into this contract's own code with an owner and a recovery.
 */
const D19_V111 = `
  ALTER TABLE project_action
    ADD CONSTRAINT project_action_result_session_fk
    FOREIGN KEY (result_session_id) REFERENCES session(id) ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE OR REPLACE FUNCTION session_result_link_delete_guard() RETURNS trigger AS $fn$
  DECLARE referring text; referring_status text;
  BEGIN
    SELECT a.id, a.status INTO referring, referring_status
      FROM project_action a WHERE a.result_session_id = OLD.id ORDER BY a.id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'SESSION_RESULT_LINK_REFERENCED: session % is the published result of % action % and cannot be purged (owner=USER, recovery=HUMAN: soft-delete it, or delete the project so §2.4 takes the ledger with it)',
        OLD.id, referring_status, referring;
    END IF;
    RETURN OLD;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE TRIGGER session_result_link_delete_guard
    BEFORE DELETE ON session
    FOR EACH ROW EXECUTE FUNCTION session_result_link_delete_guard();
`;

/** §7.7 D15 as v1.10 specifies it: v1.8's body, plus EC2-b2 proved before the nine equalities. */
const D15_V110 = D15_V18.replace(
  `      SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;\n`,
  `      SELECT a.execution_context INTO ctx FROM project_action a WHERE a.id = NEW.project_action_id;\n` +
  `      PERFORM coordinator_execution_result_shape(NEW.id, ctx);\n`);

/** §7.7 D16 as v1.10 specifies it: stable-key re-read (D9-f), the bidirectional link (D16-g), EC2-b2. */
const D16_V110 = `
  CREATE OR REPLACE FUNCTION session_execution_result_check() RETURNS trigger AS $fn$
  DECLARE s session%ROWTYPE; ctx jsonb; action_status text; linked text; ledger jsonb; claim jsonb; pin jsonb;
  BEGIN
    SELECT * INTO s FROM session WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF s.task_id IS NULL OR s.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
    SELECT a.execution_context, a.status, a.result_session_id,
           COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), a.detail -> 'claimResolution'
      INTO ctx, action_status, linked, ledger, claim
      FROM project_action a WHERE a.id = s.project_action_id;
    IF ctx IS NULL OR action_status <> 'APPLIED' THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
        s.id, s.project_action_id;
    END IF;
    IF linked IS DISTINCT FROM s.id THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_LINK: session % points at action % while that action points at %',
        s.id, s.project_action_id, COALESCE(linked, 'NULL');
    END IF;
    PERFORM coordinator_execution_result_shape(s.id, ctx);
    IF s.agent_id              IS DISTINCT FROM ctx->>'agentId'
       OR s.workspace_id       IS DISTINCT FROM ctx->>'workspaceId'
       OR s.assigned_runner_id IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR s.provider           IS DISTINCT FROM ctx->>'provider'
       OR s.provider_builtin   IS DISTINCT FROM (ctx->>'providerBuiltin')::boolean
       OR to_jsonb(s.required_capabilities) IS DISTINCT FROM ctx->'requiredCapabilities'
       OR s.permission_mode    IS DISTINCT FROM ctx->>'permissionMode'
       OR s.resolution         IS DISTINCT FROM ctx->'resolution'
       OR s.snapshot_frozen_at IS DISTINCT FROM (ctx->>'snapshotFrozenAt')::timestamptz THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_MISMATCH: session % is not the frozen result of action %',
        s.id, s.project_action_id;
    END IF;
    pin := coordinator_pin_ledger_fold(s.id, ctx, claim, ledger, s.execution_pin_generation);
    IF s.execution_pin_generation = 0 THEN
      IF s.model IS NOT NULL OR s.effort IS NOT NULL THEN
        RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % is at generation 0 but already carries a pin', s.id;
      END IF;
    ELSIF s.model IS DISTINCT FROM pin->>'model' OR s.effort IS DISTINCT FROM pin->>'effort' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: session % runs %/% while action % records %/%',
        s.id, COALESCE(s.model,'NULL'), COALESCE(s.effort,'NULL'), s.project_action_id,
        COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION project_action_pin_ledger_check() RETURNS trigger AS $fn$
  DECLARE a project_action%ROWTYPE; s session%ROWTYPE; pin jsonb;
  BEGIN
    SELECT * INTO a FROM project_action WHERE id = NEW.id;
    IF NOT FOUND OR a.type <> 'DISPATCH_TASK' THEN RETURN NULL; END IF;
    IF a.status <> 'APPLIED' AND a.result_session_id IS NULL THEN RETURN NULL; END IF;
    IF a.status <> 'APPLIED' OR a.result_session_id IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_LINK: dispatch % is % and its result session is %',
        a.id, a.status, COALESCE(a.result_session_id, 'NULL');
    END IF;
    SELECT * INTO s FROM session WHERE id = a.result_session_id;
    IF NOT FOUND OR s.dispatch_origin <> 'COORDINATOR' OR s.project_action_id IS DISTINCT FROM a.id THEN
      RAISE EXCEPTION 'EXECUTION_RESULT_LINK: applied dispatch % and session % do not point at each other',
        a.id, a.result_session_id;
    END IF;
    PERFORM coordinator_execution_result_shape(a.id, a.execution_context);
    pin := coordinator_pin_ledger_fold(a.id, a.execution_context, a.detail -> 'claimResolution',
             COALESCE(a.detail -> 'retiredPins', '[]'::jsonb), s.execution_pin_generation);
    IF s.execution_pin_generation > 0 AND (s.model IS DISTINCT FROM pin->>'model'
                                           OR s.effort IS DISTINCT FROM pin->>'effort') THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % records %/% while session % runs %/%',
        a.id, COALESCE(pin->>'model','NULL'), COALESCE(pin->>'effort','NULL'), a.result_session_id,
        COALESCE(s.model,'NULL'), COALESCE(s.effort,'NULL');
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** §7.7 D18 as v1.10 specifies it: the two writable columns each move in exactly one direction. */
const D18_V110 = `
  CREATE OR REPLACE FUNCTION project_action_result_ledger_mutator() RETURNS trigger AS $fn$
  DECLARE old_ledger jsonb := COALESCE(OLD.detail -> 'retiredPins', '[]'::jsonb);
          new_ledger jsonb := COALESCE(NEW.detail -> 'retiredPins', '[]'::jsonb);
          kept jsonb;
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' THEN RETURN NEW; END IF;
    IF OLD.result_session_id IS NOT NULL
       AND NEW.result_session_id IS DISTINCT FROM OLD.result_session_id THEN
      RAISE EXCEPTION 'ACTION_RESULT_LINK_FROZEN: action % cannot detach or repoint its result session (% -> %)',
        OLD.id, OLD.result_session_id, COALESCE(NEW.result_session_id, 'NULL');
    END IF;
    IF OLD.detail ? 'claimResolution'
       AND NEW.detail -> 'claimResolution' IS DISTINCT FROM OLD.detail -> 'claimResolution' THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % rewrites a claimResolution that is already recorded', OLD.id;
    END IF;
    SELECT jsonb_agg(t.v ORDER BY t.i) INTO kept
      FROM jsonb_array_elements(new_ledger) WITH ORDINALITY AS t(v, i)
     WHERE t.i <= jsonb_array_length(old_ledger);
    IF jsonb_typeof(new_ledger) <> 'array'
       OR jsonb_array_length(new_ledger) < jsonb_array_length(old_ledger)
       OR (jsonb_array_length(old_ledger) > 0 AND kept IS DISTINCT FROM old_ledger) THEN
      RAISE EXCEPTION 'EXECUTION_PIN_LEDGER: action % rewrites or truncates a retired pin that is already recorded (% -> %)',
        OLD.id, jsonb_array_length(old_ledger), jsonb_typeof(new_ledger);
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
`;

/** §7.7 D17 as v1.9 specified it: the queued NEW tuple, and `IS NULL` as the whole conclusion test. */
const D17_CHECK_V19 = `
  CREATE OR REPLACE FUNCTION project_action_execution_digest_check() RETURNS trigger AS $fn$
  DECLARE ctx jsonb; auth jsonb;
          components constant text[] := ARRAY['resolvedAgentId','projectMemberId','taskId','taskAssigneeAgentId',
            'providerSlug','model','workspaceId','runnerId','coordinatorWorkspaceId'];
  BEGIN
    IF NEW.type <> 'DISPATCH_TASK' OR NEW.execution_context IS NULL THEN RETURN NULL; END IF;
    ctx  := NEW.execution_context;
    auth := ctx -> 'authorization';
    IF auth IS NULL OR jsonb_typeof(auth) <> 'object'
       OR (SELECT array_agg(t.k ORDER BY t.k COLLATE "C") FROM jsonb_object_keys(auth) AS t(k))
          IS DISTINCT FROM ARRAY(SELECT c FROM unnest(components) c ORDER BY c COLLATE "C") THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % does not carry EC2-a''s nine authorization components', NEW.id;
    END IF;
    IF ctx->>'model' IS NULL OR ctx->>'effort' IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % freezes no model/effort conclusion', NEW.id;
    END IF;
    IF NEW.execution_context_digest IS DISTINCT FROM coordinator_execution_digest(auth) THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores an execution_context_digest that is not the digest of its authorization half',
        NEW.id;
    END IF;
    IF NEW.execution_result_digest IS DISTINCT FROM coordinator_execution_digest(ctx - 'authorization') THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % stores an execution_result_digest that is not the digest of its result half',
        NEW.id;
    END IF;
    IF auth->>'resolvedAgentId' IS DISTINCT FROM ctx->>'agentId'
       OR auth->>'workspaceId'  IS DISTINCT FROM ctx->>'workspaceId'
       OR auth->>'runnerId'     IS DISTINCT FROM ctx->>'assignedRunnerId'
       OR auth->>'providerSlug' IS DISTINCT FROM ctx->>'provider'
       OR auth->>'model'        IS DISTINCT FROM ctx->>'model'
       OR (NEW.subject_type = 'TASK' AND auth->>'taskId' IS DISTINCT FROM NEW.subject_id) THEN
      RAISE EXCEPTION 'EXECUTION_DIGEST_MISMATCH: action % authorization and result halves describe two different dispatches',
        NEW.id;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
`;

const SCHEMA_V19 = isolated19(V18_TABLES);

const V19_AUTH = `'{"resolvedAgentId":"a1","projectMemberId":"m1","taskId":"t1","taskAssigneeAgentId":"a1",` +
  `"providerSlug":"claude","model":%MODEL%,"workspaceId":"w1","runnerId":"r1","coordinatorWorkspaceId":null}'::jsonb`;
const V19_RESULT = `'{"agentId":"a1","workspaceId":"w1","assignedRunnerId":"r1","provider":"claude",` +
  `"providerBuiltin":true,"requiredCapabilities":["linux"],"permissionMode":"read-only",` +
  `"resolution":{"v":1,"who":{"source":"task"},"with":{"source":"agent"},"where":{"source":"workspace"}},"snapshotFrozenAt":"${V18_FROZEN_AT}",` +
  `"model":%MODEL%,"effort":%EFFORT%}'::jsonb`;

/** The frozen context for one dispatch. `model`/`effort` are the EC2-b part ② conclusion (EC6-c). */
function context19(model = '"model-v1"', effort = '"high"'): string {
  const auth = V19_AUTH.replace('%MODEL%', model);
  const result = V19_RESULT.replace('%MODEL%', model).replace('%EFFORT%', effort);
  return `(${result} || jsonb_build_object('authorization', ${auth}))`;
}

/** Insert a CLAIMED dispatch whose digests are computed by the database itself, unless forged. */
function claimAction19(id: string, key: string, options: {
  ctx?: string; contextDigest?: string; resultDigest?: string;
} = {}): string {
  const ctx = options.ctx ?? context19();
  const contextDigest = options.contextDigest ?? `coordinator_execution_digest(${ctx}->'authorization')`;
  const resultDigest = options.resultDigest ?? `coordinator_execution_digest(${ctx} - 'authorization')`;
  return `
    INSERT INTO project_action (id,idempotency_key,project_id,type,status,subject_type,subject_id,
      fencing_token,result_session_id,detail,execution_context,execution_context_digest,
      execution_result_digest,reason_code,refusal_code)
    VALUES ('${id}','${key}','p1','DISPATCH_TASK','CLAIMED','TASK','t1',1,NULL,'{}'::jsonb,
      ${ctx},${contextDigest},${resultDigest},'MANUAL',NULL)`;
}

/**
 * Install the current (v1.10) objects. Each option swaps in the shape a review reproduced, so every
 * fix stays falsifiable: `ledger: 'v18'` is v1.8's cardinality-only D16 (PC-CX-47/49), `digest: false`
 * drops D17 (PC-CX-48), `ledger: 'v19'` is v1.9's D16 — the one that reads its queued NEW tuple and
 * early-exits on a null link (PC-CX-50/51) — and `mutator: false` drops D18 (PC-CX-50).
 */
async function installV19(c: Client, options: {
  ledger?: 'v18' | 'v19' | 'v110'; digest?: boolean; mutator?: boolean;
  shape?: 'v110' | 'v111'; mutatorEvents?: 'update' | 'insert-update'; sessionDelete?: boolean;
  ledgerOutlet?: 'v111' | 'v112';
} = {}): Promise<void> {
  const { ledger = 'v110', digest = true, mutator = ledger === 'v110', ledgerOutlet = 'v112',
    // v1.11 defaults (PC-CX-53/54/55). Each stays switchable so every fix keeps a reverse control:
    // `shape: 'v110'` is the exact-key resolution predicate PAC 7.5 has no legal intersection with,
    // `mutatorEvents: 'update'` is D18 without an INSERT event, `sessionDelete: false` drops D19.
    // v1.12 (PC-CX-57): `ledgerOutlet: 'v111'` is the ⓪ exception written as `RETURN NEW`, which
    // leaves the whole mutator and takes ① and ② with it.
    shape = 'v111', mutatorEvents = 'insert-update', sessionDelete = true } = options;
  await c.query(SCHEMA_V19);
  await c.query(shape === 'v111' ? RESULT_SHAPE_V111 : RESULT_SHAPE_V110);  // D17's ⓪, called from D15, D16 and D17 alike
  await c.query(D17_V19);                      // the digest functions are fixture plumbing as well
  if (ledger !== 'v110') await c.query(D17_CHECK_V19);   // reverse control: v1.9's D17 body
  await c.query(D11_V18);
  await c.query(`CREATE TRIGGER project_action_applied_immutable_guard BEFORE UPDATE ON project_action
                   FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard()`);
  await c.query(ledger === 'v110' ? D15_V110 : D15_V18);
  await c.query(`CREATE TRIGGER session_execution_snapshot_guard BEFORE INSERT OR UPDATE ON session
                   FOR EACH ROW EXECUTE FUNCTION session_execution_snapshot_guard()`);
  if (mutator) {
    await c.query(mutatorEvents === 'insert-update'
      ? (ledgerOutlet === 'v112' ? D18_V112 : D18_V111)
      : D18_V110);
    await c.query(`CREATE TRIGGER project_action_result_ledger_mutator
                     BEFORE ${mutatorEvents === 'insert-update' ? 'INSERT OR UPDATE' : 'UPDATE'} ON project_action
                     FOR EACH ROW EXECUTE FUNCTION project_action_result_ledger_mutator()`);
  }
  if (ledger === 'v18') await c.query(D16_V18);
  else await c.query((ledger === 'v110' ? PIN_FOLD_V111 : PIN_FOLD_V19) + (ledger === 'v110' ? D16_V110 : D16_V19));
  await c.query(`CREATE CONSTRAINT TRIGGER session_execution_result_check
                   AFTER INSERT OR UPDATE ON session DEFERRABLE INITIALLY DEFERRED
                   FOR EACH ROW EXECUTE FUNCTION session_execution_result_check()`);
  // v1.10 (PC-CX-50): no `UPDATE OF` column list — a publish that only writes `status` must fire it.
  await c.query(ledger === 'v110'
    ? `CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
         AFTER INSERT OR UPDATE ON project_action
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check()`
    : `CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
         AFTER INSERT OR UPDATE OF detail, result_session_id ON project_action
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check()`);
  if (digest) {
    await c.query(`CREATE CONSTRAINT TRIGGER project_action_execution_digest_check
                     AFTER INSERT OR UPDATE ON project_action DEFERRABLE INITIALLY DEFERRED
                     FOR EACH ROW EXECUTE FUNCTION project_action_execution_digest_check()`);
  }
  // v1.11 (PC-CX-54): the third verb. Everything above observes INSERT and UPDATE only, and
  // "the session it points at is missing" is only reachable through DELETE.
  if (sessionDelete) await c.query(D19_V111);
}

const CLAIM_AT_19 = '2026-08-19T00:01:00.000Z';
const RETIRE_AT_19 = '2026-08-19T00:02:00.000Z';

/** §7.4 EC6-c's claimResolution, as SQL. */
function claimRecord(model: string, effort: string, at = CLAIM_AT_19): string {
  return `jsonb_build_object('claimResolution', jsonb_build_object(
    'generation', 1, 'at', '${at}', 'model', ${model}::jsonb, 'effort', ${effort}::jsonb))`;
}
function part(frozen: string, value: string, source: string): string {
  return `'{"frozen":"${frozen}","value":"${value}","source":"${source}"}'`;
}

test('PC-CX-47 on real Postgres: the first claim is bound to the frozen conclusion field by field',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const dispatch = async (ctx: string): Promise<string> => txn(c, async () => {
        // v1.11 (PC-CX-54): the result link is a real FK now, so a fixture reset cannot delete the two
        // tables in sequence. TRUNCATE takes both at once and fires no row triggers.
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx }));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      const observed = async () => (await c.query<{ model: string | null; effort: string | null; claim: string | null }>(`
        SELECT s.model, s.effort, (a.detail->'claimResolution')::text AS claim
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id='s1'`)).rows[0];
      /** One transaction: the session takes a pin, and the action records the claim. */
      const claim = async (model: string, effort: string, record: string | null): Promise<string> => txn(c, async () => {
        await c.query(`UPDATE session SET model=${model}, effort=${effort}, execution_pin_generation=1 WHERE id='s1'`);
        if (record !== null) await c.query(`UPDATE project_action SET detail = detail || ${record} WHERE id='act1'`);
      });

      await installV19(c);
      assert.equal(await dispatch(context19()), '', 'the concrete dispatch must commit');

      // The legal concrete path: the pin is the frozen value, and the record says so field by field.
      assert.equal(await claim(`'model-v1'`, `'high'`,
        claimRecord(part('model-v1', 'model-v1', 'FROZEN_CONTEXT'), part('high', 'high', 'FROZEN_CONTEXT'))), '',
        'a first claim of the frozen conclusion must commit');
      assert.deepEqual({ ...await observed(), claim: undefined },
        { model: 'model-v1', effort: 'high', claim: undefined });

      // The review's transaction, verbatim: an empty record and a pin the action never froze.
      assert.equal(await dispatch(context19()), '');
      assert.match(await claim(`'model-evil'`, `'low'`, `jsonb_build_object('claimResolution', '{}'::jsonb)`),
        /EXECUTION_PIN_LEDGER/, 'PC-CX-47: an empty claimResolution must not admit an arbitrary pin');
      assert.deepEqual(await observed(), { model: null, effort: null, claim: null }, 'and nothing is left behind');

      // Every way of getting the two apart, one at a time.
      const refusals: [string, () => Promise<string>][] = [
        ['a complete record whose session ran something else',
          () => claim(`'model-evil'`, `'high'`,
            claimRecord(part('model-v1', 'model-v1', 'FROZEN_CONTEXT'), part('high', 'high', 'FROZEN_CONTEXT')))],
        ['a record that rewrites the frozen value into the deferral sentinel',
          () => claim(`'model-evil'`, `'high'`,
            claimRecord(part('DEFERRED_TO_CLAIM', 'model-evil', 'RESOLVED_AT_CLAIM'), part('high', 'high', 'FROZEN_CONTEXT')))],
        ['a concrete record whose value is not the frozen one',
          () => claim(`'model-evil'`, `'high'`,
            claimRecord(part('model-v1', 'model-evil', 'FROZEN_CONTEXT'), part('high', 'high', 'FROZEN_CONTEXT')))],
        ['a pin taken with no record at all',
          () => claim(`'model-v1'`, `'high'`, null)],
      ];
      for (const [label, run] of refusals) {
        assert.equal(await dispatch(context19()), '');
        assert.match(await run(), /EXECUTION_PIN_LEDGER/, `${label} must be refused`);
      }

      // The deferred branch: PAC §7.2 leaves the model to the runtime, so the claim must record
      // what it actually resolved — in the same transaction, or it does not commit at all.
      const deferred = context19('"DEFERRED_TO_CLAIM"');
      assert.equal(await dispatch(deferred), '', 'the deferred dispatch must commit');
      assert.equal(await claim(`'runtime-default-v3'`, `'high'`,
        claimRecord(part('DEFERRED_TO_CLAIM', 'runtime-default-v3', 'RESOLVED_AT_CLAIM'),
          part('high', 'high', 'FROZEN_CONTEXT'))), '',
        'a deferred claim that records what it resolved must commit');
      assert.equal((await observed()).model, 'runtime-default-v3');

      assert.equal(await dispatch(deferred), '');
      assert.match(await claim(`'runtime-default-v3'`, `'high'`,
        `jsonb_build_object('claimResolution', jsonb_build_object('generation',1,'at','${CLAIM_AT_19}',
          'model','{"frozen":"DEFERRED_TO_CLAIM","value":"DEFERRED_TO_CLAIM","source":"RESOLVED_AT_CLAIM"}'::jsonb,
          'effort',${part('high', 'high', 'FROZEN_CONTEXT')}::jsonb))`),
        /EXECUTION_PIN_LEDGER/, 'a deferred claim that records the sentinel instead of a value must be refused');

      // Reverse control — v1.8's D16. The same transaction commits, and the committed state is
      // exactly the one the review published.
      await installV19(c, { ledger: 'v18' });
      assert.equal(await dispatch(context19()), '');
      assert.equal(await claim(`'model-evil'`, `'low'`, `jsonb_build_object('claimResolution', '{}'::jsonb)`), '',
        'PC-CX-47 must reproduce: v1.8 admits a pin that contradicts the frozen conclusion');
      assert.deepEqual(await observed(), { model: 'model-evil', effort: 'low', claim: '{}' });
    } finally {
      await c.end();
    }
  });

test('PC-CX-48 on real Postgres: a forged digest cannot be committed, and canonicalisation ignores key order',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await installV19(c);

      // The canonicalisation is the whole definition: same value, different key order, one form.
      const canonical = async (json: string): Promise<string> =>
        (await c.query<{ t: string }>(`SELECT coordinator_canonical_json('${json}'::jsonb) AS t`)).rows[0].t;
      assert.equal(await canonical('{"b":1,"a":{"d":[2,1],"c":null}}'), '{"a":{"c":null,"d":[2,1]},"b":1}');
      assert.equal(await canonical('{"a":{"c":null,"d":[2,1]},"b":1}'), await canonical('{"b":1,"a":{"d":[2,1],"c":null}}'),
        'canonical form must not depend on the order the keys were written in');
      assert.notEqual(await canonical('{"a":[1,2]}'), await canonical('{"a":[2,1]}'),
        'array order is data, not formatting');
      const digestOf = async (json: string): Promise<string> =>
        (await c.query<{ d: string }>(`SELECT coordinator_execution_digest('${json}'::jsonb) AS d`)).rows[0].d;
      assert.equal((await digestOf('{"a":1}')).length, 64, 'the digest must be a sha256 hex string');
      assert.notEqual(await digestOf('{"effort":"high"}'), await digestOf('{"effort":"low"}'),
        'a component that moves must move the digest');

      // §12.1 G5 ⑩/⑪: the volatility and the deferral are the observable form of both rules.
      const volatility = await c.query<{ proname: string; provolatile: string }>(`
        SELECT proname, provolatile FROM pg_proc
         WHERE pronamespace = to_regnamespace(current_schema())
           AND proname IN ('coordinator_canonical_json','coordinator_execution_digest') ORDER BY proname`);
      assert.deepEqual(volatility.rows, [
        { proname: 'coordinator_canonical_json', provolatile: 'i' },
        { proname: 'coordinator_execution_digest', provolatile: 'i' },
      ], 'both canonicalisation functions must be IMMUTABLE');
      const deferred = await c.query<{ tgdeferrable: boolean; tginitdeferred: boolean }>(`
        SELECT t.tgdeferrable, t.tginitdeferred FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE t.tgname = 'project_action_execution_digest_check'
           AND c.relnamespace = to_regnamespace(current_schema())`);
      assert.deepEqual(deferred.rows, [{ tgdeferrable: true, tginitdeferred: true }],
        'D17 must run at the commit point, not in the middle of the statement');

      const ctx = context19();
      const publish = async (options: Parameters<typeof claimAction19>[2]): Promise<string> => txn(c, async () => {
        // v1.11 (PC-CX-54): the result link is a real FK now, so a fixture reset cannot delete the two
        // tables in sequence. TRUNCATE takes both at once and fires no row triggers.
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx, ...options }));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      assert.equal(await publish({}), '', 'a dispatch whose digests are computed honestly must commit');

      const forgeries: [string, Parameters<typeof claimAction19>[2]][] = [
        ['a forged result digest', { resultDigest: `'forged-result-digest'` }],
        ['a forged authorization digest', { contextDigest: `'forged-context-digest'` }],
        ['an authorization half missing one of the nine components',
          { ctx: `(${ctx} #- '{authorization,runnerId}')` }],
        ['two halves describing two different dispatches',
          { ctx: `jsonb_set(${ctx}, '{authorization,resolvedAgentId}', '"a2"')` }],
      ];
      for (const [label, options] of forgeries) {
        assert.match(await publish(options), /EXECUTION_DIGEST_MISMATCH/, `${label} must be refused`);
      }
      // v1.10 (PC-CX-52): "freezes no model conclusion" moved from D17's ad-hoc null test to EC2-b2's
      // closed shape, so it is now refused earlier and by name — a missing key, not a missing digest.
      assert.match(await publish({ ctx: `(${ctx} - 'model')` }), /EXECUTION_RESULT_SHAPE/,
        'a context that freezes no model conclusion must be refused');

      // Reverse control — v1.9 without D17. The review's exact row commits, and I17-A's digest
      // half (the query §12.1 G5 ⑫ asks the migration to run) returns it.
      await installV19(c, { digest: false });
      assert.equal(await publish({ resultDigest: `'forged-result-digest'` }), '',
        'PC-CX-48 must reproduce: without D17 a forged digest is frozen, not refused');
      const drift = await c.query<{ count: string; digest: string }>(`
        SELECT count(*)::text AS count, min(a.execution_result_digest) AS digest FROM project_action a
         WHERE a.type = 'DISPATCH_TASK' AND a.execution_context IS NOT NULL
           AND (a.execution_context_digest IS DISTINCT FROM coordinator_execution_digest(a.execution_context->'authorization')
             OR a.execution_result_digest IS DISTINCT FROM coordinator_execution_digest(a.execution_context - 'authorization'))`);
      assert.deepEqual(drift.rows[0], { count: '1', digest: 'forged-result-digest' },
        'I17-A\'s digest half must be observably false without D17');
    } finally {
      await c.end();
    }
  });

test('PC-CX-49 on real Postgres: an empty ledger record is refused and a legal retiredPin still commits',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const ctx = context19();
      const dispatch = async (): Promise<string> => txn(c, async () => {
        // v1.11 (PC-CX-54): the result link is a real FK now, so a fixture reset cannot delete the two
        // tables in sequence. TRUNCATE takes both at once and fires no row triggers.
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx }));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      const CLAIM = `UPDATE project_action SET detail = detail || ${claimRecord(
        part('model-v1', 'model-v1', 'FROZEN_CONTEXT'), part('high', 'high', 'FROZEN_CONTEXT'))} WHERE id='act1'`;
      // v1.10 (PC-CX-50): the ledger is append-only (D18), so a counterexample has to be *appended*
      // rather than written over the record a previous transaction already committed.
      const append = (record: string): string =>
        `UPDATE project_action SET detail = jsonb_set(detail, '{retiredPins}',
           COALESCE(detail->'retiredPins','[]'::jsonb) || jsonb_build_array(${record})) WHERE id='act1'`;
      const retire = (over: Record<string, string> = {}): string => {
        const fields: Record<string, string> = {
          generation: '2', component: `'model'`, from: `'model-v1'`, to: `'model-v2'`,
          at: `'${RETIRE_AT_19}'`, reason: `'RUNTIME_RETIRED'`, ...over,
        };
        const pairs = Object.entries(fields).map(([k, v]) => `'${k}', ${v}`).join(', ');
        return append(`jsonb_build_object(${pairs})`);
      };
      const observed = async () => (await c.query<{ generation: string; retired: string; model: string | null }>(`
        SELECT s.execution_pin_generation::text AS generation, s.model,
               COALESCE(jsonb_array_length(a.detail->'retiredPins'),0)::text AS retired
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id='s1'`)).rows[0];

      const firstClaim = async (): Promise<string> => txn(c, async () => {
        await c.query(CLAIM);
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      });
      /** One transaction: the session takes the new pin, and the action appends the record. */
      const retiredPin = async (sql: string): Promise<string> => txn(c, async () => {
        await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
        await c.query(sql);
      });

      await installV19(c);
      assert.equal(await dispatch(), '');
      assert.equal(await firstClaim(), '', 'a first claim that records itself must commit');
      // Both statement orders still commit — that is what "deferred" buys (D16-a).
      assert.equal(await retiredPin(retire()), '',
        'a retiredPin that records itself must commit (session written first)');
      assert.deepEqual(await observed(), { generation: '2', retired: '1', model: 'model-v2' });

      // The review's witness plus every shape that says nothing. Each one starts from the same
      // committed generation-1 state and appends exactly one record, so only that record differs.
      const refusals: [string, string][] = [
        ['an empty retiredPin record', append(`'{}'::jsonb`)],
        ['a record missing its reason', retire({ reason: 'NULL' })],
        ['a record whose reason is not the one PAC §6 reserves', retire({ reason: `'BECAUSE_I_SAID_SO'` })],
        ['a record for a component PAC §6 does not freeze at first claim', retire({ component: `'provider'` })],
        ['a broken chain', retire({ from: `'model-v0'` })],
        ['a generation that does not match the position', retire({ generation: '5' })],
        ['a moment that runs backwards', retire({ at: `'${V18_FROZEN_AT}'` })],
        ['a rewrite that rewrites nothing', retire({ to: `'model-v1'` })],
        ['a record carrying an extra key',
          append(`jsonb_build_object('generation',2,'component','model','from','model-v1','to','model-v2',
            'at','${RETIRE_AT_19}','reason','RUNTIME_RETIRED','note','why not')`)],
        ['a chain that folds elsewhere than the session pin', retire({ to: `'model-v9'` })],
      ];
      for (const [label, sql] of refusals) {
        assert.equal(await dispatch(), '');
        assert.equal(await firstClaim(), '');
        assert.match(await retiredPin(sql), /EXECUTION_PIN_LEDGER/, `${label} must be refused`);
        assert.deepEqual(await observed(), { generation: '1', retired: '0', model: 'model-v1' },
          `${label} left something behind`);
      }

      // Reverse control — v1.8's two cardinality functions. The review's exact state commits.
      await installV19(c, { ledger: 'v18' });
      assert.equal(await dispatch(), '');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE project_action SET detail = detail || '{"claimResolution": {}}'::jsonb WHERE id='act1'`);
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      }), '');
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
        await c.query(`UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}','[{}]') WHERE id='act1'`);
      }), '', 'PC-CX-49 must reproduce: v1.8 commits a ledger of empty objects');
      assert.deepEqual(await observed(), { generation: '2', retired: '1', model: 'model-v2' });
    } finally {
      await c.end();
    }
  });

// ---------------------------------------------------------------------------------------------
// v1.10 — `PC-CX-50..52` (§28). Round ten asked what a hard gate is *holding* when it judges:
// the column it reads to decide whether it applies, the row version it was queued with, and the
// object whose digest it recomputed.
// ---------------------------------------------------------------------------------------------

/** The two ledger writes of a legal first claim, as SQL. */
const FIRST_CLAIM_RECORD = claimRecord(
  part('model-v1', 'model-v1', 'FROZEN_CONTEXT'), part('high', 'high', 'FROZEN_CONTEXT'));

test('PC-CX-50 on real Postgres: the result link is published once and the ledger only grows',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const ctx = context19();
      const dispatch = async (): Promise<string> => txn(c, async () => {
        // v1.11 (PC-CX-54): the result link is a real FK now, so a fixture reset cannot delete the two
        // tables in sequence. TRUNCATE takes both at once and fires no row triggers.
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx }));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      const claim = async (): Promise<string> => txn(c, async () => {
        await c.query(`UPDATE project_action SET detail = detail || ${FIRST_CLAIM_RECORD} WHERE id='act1'`);
        await c.query(`UPDATE session SET model='model-v1', effort='high', execution_pin_generation=1 WHERE id='s1'`);
      });
      const one = async (sql: string): Promise<string> => txn(c, async () => { await c.query(sql); });
      const link = async () => (await c.query<{
        action_result: string | null; session_action: string; generation: string; claim: string | null;
      }>(`
        SELECT a.result_session_id AS action_result, s.project_action_id AS session_action,
               s.execution_pin_generation::text AS generation, (a.detail->'claimResolution')::text AS claim
          FROM session s JOIN project_action a ON a.id = s.project_action_id WHERE s.id='s1'`)).rows[0];

      await installV19(c);
      assert.equal(await dispatch(), '', 'the normal path must still commit');
      assert.equal(await claim(), '', 'a legal first claim must still commit');

      // The review's two transactions, verbatim. D18 refuses each on the statement itself (D18-f).
      assert.match(await one(`UPDATE project_action SET result_session_id=NULL WHERE id='act1'`),
        /ACTION_RESULT_LINK_FROZEN/, 'PC-CX-50: a published result link cannot be detached');
      assert.match(await one(`UPDATE project_action SET result_session_id='s2' WHERE id='act1'`),
        /ACTION_RESULT_LINK_FROZEN/, 'PC-CX-50: a published result link cannot be repointed');
      assert.match(await one(`UPDATE project_action SET detail='{"claimResolution":{}}'::jsonb WHERE id='act1'`),
        /EXECUTION_PIN_LEDGER/, 'PC-CX-50: a recorded claimResolution cannot be rewritten');
      assert.match(await one(`UPDATE project_action SET detail = detail - 'claimResolution' WHERE id='act1'`),
        /EXECUTION_PIN_LEDGER/, 'a recorded claimResolution cannot be dropped');
      // …and everything the ledger does not own stays freely writable (D18-c).
      assert.equal(await one(`UPDATE project_action SET detail = detail || '{"display":{"note":"ready"}}'::jsonb WHERE id='act1'`),
        '', 'a display write must still commit');
      assert.deepEqual(await link(), {
        action_result: 's1', session_action: 'act1', generation: '1', claim: (await link()).claim,
      }, 'the committed link is unchanged and still symmetric');

      // The retiredPins half of the same rule: append-only, prefix verbatim (D18 ③).
      assert.equal(await txn(c, async () => {
        await c.query(`UPDATE session SET model='model-v2', execution_pin_generation=2 WHERE id='s1'`);
        await c.query(`UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}',
          jsonb_build_array(jsonb_build_object('generation',2,'component','model','from','model-v1',
            'to','model-v2','at','${RETIRE_AT_19}','reason','RUNTIME_RETIRED'))) WHERE id='act1'`);
      }), '', 'a legal retiredPin must commit');
      for (const [label, sql] of [
        ['truncated to empty', `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}','[]') WHERE id='act1'`],
        ['rewritten in place', `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins,0,at}','"2026-08-19T00:03:00.000Z"') WHERE id='act1'`],
        ['replaced by an empty record', `UPDATE project_action SET detail = jsonb_set(detail,'{retiredPins}','[{}]') WHERE id='act1'`],
        ['dropped', `UPDATE project_action SET detail = detail - 'retiredPins' WHERE id='act1'`],
      ] as [string, string][]) {
        assert.match(await one(sql), /EXECUTION_PIN_LEDGER/, `a ledger ${label} must be refused`);
      }

      // Two objects, two chances: without D18 the same detach reaches the commit point, and D16-g
      // refuses it there — a typed refusal from either side, exactly like D15-g / D16-d.
      await installV19(c, { mutator: false });
      assert.equal(await dispatch(), '');
      assert.equal(await claim(), '');
      assert.match(await one(`UPDATE project_action SET result_session_id=NULL WHERE id='act1'`),
        /EXECUTION_RESULT_LINK/, 'without D18 the commit point still refuses a one-sided detach');
      assert.match(await one(`UPDATE project_action SET detail='{"claimResolution":{}}'::jsonb WHERE id='act1'`),
        /EXECUTION_PIN_LEDGER/, 'and the ledger rewrite is still judged, because the gate did not disable itself');

      // Reverse control — v1.9: D18 absent and the action side early-exits on a null link. The
      // review's exact committed state comes back, field for field.
      await installV19(c, { ledger: 'v19' });
      assert.equal(await dispatch(), '');
      assert.equal(await claim(), '');
      assert.equal(await one(`UPDATE project_action SET result_session_id=NULL WHERE id='act1'`), '',
        'PC-CX-50 must reproduce: v1.9 lets a writable column close the gate that reads it');
      assert.equal(await one(`UPDATE project_action SET detail='{"claimResolution":{}}'::jsonb WHERE id='act1'`), '',
        'PC-CX-50 must reproduce: after the detach nothing judges the ledger');
      assert.deepEqual(await link(),
        { action_result: null, session_action: 'act1', generation: '1', claim: '{}' });
    } finally {
      await c.end();
    }
  });

test('PC-CX-51 on real Postgres: any legal statement order inside one transaction commits',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const ctx = context19();
      const dispatch = async (): Promise<string> => txn(c, async () => {
        // v1.11 (PC-CX-54): the result link is a real FK now, so a fixture reset cannot delete the two
        // tables in sequence. TRUNCATE takes both at once and fires no row triggers.
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx }));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      // The three writes a first claim needs, plus the two extra writes D11-b and D16-c allow.
      const HEARTBEAT = `UPDATE session SET status='RUNNING' WHERE id='s1'`;
      const DISPLAY = `UPDATE project_action SET detail = detail || '{"display":{"note":"ready"}}'::jsonb WHERE id='act1'`;
      const RECORD = `UPDATE project_action SET detail = detail || ${FIRST_CLAIM_RECORD} WHERE id='act1'`;
      const pin = (generation: number): string =>
        `UPDATE session SET model='model-v1', effort='high', execution_pin_generation=${generation} WHERE id='s1'`;
      const state = async () => (await c.query<{ status: string; generation: string; model: string | null }>(`
        SELECT s.status, s.execution_pin_generation::text AS generation, s.model FROM session s WHERE s.id='s1'`)).rows[0];

      await installV19(c);
      // Every legal interleaving of the extra write, the record and the pin. All six commit.
      const orders: [string, string[]][] = [
        ['heartbeat first', [HEARTBEAT, RECORD, pin(1)]],
        ['heartbeat between', [RECORD, HEARTBEAT, pin(1)]],
        ['heartbeat last', [RECORD, pin(1), HEARTBEAT]],
        ['display first', [DISPLAY, RECORD, pin(1)]],
        ['display between', [RECORD, DISPLAY, pin(1)]],
        ['pin before record', [HEARTBEAT, pin(1), RECORD]],
      ];
      for (const [label, statements] of orders) {
        assert.equal(await dispatch(), '');
        assert.equal(await txn(c, async () => {
          for (const sql of statements) await c.query(sql);
        }), '', `${label}: a legal final state must commit whatever order it was written in`);
        assert.equal((await state()).model, 'model-v1', `${label}: and the pin is the one the action froze`);
      }

      // An illegal final state is still refused — in every one of those orders, and it rolls back.
      for (const [label, statements] of orders) {
        assert.equal(await dispatch(), '');
        const written = statements.map((sql) => (sql === pin(1) ? pin(2) : sql));
        assert.match(await txn(c, async () => {
          for (const sql of written) await c.query(sql);
        }), /EXECUTION_PIN_GENERATION|EXECUTION_PIN_LEDGER/,
          `${label}: generation 2 with no retiredPin must still be refused`);
        assert.deepEqual(await state(), { status: 'PENDING', generation: '0', model: null },
          `${label}: and the transaction rolled back whole`);
      }

      // Reverse control — v1.9's D16, which judges the tuple each event was queued with. The two
      // paths the review published fail deterministically, and the proposed final state is legal.
      await installV19(c, { ledger: 'v19' });
      for (const [label, statements] of [
        ['heartbeat first', [HEARTBEAT, RECORD, pin(1)]],
        ['display first', [DISPLAY, RECORD, pin(1)]],
      ] as [string, string[]][]) {
        assert.equal(await dispatch(), '');
        assert.match(await txn(c, async () => {
          for (const sql of statements) await c.query(sql);
        }), /EXECUTION_PIN_LEDGER/, `PC-CX-51 must reproduce: v1.9 rejects the ${label} order`);
        assert.deepEqual(await state(), { status: 'PENDING', generation: '0', model: null });
      }
      const folded = (await c.query<{ pin: { model: string; effort: string } }>(`
        SELECT coordinator_pin_ledger_fold('final-state', ${ctx}, ${FIRST_CLAIM_RECORD}->'claimResolution',
          '[]'::jsonb, 1) AS pin`)).rows[0].pin;
      assert.deepEqual(folded, { model: 'model-v1', effort: 'high' },
        'the state v1.9 refused to commit is internally valid — that is what makes it a defect');
    } finally {
      await c.end();
    }
  });

test('PC-CX-52 on real Postgres: an incomplete or empty result half is refused at the commit point',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      // The session is built from the frozen context itself (EC6-a), so a missing key becomes a
      // SQL NULL column and the review's `IS DISTINCT FROM` equality holds on both sides.
      const dispatch = async (ctx: string): Promise<string> => txn(c, async () => {
        // v1.11 (PC-CX-54): the result link is a real FK now, so a fixture reset cannot delete the two
        // tables in sequence. TRUNCATE takes both at once and fires no row triggers.
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx }));
        await c.query(`
          INSERT INTO session (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,
            assigned_runner_id,provider,provider_builtin,required_capabilities,permission_mode,resolution,
            snapshot_frozen_at)
          SELECT 's1','t1','act1','COORDINATOR','PENDING', execution_context->>'agentId',
            execution_context->>'workspaceId', execution_context->>'assignedRunnerId',
            execution_context->>'provider', (execution_context->>'providerBuiltin')::boolean,
            -- The fixture must survive a malformed context long enough for the gate to refuse it,
            -- so a non-array here becomes a SQL NULL column rather than a raw extraction error.
            CASE WHEN jsonb_typeof(execution_context->'requiredCapabilities') = 'array'
                 THEN ARRAY(SELECT jsonb_array_elements_text(execution_context->'requiredCapabilities')) END,
            execution_context->>'permissionMode', execution_context->'resolution',
            (execution_context->>'snapshotFrozenAt')::timestamptz
            FROM project_action WHERE id='act1'`);
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });

      await installV19(c);
      assert.equal(await dispatch(context19()), '', 'the complete eleven-key result half must commit');

      const refusals: [string, string][] = [
        ['an empty model conclusion', context19('""')],
        ['an empty effort conclusion', context19('"model-v1"', '""')],
        ['a missing requiredCapabilities', `(${context19()} - 'requiredCapabilities')`],
        ['a missing permissionMode', `(${context19()} - 'permissionMode')`],
        ['a missing resolution', `(${context19()} - 'resolution')`],
        ['a missing snapshotFrozenAt', `(${context19()} - 'snapshotFrozenAt')`],
        ['all four missing at once',
          `(${context19()} - 'requiredCapabilities' - 'permissionMode' - 'resolution' - 'snapshotFrozenAt')`],
        ['a providerBuiltin that is a string', `jsonb_set(${context19()}, '{providerBuiltin}', '"true"')`],
        ['a requiredCapabilities that is not an array', `jsonb_set(${context19()}, '{requiredCapabilities}', '"linux"')`],
        ['a capability that is not a nonempty string', `jsonb_set(${context19()}, '{requiredCapabilities}', '[""]')`],
        ['a key EC2-b does not have', `(${context19()} || '{"surprise":1}'::jsonb)`],
        ['a snapshotFrozenAt that is not ISO-8601 UTC', `jsonb_set(${context19()}, '{snapshotFrozenAt}', '"yesterday"')`],
        ['a resolution that is not PAC 7.5 who/with/where', `jsonb_set(${context19()}, '{resolution}', '{"v":1}')`],
        ['a model that is JSON null', `jsonb_set(${context19()}, '{model}', 'null')`],
      ];
      // Each refused dispatch rolls back whole, so the previous committed dispatch is what stays.
      const committed = async (): Promise<string | null> => (await c.query<{ model: string | null }>(
        `SELECT execution_context->>'model' AS model FROM project_action WHERE id='act1'`)).rows[0]?.model ?? null;
      for (const [label, ctx] of refusals) {
        // Every digest below is computed by the database from the (incomplete) object itself, so it
        // is *correct*. That is the whole finding: a correct digest of an incomplete input.
        assert.match(await dispatch(ctx), /EXECUTION_RESULT_SHAPE/, `${label} must be refused`);
        assert.equal(await committed(), 'model-v1', `${label} was not rolled back whole`);
      }
      // The deferred sentinel is a conclusion, not an absence (EC6-c row 1).
      assert.equal(await dispatch(context19('"DEFERRED_TO_CLAIM"')), '',
        'DEFERRED_TO_CLAIM is a legal conclusion and must still commit');

      // Reverse control — v1.9: D17 tested `IS NULL` and nothing counted the keys. Both of the
      // review's states commit, and the second one carries two correct digests.
      await installV19(c, { ledger: 'v19' });
      assert.equal(await dispatch(context19('""', '""')), '',
        'PC-CX-52 must reproduce: v1.9 mistakes an empty string for a concrete conclusion');
      const missing = ['requiredCapabilities', 'permissionMode', 'resolution', 'snapshotFrozenAt'];
      assert.equal(await dispatch(
        `(${context19()} - 'requiredCapabilities' - 'permissionMode' - 'resolution' - 'snapshotFrozenAt')`), '',
        'PC-CX-52 must reproduce: v1.9 accepts an incomplete result half');
      const shape = (await c.query<{ missing: string[]; capabilities: string[] | null; permission: string | null }>(`
        SELECT ARRAY(SELECT k FROM unnest(ARRAY['requiredCapabilities','permissionMode','resolution','snapshotFrozenAt']) k
                     WHERE NOT (a.execution_context ? k)) AS missing,
               s.required_capabilities AS capabilities, s.permission_mode AS permission
          FROM project_action a JOIN session s ON s.project_action_id = a.id WHERE a.id='act1'`)).rows[0];
      assert.deepEqual(shape, { missing, capabilities: null, permission: null });
    } finally {
      await c.end();
    }
  });

// -------------------------------------------------------------------------------------------------
// v1.11 — `PC-CX-53..55`. Round eleven asked one question of all three: is this gate in the right
// place? A frame drawn one key too small (53), a gate missing a verb (54), and a type test written
// after the exception that makes it unreachable (55).
// -------------------------------------------------------------------------------------------------

/** PAC §7.5's resolution, as SQL. `v` is the key PAC says must be written; v1.10 refused it. */
function pacResolution(version = `'1'::jsonb`, extra = ''): string {
  return `jsonb_build_object('who', jsonb_build_object('agentId','a1','source','task-assignee'),
    'with', jsonb_build_object('provider','claude','model','model-v1','effort',null,'source','task-pin'),
    'where', jsonb_build_object('workspaceId','w1','runnerId','r1','source','task-pin',
      'required', jsonb_build_array('linux'), 'candidatesConsidered', 1))
    ${version === '' ? '' : `|| jsonb_build_object('v', ${version})`}${extra}`;
}

/** The v1.9 context with its `resolution` replaced, so only that one key differs between cases. */
function contextWithResolution(resolution: string): string {
  return `jsonb_set(${context19()}, '{resolution}', ${resolution})`;
}

test('PC-CX-53 on real Postgres: a PAC 7.5 resolution with its mandatory v dispatches and commits',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      // The whole finding is that no positive path existed, so the assertion that closes it is a
      // dispatch that *commits* — the §8.3 three statements, end to end, on a real server.
      const dispatch = async (ctx: string): Promise<string> => txn(c, async () => {
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1', { ctx }));
        await c.query(`
          INSERT INTO session (id,task_id,project_action_id,dispatch_origin,status,agent_id,workspace_id,
            assigned_runner_id,provider,provider_builtin,required_capabilities,permission_mode,resolution,
            snapshot_frozen_at)
          SELECT 's1','t1','act1','COORDINATOR','PENDING', execution_context->>'agentId',
            execution_context->>'workspaceId', execution_context->>'assignedRunnerId',
            execution_context->>'provider', (execution_context->>'providerBuiltin')::boolean,
            ARRAY(SELECT jsonb_array_elements_text(execution_context->'requiredCapabilities')),
            execution_context->>'permissionMode', execution_context->'resolution',
            (execution_context->>'snapshotFrozenAt')::timestamptz
            FROM project_action WHERE id='act1'`);
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      const committed = async () => (await c.query<{
        status: string; link: string | null; version: string | null; keys: string[];
      }>(`
        SELECT a.status, a.result_session_id AS link,
               a.execution_context #>> '{resolution,v}' AS version,
               ARRAY(SELECT k FROM jsonb_object_keys(s.resolution) k ORDER BY k) AS keys
          FROM project_action a JOIN session s ON s.id = a.result_session_id WHERE a.id='act1'`)).rows[0];

      await installV19(c);
      assert.equal(await dispatch(contextWithResolution(pacResolution())), '',
        'a dispatch whose resolution is PAC 7.5 verbatim — v included — must commit');
      assert.deepEqual(await committed(),
        { status: 'APPLIED', link: 's1', version: '1', keys: ['v', 'where', 'who', 'with'] },
        'the committed session carries PAC 7.5 four top-level keys, byte for byte from the frozen context');

      // An unknown version is a version (PAC 7.5: readers must tolerate one), so it commits too.
      assert.equal(await dispatch(contextWithResolution(pacResolution(`'7'::jsonb`))), '',
        'PAC 7.5 requires readers to tolerate an unknown version, so the gate must not pin v = 1');

      const refusals: [string, string][] = [
        ['a versionless resolution', pacResolution('')],
        ['a v that is a string', pacResolution(`'"1"'::jsonb`)],
        ['a v of zero', pacResolution(`'0'::jsonb`)],
        ['a v that is not an integer', pacResolution(`'1.5'::jsonb`)],
        ['a top-level key PAC 7.5 does not have', pacResolution(`'1'::jsonb`, ` || '{"extra":true}'::jsonb`)],
        ['a who that is not an object', `jsonb_set(${pacResolution()}, '{who}', '"a1"')`],
      ];
      for (const [label, resolution] of refusals) {
        assert.match(await dispatch(contextWithResolution(resolution)), /EXECUTION_RESULT_SHAPE/,
          `${label} must be refused by EC2-b3`);
      }
      // Every refusal rolled back whole, so the last committed dispatch is still the v = 7 one.
      assert.equal((await committed()).version, '7', 'a refused dispatch must roll back whole');

      // Reverse control — v1.10's exact-key predicate. The conforming resolution is refused and the
      // versionless one passes: the review's two lines, in that order.
      await installV19(c, { shape: 'v110' });
      assert.match(await dispatch(contextWithResolution(pacResolution())),
        /EXECUTION_RESULT_SHAPE.*resolution is not PAC 7\.5's who\/with\/where/,
        'PC-CX-53 must reproduce: v1.10 refuses every PAC-conforming resolution');
      assert.equal(await dispatch(contextWithResolution(pacResolution(''))), '',
        'PC-CX-53 must reproduce: deleting the key PAC requires is the only way through v1.10');
      assert.equal((await committed()).version, null,
        'and the state v1.10 admits is the one PAC forbids: a resolution with no version at all');
    } finally {
      await c.end();
    }
  });

test('PC-CX-54 on real Postgres: a published result session survives soft delete and refuses purge',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const dispatch = async (): Promise<string> => txn(c, async () => {
        await c.query(`TRUNCATE session, project_action`);
        await c.query(claimAction19('act1', 'k1'));
        await c.query(MATCHING_SESSION('s1', 'act1'));
        await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
      });
      const one = async (sql: string): Promise<string> => txn(c, async () => { await c.query(sql); });
      const orphan = async () => (await c.query<{
        status: string; result_session_id: string | null; session_exists: boolean;
      }>(`
        SELECT a.status, a.result_session_id,
               EXISTS (SELECT 1 FROM session s WHERE s.id = a.result_session_id) AS session_exists
          FROM project_action a WHERE a.id='act1'`)).rows[0];

      await installV19(c);
      assert.equal(await dispatch(), '', 'the ordinary dispatch must commit first');

      // Soft delete is what "the user deleted it" means, and it is an UPDATE: the row stays, so
      // every gate keeps its object. D16 runs on it and passes (D19-b).
      assert.equal(await one(`UPDATE session SET deleted_at=clock_timestamp() WHERE id='s1'`), '',
        'the supported trash step must still commit');
      assert.equal(await one(`UPDATE session SET status='RUNNING' WHERE id='s1'`), '',
        'and a heartbeat after the soft delete must still commit — nothing was switched off');

      // The purge is the verb nothing observed in v1.10.
      assert.match(await one(`DELETE FROM session WHERE id='s1'`), /SESSION_RESULT_LINK_REFERENCED/,
        'PC-CX-54: purging a published result session must be refused with this contract own code');
      assert.deepEqual(await orphan(),
        { status: 'APPLIED', result_session_id: 's1', session_exists: true },
        'the invariant I17-A3 states holds on the committed state');

      // Two objects, two chances (D19 ① / ②): without the trigger the foreign key still refuses,
      // it just does it with Postgres own 23503 rather than an owner and a recovery.
      await c.query(`DROP TRIGGER session_result_link_delete_guard ON session`);
      const structural = await one(`DELETE FROM session WHERE id='s1'`);
      assert.match(structural, /project_action_result_session_fk/,
        'the foreign key must hold on its own, for any binary');
      assert.doesNotMatch(structural, /SESSION_RESULT_LINK_REFERENCED/,
        'and that half is deliberately untyped — it is why the trigger exists as well');

      // Nothing else is touched: a session no action row points at is deleted normally. That is
      // the Coordinator Session rotation path §7.5 depends on (D19-b, D19-d).
      await installV19(c);
      assert.equal(await one(`INSERT INTO session (id,dispatch_origin,status) VALUES ('coord1','USER','RUNNING')`), '');
      assert.equal(await one(`DELETE FROM session WHERE id='coord1'`), '',
        'a session no action row points at — a Coordinator Session — must still be deletable');

      // Reverse control — v1.10: neither object exists, and the review's committed orphan is back.
      await installV19(c, { sessionDelete: false });
      assert.equal(await dispatch(), '');
      assert.equal(await one(`UPDATE session SET deleted_at=clock_timestamp() WHERE id='s1'`), '');
      assert.equal(await one(`DELETE FROM session WHERE id='s1'`), '',
        'PC-CX-54 must reproduce: no v1.10 object observes DELETE');
      assert.deepEqual(await orphan(),
        { status: 'APPLIED', result_session_id: 's1', session_exists: false },
        'and it leaves the review exact committed observation: an APPLIED action pointing at nothing');
    } finally {
      await c.end();
    }
  });

test('PC-CX-55 on real Postgres: a malformed ledger is refused at insert and a legacy one can still be repaired',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const one = async (sql: string): Promise<string> => txn(c, async () => { await c.query(sql); });
      const insertClaimed = (id: string, detail: string): string =>
        claimAction19(id, `key-${id}`).replace(`,'{}'::jsonb,\n`, () => `,'${detail}'::jsonb,\n`);
      const row = async (id: string) => (await c.query<{ status: string; detail: string }>(
        `SELECT status, detail::text AS detail FROM project_action WHERE id='${id}'`)).rows[0];

      await installV19(c);
      await one(`TRUNCATE session, project_action`);

      // A ledger that is an empty array is a ledger; that path must stay open.
      assert.equal(await one(insertClaimed('healthy', '{"retiredPins":[]}')), '',
        'an empty-array ledger must insert normally');

      // …and every non-array top-level value is refused on the INSERT statement itself, with this
      // contract code rather than Postgres 22023.
      for (const malformed of ['{"retiredPins":{}}', '{"retiredPins":"[]"}', '{"retiredPins":3}',
        '{"retiredPins":null}']) {
        const refusal = await one(insertClaimed('bad', malformed));
        assert.match(refusal, /EXECUTION_PIN_LEDGER/, `${malformed} must be refused at insert`);
        assert.doesNotMatch(refusal, /cannot get array length|cannot extract elements/,
          'the refusal must be the typed one, not the native JSON error');
        assert.equal(await row('bad'), undefined, `${malformed} must not have committed`);
      }

      // The legacy half: a row an older binary already committed. Drop the mutator, write it, put
      // the mutator back — that is exactly the mixed-version state D18-e ④ has to survive.
      await c.query(`DROP TRIGGER project_action_result_ledger_mutator ON project_action`);
      assert.equal(await one(insertClaimed('legacy', '{"retiredPins":{},"display":{"note":"old"}}')), '');
      await c.query(`CREATE TRIGGER project_action_result_ledger_mutator
                       BEFORE INSERT OR UPDATE ON project_action
                       FOR EACH ROW EXECUTE FUNCTION project_action_result_ledger_mutator()`);
      assert.deepEqual((await c.query<{ id: string; ledger_type: string }>(`
        SELECT id, jsonb_typeof(detail->'retiredPins') AS ledger_type FROM project_action
         WHERE detail ? 'retiredPins' AND jsonb_typeof(detail->'retiredPins') <> 'array'`)).rows,
      [{ id: 'legacy', ledger_type: 'object' }], 'D18-e ④ must find exactly the legacy row');

      // Outlet one: a statement that does not touch the ledger. This is the transition the review
      // found bricked — CLAIMED → REFUSED, with nothing to do with retiredPins at all.
      assert.equal(await one(`UPDATE project_action SET status='REFUSED', refusal_code='PROVIDER_UNAVAILABLE'
                                WHERE id='legacy'`), '',
      'a normal terminal transition must commit even while the legacy value is still there');
      assert.equal((await row('legacy')).status, 'REFUSED');

      // Outlet two: the explicit repair D18-e ④-a prescribes — the evidence is moved, not dropped.
      assert.equal(await one(`UPDATE project_action
                                SET detail = (detail - 'retiredPins')
                                           || jsonb_build_object('malformedRetiredPins', detail->'retiredPins')
                              WHERE id='legacy'`), '', 'the prescribed repair must commit');
      assert.equal(await one(`UPDATE project_action SET detail = detail || '{"retiredPins":[]}'::jsonb
                              WHERE id='legacy'`), '', 'and so must writing a legal empty ledger');
      assert.equal((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM project_action
        WHERE detail ? 'retiredPins' AND jsonb_typeof(detail->'retiredPins') <> 'array'`)).rows[0].n, '0',
      'after the repair the audit returns zero rows');

      // What is *not* an outlet: swapping one malformed value for another.
      assert.match(await one(`UPDATE project_action SET detail = detail || '{"retiredPins":"still-bad"}'::jsonb
                              WHERE id='legacy'`), /EXECUTION_PIN_LEDGER/,
      'replacing a malformed ledger with another malformed value is not a repair');

      // The commit point carries the same sentence (D16 ⓪), so a malformed value cannot reach APPLIED.
      assert.match((await txn(c, async () => {
        await c.query(`SELECT coordinator_pin_ledger_fold('probe', ${context19()},
          '{"generation":1}'::jsonb, '{}'::jsonb, 1)`);
      })), /EXECUTION_PIN_LEDGER/, 'the fold must type-check before it folds');

      // Reverse control — v1.10: no INSERT event, and the type test sits behind the array call.
      await installV19(c, { mutatorEvents: 'update' });
      await one(`TRUNCATE session, project_action`);
      assert.equal(await one(insertClaimed('stuck', '{"retiredPins":{}}')), '',
        'PC-CX-55 must reproduce: v1.10 has no INSERT event, so the malformed ledger commits');
      for (const [label, sql] of [
        ['the normal terminal transition',
          `UPDATE project_action SET status='REFUSED', refusal_code='PROVIDER_UNAVAILABLE' WHERE id='stuck'`],
        ['every attempt to repair it', `UPDATE project_action SET detail='{}'::jsonb WHERE id='stuck'`],
      ] as [string, string][]) {
        const native = await one(sql);
        assert.match(native, /cannot get array length of a non-array|cannot extract elements from an object/,
          `PC-CX-55 must reproduce: ${label} raises Postgres own JSON error`);
        assert.doesNotMatch(native, /EXECUTION_PIN_LEDGER/,
          'and it is not the typed contract refusal callers were promised');
      }
      assert.deepEqual(await row('stuck'), { status: 'CLAIMED', detail: '{"retiredPins": {}}' },
        'and it leaves the review exact committed observation: a permanent key stuck in CLAIMED');
    } finally {
      await c.end();
    }
  });

// -------------------------------------------------------------------------------------------------
// v1.12 — `PC-CX-56..57`. Round twelve asked one question of both: is what this gate closes the
// thing it was meant to close? One closed every delete order and left a promised operation with no
// transaction at all (56); one closed two unrelated gates on its way past the ledger (57).
// -------------------------------------------------------------------------------------------------

/**
 * §2.4's on-delete table plus §7.7 D20. `installV19` builds the ledger and the placeholder; this
 * adds the Project the ledger cascades from, the lineage constraint in whichever version is under
 * test, and D20's two objects. `lineage: 'v111'` is the immediate RESTRICT §2.4 froze in v1.11 —
 * the one that refuses the Project cascade itself; `lineage: 'none'` is the review's own reverse
 * control, where the Project deletes and the placeholder is left pointing at nothing.
 */
async function installPurge112(c: Client, options: { lineage?: 'v112' | 'v111' | 'none' } = {}): Promise<void> {
  const { lineage = 'v112' } = options;
  await c.query(`
    CREATE TABLE project (id text PRIMARY KEY);
    INSERT INTO project VALUES ('p1'), ('p-empty'), ('p-ledger');
    ALTER TABLE project_action
      ADD CONSTRAINT project_action_project_fk FOREIGN KEY (project_id)
      REFERENCES project(id) ON DELETE CASCADE;
    CREATE INDEX project_action_project_idx ON project_action(project_id);
    ALTER TABLE session DROP CONSTRAINT session_project_action_id_fkey;
  `);
  // v1.12: RESTRICT can never be deferred in PostgreSQL, so the lineage half becomes a deferrable
  // NO ACTION. INITIALLY IMMEDIATE keeps every statement outside a declared purge behaving as before.
  if (lineage !== 'none') {
    await c.query(`
      ALTER TABLE session
        ADD CONSTRAINT session_project_action_fk
        FOREIGN KEY (project_action_id) REFERENCES project_action(id)
        ${lineage === 'v112'
    ? 'ON DELETE NO ACTION ON UPDATE NO ACTION\n        DEFERRABLE INITIALLY IMMEDIATE'
    : 'ON DELETE RESTRICT ON UPDATE RESTRICT'};
    `);
  }
  if (lineage !== 'v112') return;              // D20's two objects are what v1.12 adds; before it, neither exists
  await c.query(`
    CREATE OR REPLACE FUNCTION project_purge_fence() RETURNS trigger AS $fn$
    DECLARE stranded bigint;
    BEGIN
      IF current_setting('coordinator.purging_project', true) IS NOT DISTINCT FROM OLD.id THEN
        RETURN OLD;
      END IF;
      SELECT count(*) INTO stranded
        FROM session s JOIN project_action a ON a.id = s.project_action_id
       WHERE a.project_id = OLD.id;
      IF stranded > 0 THEN
        RAISE EXCEPTION 'PROJECT_PURGE_UNDECLARED: project % still owns % coordinator placeholder session(s) whose lineage points into its action ledger (owner=SYSTEM, recovery=EVENT: call coordinator_purge_project(%) — it is the only public purge, and it removes the project, its ledger and those placeholders in one transaction)',
          OLD.id, stranded, quote_literal(OLD.id);
      END IF;
      RETURN OLD;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE TRIGGER project_purge_fence
      BEFORE DELETE ON project
      FOR EACH ROW EXECUTE FUNCTION project_purge_fence();

    CREATE OR REPLACE FUNCTION coordinator_purge_project(p_project_id text,
      OUT purged_actions bigint, OUT purged_sessions bigint) AS $fn$
    DECLARE doomed text[];
    BEGIN
      purged_actions := 0; purged_sessions := 0;
      PERFORM 1 FROM project WHERE id = p_project_id FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      PERFORM set_config('coordinator.purging_project', p_project_id, true);
      SET CONSTRAINTS session_project_action_fk DEFERRED;
      SELECT COALESCE(array_agg(DISTINCT s.id), '{}'::text[]) INTO doomed
        FROM session s JOIN project_action a
          ON a.id = s.project_action_id OR a.result_session_id = s.id
       WHERE a.project_id = p_project_id;
      SELECT count(*) INTO purged_actions FROM project_action WHERE project_id = p_project_id;
      DELETE FROM project WHERE id = p_project_id;
      DELETE FROM session WHERE id = ANY(doomed);
      GET DIAGNOSTICS purged_sessions = ROW_COUNT;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
}

/** One legal dispatch on `p1`, plus a ledger-only Project no placeholder ever referred to. */
async function seedPurgeFixture(c: Client): Promise<string> {
  return txn(c, async () => {
    await c.query(claimAction19('act1', 'k1'));
    await c.query(MATCHING_SESSION('s1', 'act1'));
    await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='act1'`);
    await c.query(claimAction19('act-ledger', 'k-ledger')
      .replace(`'p1','DISPATCH_TASK'`, `'p-ledger','DISPATCH_TASK'`));
  });
}

const PURGE_CENSUS = `
  SELECT (SELECT count(*)::text FROM project) AS projects,
         (SELECT count(*)::text FROM project_action) AS actions,
         (SELECT count(*)::text FROM session) AS sessions`;

/** §4.3 I17-A3's lineage half as a query: no session may point at an action row that is gone. */
const PURGE_ORPHANS = `
  SELECT count(*)::text AS n FROM session s
   WHERE s.project_action_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM project_action a WHERE a.id = s.project_action_id)`;

test('PC-CX-56 on real Postgres: a linked Project purges in one transaction and leaves no orphan',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const one = async (sql: string): Promise<string> => txn(c, async () => { await c.query(sql); });
      const census = async () => (await c.query<{ projects: string; actions: string; sessions: string }>(
        PURGE_CENSUS)).rows[0];
      const orphans = async (): Promise<string> =>
        (await c.query<{ n: string }>(PURGE_ORPHANS)).rows[0].n;

      await installV19(c);
      await installPurge112(c);
      assert.equal(await seedPurgeFixture(c), '', 'the ordinary dispatch must commit first');

      // A bare DELETE that would strand the placeholder is refused on *that statement*, with this
      // contract's own code, an owner and a recovery that names the one entry point.
      const bare = await one(`DELETE FROM project WHERE id='p1'`);
      assert.match(bare, /PROJECT_PURGE_UNDECLARED/, 'a bare DELETE that strands a placeholder must be refused');
      assert.match(bare, /owner=SYSTEM, recovery=EVENT/, 'the refusal must name an owner and a recovery');
      assert.match(bare, /coordinator_purge_project/, 'and the recovery must name the one public entry point');
      assert.deepEqual(await census(), { projects: '3', actions: '2', sessions: '1' }, 'and nothing moved');

      // D19 is untouched: the Session half still refuses on its own while its action row is alive.
      assert.match(await one(`DELETE FROM session WHERE id='s1'`), /SESSION_RESULT_LINK_REFERENCED/,
        'D19 must keep refusing a Session-first purge — that half of the contract does not change');

      // The two degenerate Projects still delete on a bare statement: an empty one, and one whose
      // ledger no placeholder ever referred to. Their committed result equals the function's, which
      // is what keeps the public semantics single (D20-f).
      assert.equal(await one(`DELETE FROM project WHERE id='p-empty'`), '', 'an empty Project must still delete');
      assert.equal(await one(`DELETE FROM project WHERE id='p-ledger'`), '',
        'and a Project whose ledger nothing points at must still delete, cascade and all');
      assert.deepEqual(await census(), { projects: '1', actions: '1', sessions: '1' },
        'the cascade took the ledger-only action with its Project');

      // A transaction that forges the fence but leaves the placeholder behind fails at COMMIT: the
      // structural half is unconditional, so "no orphan" is a proof and not a promise (D20-d).
      const forged = await txn(c, async () => {
        await c.query(`SELECT set_config('coordinator.purging_project','p1',true)`);
        await c.query(`SET CONSTRAINTS session_project_action_fk DEFERRED`);
        await c.query(`DELETE FROM project WHERE id='p1'`);
      });
      assert.match(forged, /session_project_action_fk/, 'a forged fence must still be caught by the constraint');
      assert.deepEqual(await census(), { projects: '1', actions: '1', sessions: '1' }, 'and it rolls back whole');

      // The positive that closes the finding: one transaction, and the invariant checked inside it.
      let counts: { purged_actions: string; purged_sessions: string } | undefined;
      let insideOrphans = 'unread';
      assert.equal(await txn(c, async () => {
        counts = (await c.query<{ purged_actions: string; purged_sessions: string }>(
          `SELECT * FROM coordinator_purge_project('p1')`)).rows[0];
        insideOrphans = (await c.query<{ n: string }>(PURGE_ORPHANS)).rows[0].n;
      }), '', 'the declared purge of a linked Project must commit');
      assert.deepEqual(counts, { purged_actions: '1', purged_sessions: '1' },
        'it must report the ledger and the placeholder it actually removed');
      assert.equal(insideOrphans, '0', 'and I17-A3 must hold inside the same transaction, before COMMIT');
      assert.deepEqual(await census(), { projects: '0', actions: '0', sessions: '0' },
        'the Project, its whole ledger and its placeholder are gone — and none of them row by row');
      assert.equal(await orphans(), '0', 'and the committed state carries no orphan lineage');

      // Reverse control — v1.11's immediate RESTRICT: the same call fails on its first statement,
      // and the review's committed observation is that nothing was removed at all.
      await installV19(c);
      await installPurge112(c, { lineage: 'v111' });
      assert.equal(await seedPurgeFixture(c), '');
      const restricted = await one(`DELETE FROM project WHERE id='p1'`);
      assert.match(restricted, /session_project_action_fk/,
        'PC-CX-56 must reproduce: under v1.11 the Project cascade is refused by the lineage RESTRICT');
      assert.doesNotMatch(restricted, /PROJECT_PURGE_UNDECLARED/,
        'and v1.11 had no typed refusal to give: the caller gets a bare 23503');
      assert.deepEqual(await census(), { projects: '3', actions: '2', sessions: '1' },
        'and it leaves the review exact committed observation: the Project and all three rows still there');

      // Reverse control — dropping the lineage half, the other thing the review tried. The Project
      // deletes, and the placeholder is left pointing at an action row that no longer exists.
      await installV19(c);
      await installPurge112(c, { lineage: 'none' });
      assert.equal(await seedPurgeFixture(c), '');
      assert.equal(await one(`DELETE FROM project WHERE id='p1'`), '',
        'PC-CX-56 must reproduce: with no lineage constraint the bare DELETE commits');
      assert.deepEqual((await c.query(`
        SELECT s.project_action_id,
               EXISTS (SELECT 1 FROM project_action a WHERE a.id = s.project_action_id) AS action_exists
          FROM session s WHERE s.id='s1'`)).rows[0],
      { project_action_id: 'act1', action_exists: false },
      'and it leaves the orphan lineage I17-A3 and D15 forbid');
    } finally {
      await c.end();
    }
  });

test('D20 concurrency control: a second purge of the same Project is a clean idempotent no-op',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const first = await connect();
    const second = await connect();
    try {
      await installV19(first);
      await installPurge112(first);
      assert.equal(await seedPurgeFixture(first), '');
      await second.query(`SET search_path TO ${V19_SCHEMA}`);

      // Both bare deletes are refused in the BEFORE trigger, before either takes the row lock, so
      // neither blocks the other and both get the typed answer.
      for (const c of [first, second]) {
        assert.match(await txn(c, async () => { await c.query(`DELETE FROM project WHERE id='p1'`); }),
          /PROJECT_PURGE_UNDECLARED/, 'a concurrent bare DELETE is refused with the same typed code');
      }

      await first.query('BEGIN');
      const won = (await first.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`)).rows[0];
      await second.query('BEGIN');
      const queued = second.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`);
      // D20-e: the second purge parks on the Project row lock rather than racing past it.
      assert.equal(await Promise.race([queued.then(() => 'ran'),
        new Promise<string>((resolve) => setTimeout(() => resolve('parked'), 250))]), 'parked',
      'the second purge must queue on the Project row lock');
      await first.query('COMMIT');

      assert.deepEqual(won, { purged_actions: '1', purged_sessions: '1' }, 'the first purge removes the ledger');
      assert.deepEqual((await queued).rows[0], { purged_actions: '0', purged_sessions: '0' },
        'and the second wakes, finds the row gone, and returns a clean no-op rather than an error');
      await second.query('COMMIT');
      assert.deepEqual((await first.query<{ projects: string; actions: string; sessions: string }>(
        PURGE_CENSUS)).rows[0], { projects: '2', actions: '1', sessions: '0' },
      'and the two Projects nobody purged keep their rows');
      assert.equal((await first.query<{ n: string }>(PURGE_ORPHANS)).rows[0].n, '0',
        'no orphan survives the concurrent pair either');
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      await Promise.all([first.end(), second.end()]);
    }
  });

test('PC-CX-57 on real Postgres: a legacy malformed ledger still cannot rewrite a claim or a link',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      const one = async (sql: string): Promise<string> => txn(c, async () => { await c.query(sql); });
      const detail = async (): Promise<string> => (await c.query<{ detail: string }>(
        `SELECT detail::text AS detail FROM project_action WHERE id='legacy'`)).rows[0].detail;
      const link = async (): Promise<string | null> => (await c.query<{ l: string | null }>(
        `SELECT result_session_id AS l FROM project_action WHERE id='legacy'`)).rows[0].l;
      /**
       * The mixed-version state D18-e ④ has to survive. The row is dispatched normally first, then
       * the malformed ledger is written with the two objects that watch it dropped — that is what
       * "an older binary already committed this" means, and it is the only way an APPLIED row can
       * carry a value the commit-point fold would never admit.
       */
      const seedLegacy = async (ledgerDetail: string, publish: boolean): Promise<string> => {
        const dispatched = await txn(c, async () => {
          await c.query(`TRUNCATE session, project_action`);
          await c.query(claimAction19('legacy', 'k-legacy'));
          if (publish) {
            await c.query(MATCHING_SESSION('s1', 'legacy'));
            await c.query(`UPDATE project_action SET status='APPLIED', result_session_id='s1' WHERE id='legacy'`);
          }
        });
        if (dispatched !== '') return dispatched;
        // A second transaction writes the value no current object would admit — the two that watch
        // the ledger are dropped for exactly one statement, then put straight back.
        return txn(c, async () => {
          await c.query(`DROP TRIGGER project_action_result_ledger_mutator ON project_action`);
          await c.query(`DROP TRIGGER project_action_pin_ledger_check ON project_action`);
          await c.query(`UPDATE project_action SET detail = '${ledgerDetail}'::jsonb WHERE id='legacy'`);
          await c.query(`CREATE TRIGGER project_action_result_ledger_mutator
                           BEFORE INSERT OR UPDATE ON project_action
                           FOR EACH ROW EXECUTE FUNCTION project_action_result_ledger_mutator()`);
          await c.query(`CREATE CONSTRAINT TRIGGER project_action_pin_ledger_check
                           AFTER INSERT OR UPDATE ON project_action DEFERRABLE INITIALLY DEFERRED
                           FOR EACH ROW EXECUTE FUNCTION project_action_pin_ledger_check()`);
        });
      };
      const rewriteClaim = `UPDATE project_action
                              SET detail = jsonb_set(detail, '{claimResolution}', '{"new":2}'::jsonb)
                            WHERE id='legacy'`;

      await installV19(c);

      // ② on a malformed row: the recorded first claim is immutable, exactly as on a legal one.
      assert.equal(await seedLegacy('{"retiredPins":{},"claimResolution":{"old":1}}', false), '',
        'the legacy row an older binary left behind must be reproducible');
      assert.match(await one(rewriteClaim), /EXECUTION_PIN_LEDGER.*rewrites a claimResolution/,
        'PC-CX-57: an unchanged malformed retiredPins must not disable claimResolution immutability');
      assert.match(await detail(), /"old": 1/, 'and the audit is still the one that was recorded');

      // The same statement on a legal ledger gives the identical answer — one rule, not two.
      assert.equal(await seedLegacy('{"retiredPins":[],"claimResolution":{"old":1}}', false), '');
      assert.match(await one(rewriteClaim), /EXECUTION_PIN_LEDGER.*rewrites a claimResolution/,
        'the legal-ledger row must answer identically, or the rule depends on an unrelated key');

      // ① on a malformed row: a published result link can be neither detached nor repointed.
      assert.equal(await seedLegacy('{"retiredPins":{}}', true), '');
      assert.match(await one(`UPDATE project_action SET result_session_id=NULL WHERE id='legacy'`),
        /ACTION_RESULT_LINK_FROZEN/, 'PC-CX-57: the published link must stay frozen through a malformed ledger');
      await c.query(`INSERT INTO session (id,dispatch_origin,status) VALUES ('s2','USER','RUNNING')`);
      assert.match(await one(`UPDATE project_action SET result_session_id='s2' WHERE id='legacy'`),
        /ACTION_RESULT_LINK_FROZEN/, 'and repointing it is the same statement with the same answer');
      assert.equal(await link(), 's1', 'the link is still the one that was published');

      // D18-g's two outlets are untouched, and a *first* claim is not a rewrite (D18-h).
      assert.equal(await seedLegacy('{"retiredPins":{},"display":{"note":"old"}}', false), '');
      assert.equal(await one(`UPDATE project_action SET status='REFUSED', refusal_code='PROVIDER_UNAVAILABLE'
                              WHERE id='legacy'`), '',
      'the normal terminal transition must still commit — that is what the compatibility branch is for');
      assert.equal(await one(`UPDATE project_action
                                SET detail = detail || '{"claimResolution":{"first":1}}'::jsonb
                              WHERE id='legacy'`), '',
      'writing a first claimResolution is not a rewrite: ② freezes the second write, not the first');
      assert.equal(await one(`UPDATE project_action SET detail = detail - 'retiredPins' WHERE id='legacy'`), '',
        'and the prescribed repair must still commit');
      assert.match(await detail(), /"first": 1/, 'the first claim that was written is still there');
      assert.match(await one(`UPDATE project_action SET detail = detail || '{"retiredPins":"still-bad"}'::jsonb
                              WHERE id='legacy'`), /EXECUTION_PIN_LEDGER/,
      'swapping one malformed value for another is still not a repair');

      // Reverse control — v1.11's ⓪ returned out of the whole function, so both gates were off.
      // The review's witness is this row exactly: a terminal action, no link, a malformed ledger.
      await installV19(c, { ledgerOutlet: 'v111' });
      assert.equal(await seedLegacy('{"retiredPins":{},"claimResolution":{"old":1}}', false), '');
      assert.equal(await one(rewriteClaim), '',
        'PC-CX-57 must reproduce: v1.11 lets an unrelated malformed sibling key admit the rewrite');
      assert.match(await detail(), /"new": 2/,
        'and it leaves the review exact committed observation: the immutable claim audit was rewritten');

      // The same early return took ① with it. What is left is only the commit-point object, which
      // is precisely the split D18-d says is not optional: a caller gets no statement-level answer.
      assert.equal(await seedLegacy('{"retiredPins":{}}', true), '');
      const detached = await one(`UPDATE project_action SET result_session_id=NULL WHERE id='legacy'`);
      assert.doesNotMatch(detached, /ACTION_RESULT_LINK_FROZEN/,
        'PC-CX-57 must reproduce: the same early return also switched off the statement-level link freeze');
      assert.match(detached, /EXECUTION_RESULT_LINK/,
        'only D16 at the commit point is left standing, and it names a different failure');
      assert.equal(await link(), 's1', 'so the detach dies at COMMIT rather than on its own statement');
    } finally {
      await c.end();
    }
  });

// -------------------------------------------------------------------------------------------------
// v1.13 — `PC-CX-58..61`. Round thirteen asked one question of all four: does exactly one sentence
// decide this rule? Two clauses gave the lineage FK two initial modes (58); the migration table and
// the normative function bodies described two object sets for one version (59); D20-c's prose and
// D20 ③-3's SQL described two different sets of rows to delete (60); and the purge's snapshot and a
// concurrent publication had no shared linearization point, so the winner depended on the scheduler
// rather than on a rule (61).
// -------------------------------------------------------------------------------------------------

/**
 * §7.7 D20 as v1.13 states it, on top of `installPurge112`'s tables and lineage constraint. Three
 * switches keep the superseded shapes reachable as reverse controls: `snapshot: 'v112'` is the raw
 * `OR` union D20-c never authorised, `lockLedger: false` drops ③-2, and `publishFence: false` drops
 * ④ — the pair whose absence is `PC-CX-61`.
 */
async function installPurge113(c: Client, options: {
  snapshot?: 'v113' | 'v112'; lockLedger?: boolean; publishFence?: boolean; base?: boolean;
  scope?: 'v114' | 'v113';
} = {}): Promise<void> {
  const { snapshot = 'v113', lockLedger = true, publishFence = true, base = true,
    scope = 'v114' } = options;
  if (base) await installPurge112(c);
  // ⓪ D20-c's quantification domain, as one function. ② and ③ both read it and neither restates it.
  // v1.14 (PC-CX-62): the predicate is §4.3 I11-A's attribution closure, column for column — an
  // APPLIED dispatch, both directions of the link, the action's TASK subject being the Task this
  // session runs, and that Task belonging to this same Project. `scope: 'v113'` restores the
  // predicate the review found, so both of its witnesses stay reproducible.
  await c.query(`
    CREATE OR REPLACE FUNCTION coordinator_purge_ledger_pairs(p_project_id text)
    RETURNS TABLE (action_id text, session_id text, in_scope boolean, reason text)
    LANGUAGE sql STABLE AS $fn$
      SELECT a.id, s.id,
             COALESCE(s.dispatch_origin = 'COORDINATOR'
                  AND a.type = 'DISPATCH_TASK'
                  AND s.project_action_id IS NOT DISTINCT FROM a.id
                  ${scope === 'v114'
    ? `AND a.status = 'APPLIED'
                  AND a.result_session_id IS NOT DISTINCT FROM s.id
                  AND a.subject_type = 'TASK'
                  AND s.task_id IS NOT NULL
                  AND a.subject_id IS NOT DISTINCT FROM s.task_id
                  AND EXISTS (SELECT 1 FROM task t
                               WHERE t.id = s.task_id AND t.project_id = a.project_id)`
    : `AND ((a.status =  'APPLIED' AND a.result_session_id IS NOT DISTINCT FROM s.id)
                    OR (a.status <> 'APPLIED' AND a.result_session_id IS NULL))`}
                  AND NOT EXISTS (SELECT 1 FROM project_action o
                                   WHERE o.result_session_id = s.id
                                     AND o.project_id IS DISTINCT FROM p_project_id), false),
             CASE WHEN s.dispatch_origin <> 'COORDINATOR' THEN 'the session is not a COORDINATOR placeholder'
                  WHEN a.type <> 'DISPATCH_TASK'          THEN 'the action is not a DISPATCH_TASK'
                  WHEN s.project_action_id IS DISTINCT FROM a.id
                                                          THEN 'the link is one-way: the session does not point back'
                  WHEN a.status <> 'APPLIED' AND a.result_session_id IS NOT NULL
                                                          THEN 'an unpublished dispatch already carries a result link'
                  ${scope === 'v114'
    ? `WHEN a.status <> 'APPLIED'
                                                          THEN 'the action never reached APPLIED, so it never published a placeholder'
                  WHEN a.result_session_id IS DISTINCT FROM s.id
                                                          THEN 'the applied dispatch does not point at this session'
                  WHEN a.subject_type <> 'TASK'           THEN 'the action does not dispatch a TASK'
                  WHEN s.task_id IS NULL                  THEN 'the placeholder session runs no task'
                  WHEN a.subject_id IS DISTINCT FROM s.task_id
                                                          THEN 'the action dispatches a different task than this session runs'
                  WHEN NOT EXISTS (SELECT 1 FROM task t
                                    WHERE t.id = s.task_id AND t.project_id = a.project_id)
                                                          THEN 'the task this session runs belongs to another project'`
    : `WHEN a.status =  'APPLIED' AND a.result_session_id IS DISTINCT FROM s.id
                                                          THEN 'the applied dispatch does not point at this session'`}
                  WHEN EXISTS (SELECT 1 FROM project_action o
                                WHERE o.result_session_id = s.id
                                  AND o.project_id IS DISTINCT FROM p_project_id)
                                                          THEN 'another project ledger points at this session too'
                  ELSE 'in scope' END
        FROM project_action a
        JOIN session s ON (s.project_action_id = a.id OR a.result_session_id = s.id)
       WHERE a.project_id = p_project_id;
    $fn$;

    CREATE OR REPLACE FUNCTION project_purge_fence() RETURNS trigger AS $fn$
    DECLARE bad record; stranded bigint;
    BEGIN
      SELECT * INTO bad FROM coordinator_purge_ledger_pairs(OLD.id)
       WHERE NOT in_scope ORDER BY action_id, session_id LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'PROJECT_PURGE_UNDECIDABLE: project % links action % to session % but % (owner=USER, recovery=HUMAN: adjudicate that link first; nothing was deleted)',
          OLD.id, bad.action_id, bad.session_id, bad.reason;
      END IF;
      IF current_setting('coordinator.purging_project', true) IS NOT DISTINCT FROM OLD.id THEN
        RETURN OLD;
      END IF;
      SELECT count(DISTINCT session_id) INTO stranded
        FROM coordinator_purge_ledger_pairs(OLD.id) WHERE in_scope;
      IF stranded > 0 THEN
        RAISE EXCEPTION 'PROJECT_PURGE_UNDECLARED: project % still owns % coordinator placeholder session(s) whose lineage points into its action ledger (owner=SYSTEM, recovery=EVENT: call coordinator_purge_project(%) — it is the only public purge, and it removes the project, its ledger and those placeholders in one transaction)',
          OLD.id, stranded, quote_literal(OLD.id);
      END IF;
      RETURN OLD;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION coordinator_purge_lock_ledger(p_project_id text) RETURNS void AS $fn$
    BEGIN
      PERFORM 1 FROM project_action WHERE project_id = p_project_id ORDER BY id FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'PROJECT_PURGE_CONTENDED: project % has an in-flight dispatch holding one of its action rows outside the publish fence (owner=SYSTEM, recovery=EVENT: retry coordinator_purge_project(%) after that transaction settles — this transaction changed nothing and the purge is idempotent)',
        p_project_id, quote_literal(p_project_id);
    END;
    $fn$ LANGUAGE plpgsql VOLATILE;

    CREATE OR REPLACE FUNCTION coordinator_project_publish_fence() RETURNS trigger AS $fn$
    DECLARE p_id text;
    BEGIN
      IF TG_TABLE_NAME = 'session' THEN
        IF NEW.project_action_id IS NULL THEN RETURN NEW; END IF;
        SELECT a.project_id INTO p_id FROM project_action a WHERE a.id = NEW.project_action_id;
        IF NOT FOUND THEN RETURN NEW; END IF;
      ELSE
        p_id := NEW.project_id;
      END IF;
      PERFORM 1 FROM project WHERE id = p_id FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PROJECT_PURGED: project % was physically purged while this dispatch was in flight (owner=SYSTEM, recovery=EVENT: this dispatch is void — the ledger it would join no longer exists; do not retry it against this project)', p_id;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql VOLATILE;
  `);
  await c.query(`
    CREATE OR REPLACE FUNCTION coordinator_purge_project(p_project_id text,
      OUT purged_actions bigint, OUT purged_sessions bigint) AS $fn$
    DECLARE doomed text[]; bad record;
    BEGIN
      purged_actions := 0; purged_sessions := 0;
      PERFORM 1 FROM project WHERE id = p_project_id FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      ${lockLedger ? 'PERFORM coordinator_purge_lock_ledger(p_project_id);' : ''}
      SELECT * INTO bad FROM coordinator_purge_ledger_pairs(p_project_id)
       WHERE NOT in_scope ORDER BY action_id, session_id LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'PROJECT_PURGE_UNDECIDABLE: project % links action % to session % but % (owner=USER, recovery=HUMAN: adjudicate that link first; nothing was deleted)',
          p_project_id, bad.action_id, bad.session_id, bad.reason;
      END IF;
      PERFORM set_config('coordinator.purging_project', p_project_id, true);
      SET CONSTRAINTS session_project_action_fk DEFERRED;
      ${snapshot === 'v113'
    ? `SELECT COALESCE(array_agg(DISTINCT session_id), '{}'::text[]) INTO doomed
           FROM coordinator_purge_ledger_pairs(p_project_id) WHERE in_scope;`
    : `SELECT COALESCE(array_agg(DISTINCT s.id), '{}'::text[]) INTO doomed
           FROM session s JOIN project_action a ON a.id = s.project_action_id OR a.result_session_id = s.id
          WHERE a.project_id = p_project_id;`}
      SELECT count(*) INTO purged_actions FROM project_action WHERE project_id = p_project_id;
      DELETE FROM project WHERE id = p_project_id;
      DELETE FROM session WHERE id = ANY(doomed);
      GET DIAGNOSTICS purged_sessions = ROW_COUNT;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  if (publishFence) {
    await c.query(`
      CREATE TRIGGER coordinator_project_publish_fence BEFORE INSERT OR UPDATE ON project_action
        FOR EACH ROW EXECUTE FUNCTION coordinator_project_publish_fence();
      CREATE TRIGGER coordinator_project_publish_fence BEFORE INSERT ON session
        FOR EACH ROW EXECUTE FUNCTION coordinator_project_publish_fence();
    `);
  }
}

/** §12.1 step 6g2 and 6h, executed: the objects each is required to leave behind, from the catalog. */
const OBJECT_CENSUS_113 = `
  WITH ns AS (SELECT current_schema()::regnamespace AS oid),
       trg AS (SELECT t.* FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE NOT t.tgisinternal AND c.relnamespace = (SELECT oid FROM ns)),
       con AS (SELECT c.* FROM pg_constraint c WHERE c.connamespace = (SELECT oid FROM ns))
  SELECT
    (SELECT (t.tgtype & 4) > 0 FROM trg t WHERE t.tgname = 'project_action_result_ledger_mutator') AS d18_insert,
    (SELECT (t.tgtype & 16) > 0 FROM trg t WHERE t.tgname = 'project_action_result_ledger_mutator') AS d18_update,
    (SELECT c.confdeltype::text FROM con c WHERE c.conname = 'project_action_result_session_fk') AS d19_fk,
    (SELECT count(*)::int FROM trg t WHERE t.tgname = 'session_result_link_delete_guard') AS d19_guard,
    (SELECT c.condeferrable FROM con c WHERE c.conname = 'session_project_action_fk') AS fk_deferrable,
    (SELECT c.condeferred FROM con c WHERE c.conname = 'session_project_action_fk') AS fk_deferred,
    (SELECT c.confdeltype::text FROM con c WHERE c.conname = 'session_project_action_fk') AS fk_delete,
    (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM ns)
        AND p.proname IN ('coordinator_purge_ledger_pairs','coordinator_purge_lock_ledger',
                          'coordinator_purge_project','project_purge_fence','coordinator_project_publish_fence')) AS d20_functions,
    (SELECT count(*)::int FROM trg t
      WHERE t.tgname IN ('project_purge_fence','coordinator_project_publish_fence')) AS d20_triggers`;

test('PC-CX-58 on real Postgres: the lineage FK is immediate by default and deferrable only on demand',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await installV19(c);
      await installPurge113(c);
      assert.equal(await seedPurgeFixture(c), '', 'the ordinary dispatch must commit first');
      const fk = async () => (await c.query<{ condeferrable: boolean; condeferred: boolean;
        confdeltype: string; confupdtype: string }>(`
        SELECT condeferrable, condeferred, confdeltype::text, confupdtype::text FROM pg_constraint
         WHERE conname='session_project_action_fk' AND connamespace = current_schema()::regnamespace`)).rows[0];
      // All four columns together: two of them are identical in a same-named CASCADE constraint.
      assert.deepEqual(await fk(), { condeferrable: true, condeferred: false, confdeltype: 'a', confupdtype: 'a' },
        'the catalog does not agree with the one initial mode §2.4 / D20 ① / step 6h all state');

      // The half that matters is not a column, it is *when* the database refuses.
      assert.match(await txn(c, async () => { await c.query(`DELETE FROM project_action WHERE id='act1'`); }),
        /session_project_action_fk/, 'an ordinary transaction must be refused, exactly as v1.11 RESTRICT was');
      let statement = 'accepted';
      assert.match(await txn(c, async () => {
        await c.query(`SET CONSTRAINTS session_project_action_fk DEFERRED`);
        await c.query(`DELETE FROM project_action WHERE id='act1'`).catch((e: unknown) => {
          statement = String((e as { message?: string }).message); });
      }), /session_project_action_fk/, 'a declared purge must still be proved at COMMIT');
      assert.equal(statement, 'accepted',
        'and only there: with the constraint deferred the statement itself must pass — that is the difference '
        + 'the two v1.12 clauses disagreed about');

      // Reverse control: v1.11's immediate RESTRICT is the same name and a different pair of columns.
      await installV19(c);
      await installPurge112(c, { lineage: 'v111' });
      assert.deepEqual((await c.query<{ condeferrable: boolean; confdeltype: string }>(`
        SELECT condeferrable, confdeltype::text FROM pg_constraint
         WHERE conname='session_project_action_fk' AND connamespace = current_schema()::regnamespace`)).rows[0],
      { condeferrable: false, confdeltype: 'r' },
      'PC-CX-58: the superseded reading is still distinguishable in exactly these columns');
    } finally {
      await c.end();
    }
  });

test('PC-CX-59 on real Postgres: empty / v1.10 / v1.11 all converge on the same object set',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      // §12.1 step 6g2, executed. ② is a DROP + CREATE because `CREATE OR REPLACE FUNCTION` cannot
      // change a trigger's event list — a v1.10 database that only replaces the body keeps an
      // INSERT-blind ledger gate, and nothing in `pg_proc` says so.
      const step6g2 = async (): Promise<void> => {
        await c.query('DROP TRIGGER IF EXISTS project_action_result_ledger_mutator ON project_action');
        await c.query(D18_V112);
        await c.query(`CREATE TRIGGER project_action_result_ledger_mutator
                         BEFORE INSERT OR UPDATE ON project_action
                         FOR EACH ROW EXECUTE FUNCTION project_action_result_ledger_mutator()`);
        await c.query('DROP TRIGGER IF EXISTS session_result_link_delete_guard ON session');
        await c.query('ALTER TABLE project_action DROP CONSTRAINT IF EXISTS project_action_result_session_fk');
        await c.query(D19_V111);
      };
      const census = async () => (await c.query(OBJECT_CENSUS_113)).rows[0];
      const paths: [string, Parameters<typeof installV19>[1]][] = [
        ['empty', { mutator: false, sessionDelete: false }],
        ['v1.10', { mutatorEvents: 'update', sessionDelete: false }],
        ['v1.11', {}],
      ];
      const converged: Record<string, unknown>[] = [];
      for (const [label, start] of paths) {
        await installV19(c, start);
        await step6g2();                  // 6g2
        await installPurge113(c);         // 6h
        converged.push({ label, ...(await census()) });
      }
      for (const row of converged.slice(1)) {
        assert.deepEqual({ ...row, label: undefined }, { ...converged[0], label: undefined },
          `the ${row.label} starting point does not converge on the same object set as an empty database`);
      }
      assert.deepEqual({ ...converged[0], label: undefined }, {
        label: undefined,
        d18_insert: true, d18_update: true, d19_fk: 'r', d19_guard: 1,
        fk_deferrable: true, fk_deferred: false, fk_delete: 'a',
        d20_functions: 5, d20_triggers: 3,
      }, 'the converged object set is not the one §7.7 D18 / D19 / D20 specify');

      // …and the event surface is not decoration: on every path a malformed initial ledger and a
      // physical delete of a published result Session are both refused (D18 ⓪ / D19 ②).
      assert.match(await txn(c, async () => {
        await c.query(claimAction19('act-mal', 'k-mal').replace(`'{}'::jsonb`, `'{"retiredPins":{}}'::jsonb`));
      }), /EXECUTION_PIN_LEDGER/, 'the converged D18 must refuse a malformed ledger on INSERT');
      assert.equal(await seedPurgeFixture(c), '');
      assert.match(await txn(c, async () => { await c.query(`DELETE FROM session WHERE id='s1'`); }),
        /SESSION_RESULT_LINK_REFERENCED/, 'the converged D19 must refuse a physical delete of a published result');

      // Reverse control: v1.12's table had no 6g2, so a v1.10 database went straight to 6h.
      await installV19(c, { mutatorEvents: 'update', sessionDelete: false });
      await installPurge113(c);
      const skipped = await census();
      assert.equal(skipped.d18_insert, false, 'PC-CX-59 must reproduce: D18 stays UPDATE-only without 6g2');
      assert.equal(skipped.d19_fk, null, 'PC-CX-59 must reproduce: D19 structural half is never created');
      assert.equal(skipped.d19_guard, 0, 'PC-CX-59 must reproduce: D19 typed half is never created');
      assert.equal(await txn(c, async () => {
        await c.query(claimAction19('act-mal2', 'k-mal2').replace(`'{}'::jsonb`, `'{"retiredPins":{}}'::jsonb`));
      }), '', 'PC-CX-59 must reproduce: the v1.10 answer to a malformed initial ledger is to accept it');
    } finally {
      await c.end();
    }
  });

/** The five shapes D20-c excludes, each on its own Project, plus the Session that must survive. */
const UNDECIDABLE_113: { project: string; seed: (p: string) => string; reason: RegExp; kept: string }[] = [
  { project: 'p-user', kept: 'u-user', reason: /not a COORDINATOR placeholder/,
    seed: (p) => `INSERT INTO session (id, task_id, status, dispatch_origin) VALUES ('u-user', NULL, 'RUNNING', 'USER');
      ${claimAction19(`${p}-a`, `${p}-k`).replace(`'p1','DISPATCH_TASK'`, `'${p}','DISPATCH_TASK'`)};
      UPDATE project_action SET status='REFUSED', result_session_id='u-user' WHERE id='${p}-a';` },
  { project: 'p-oneway', kept: 'u-oneway', reason: /one-way/,
    seed: (p) => `INSERT INTO session (id, task_id, status, dispatch_origin) VALUES ('u-oneway', NULL, 'RUNNING', 'COORDINATOR');
      ${claimAction19(`${p}-a`, `${p}-k`).replace(`'p1','DISPATCH_TASK'`, `'${p}','DISPATCH_TASK'`)};
      UPDATE project_action SET status='REFUSED', result_session_id='u-oneway' WHERE id='${p}-a';` },
  { project: 'p-type', kept: 'u-type', reason: /not a DISPATCH_TASK/,
    seed: (p) => `${claimAction19(`${p}-a`, `${p}-k`)
    .replace(`'p1','DISPATCH_TASK'`, `'${p}','ROTATE_COORDINATOR_SESSION'`)};
      INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
        VALUES ('u-type', NULL, 'RUNNING', 'COORDINATOR', '${p}-a');` },
];

test('PC-CX-60 on real Postgres: every undecidable link fails closed on both entry points',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    try {
      await installV19(c);
      await installPurge113(c);
      assert.equal(await seedPurgeFixture(c), '', 'the ordinary dispatch must commit first');
      // These shapes cannot be written through the v1.13 topology at all — D16's commit-time gate
      // refuses every one of them (`EXECUTION_RESULT_LINK`), which is exactly why D20-i calls them
      // existing data rather than a legal state. So they are seeded the way D18-e ④ models an old
      // write end: gates off, row in, gates back on. That is the only way this data ever appears.
      for (const shape of UNDECIDABLE_113) {
        assert.equal(await txn(c, async () => {
          await c.query(`INSERT INTO project VALUES ('${shape.project}')`);
        }), '', `${shape.project}: the Project itself must commit normally`);
        await c.query('ALTER TABLE project_action DISABLE TRIGGER USER');
        await c.query('ALTER TABLE session DISABLE TRIGGER USER');
        const seeded = await txn(c, async () => { await c.query(shape.seed(shape.project)); });
        await c.query('ALTER TABLE project_action ENABLE TRIGGER USER');
        await c.query('ALTER TABLE session ENABLE TRIGGER USER');
        assert.equal(seeded, '', `${shape.project}: the legacy fixture must land to be worth refusing`);
        assert.match(await txn(c, async () => {
          await c.query(`UPDATE project_action SET detail = detail || '{"display":"x"}'::jsonb WHERE id='${shape.project}-a'`);
        }), /EXECUTION_RESULT_LINK|PROJECT_PURGED|^$/,
        `${shape.project}: sanity — the shape is one the live gates would not have admitted`);
      }

      for (const shape of UNDECIDABLE_113) {
        const answers: string[] = [];
        for (const sql of [`SELECT * FROM coordinator_purge_project('${shape.project}')`,
          `DELETE FROM project WHERE id='${shape.project}'`]) {
          const answer = await txn(c, async () => { await c.query(sql); });
          assert.match(answer, /PROJECT_PURGE_UNDECIDABLE/, `${shape.project}: not refused with D20-i's typed code`);
          assert.match(answer, shape.reason, `${shape.project}: refused for the wrong reason`);
          assert.match(answer, /owner=USER, recovery=HUMAN/, `${shape.project}: the refusal names no owner`);
          answers.push(answer);
        }
        assert.equal(answers[0], answers[1],
          `${shape.project}: the function and the bare DELETE give different answers — that is PC-CX-60`);
        assert.equal((await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM session WHERE id='${shape.kept}'`)).rows[0].n, '1',
        `${shape.project}: the Session D20-c excludes was deleted anyway`);
      }

      // Positive controls, so "it refuses everything" cannot pass this test.
      assert.deepEqual((await c.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`)).rows[0], { purged_actions: '1', purged_sessions: '1' },
      'a well-formed linked Project must still purge in one call');
      assert.equal(await txn(c, async () => { await c.query(`DELETE FROM project WHERE id='p-empty'`); }), '',
        'and an empty Project must still delete on a bare statement');

      // Reverse control: v1.12's raw OR union, with the adjudication that gates it removed.
      await installV19(c);
      await installPurge113(c, { snapshot: 'v112' });
      await c.query(`CREATE OR REPLACE FUNCTION coordinator_purge_ledger_pairs(p_project_id text)
        RETURNS TABLE (action_id text, session_id text, in_scope boolean, reason text)
        LANGUAGE sql STABLE AS $fn$
          SELECT a.id, s.id, true, 'v1.12 admitted every pair'
            FROM project_action a JOIN session s ON (s.project_action_id = a.id OR a.result_session_id = s.id)
           WHERE a.project_id = p_project_id;
        $fn$`);
      assert.equal(await seedPurgeFixture(c), '');
      const user = UNDECIDABLE_113[0];
      assert.equal(await txn(c, async () => {
        await c.query(`INSERT INTO project VALUES ('${user.project}')`);
      }), '');
      await c.query('ALTER TABLE project_action DISABLE TRIGGER USER');
      await c.query('ALTER TABLE session DISABLE TRIGGER USER');
      assert.equal(await txn(c, async () => { await c.query(user.seed(user.project)); }), '');
      await c.query('ALTER TABLE project_action ENABLE TRIGGER USER');
      await c.query('ALTER TABLE session ENABLE TRIGGER USER');
      assert.deepEqual((await c.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('${user.project}')`)).rows[0],
      { purged_actions: '1', purged_sessions: '1' },
      'PC-CX-60 must reproduce: the v1.12 OR union treats a reverse link alone as permission to delete');
      assert.equal((await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE id='${user.kept}'`)).rows[0].n, '0',
      'PC-CX-60 must reproduce: the USER Session D20-c excludes is physically deleted');
    } finally {
      await c.end();
    }
  });

test('PC-CX-61 on real Postgres: both commit orders have a typed winner',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const purger = await connect();
    const publisher = await connect();
    try {
      const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));
      // v1.14 (PC-CX-62): the late placeholder has to satisfy I11-A like any other — its own Task,
      // in this Project, named by the action's TASK subject. A task-less placeholder was v1.13's
      // shape, and D20 ⓪ now (correctly) refuses to call it a placeholder at all.
      const late = (id: string): string =>
        MATCHING_SESSION(id, 'act-late').replace(`'t1'`, `'t-late'`);
      const seedRace = async (): Promise<void> => {
        await installV19(purger);
        await installPurge113(purger);
        await publisher.query(`SET search_path TO ${V19_SCHEMA}`);
        await purger.query(`INSERT INTO task VALUES ('t-late','p1') ON CONFLICT DO NOTHING`);
        assert.equal(await seedPurgeFixture(purger), '', 'the published dispatch must commit first');
        assert.equal(await txn(purger, async () => {
          // D17 ties the authorization half's taskId to the action's own TASK subject, so the late
          // dispatch names `t-late` on both sides — the digests are recomputed from that context.
          await purger.query(claimAction19('act-late', 'k-late',
            { ctx: context19().split(`"taskId":"t1"`).join(`"taskId":"t-late"`) })
            .replace(`'TASK','t1'`, `'TASK','t-late'`));
        }), '', 'and the unpublished action the race turns on must exist');
      };

      // ── purge-wins. The publication queues on the shared Project row and gets a typed answer.
      await seedRace();
      await purger.query('BEGIN');
      const purge1 = purger.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`);
      await settle();
      await publisher.query('BEGIN');
      let parked = true;
      const publish1 = publisher.query(late('s-late'))
        .then(() => { parked = false; return 'committed'; })
        .catch((e: unknown) => { parked = false; return String((e as { message?: string }).message); });
      await settle();
      assert.equal(parked, true, 'the publication did not queue on the shared linearization point');
      assert.deepEqual((await purge1).rows[0], { purged_actions: '2', purged_sessions: '1' });
      await purger.query('COMMIT');
      const loser = await publish1;
      assert.match(loser, /PROJECT_PURGED/, 'the losing publication got no typed result');
      assert.match(loser, /owner=SYSTEM, recovery=EVENT/, 'the losing publication got no owner or recovery');
      assert.doesNotMatch(loser, /23503/, 'a bare 23503 is the structural backstop, not normal control flow');
      await publisher.query('ROLLBACK');
      assert.deepEqual((await purger.query<{ projects: string; actions: string; sessions: string }>(
        PURGE_CENSUS)).rows[0], { projects: '2', actions: '1', sessions: '0' },
      'purge-wins must leave nothing of p1 behind');

      // ── publish-wins. The purge queues on ③-1 and the late placeholder is inside its snapshot.
      await seedRace();
      await publisher.query('BEGIN');
      await publisher.query(late('s-late'));
      await publisher.query(`UPDATE project_action SET status='APPLIED', result_session_id='s-late' WHERE id='act-late'`);
      await purger.query('BEGIN');
      const purge2 = purger.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`).then((r) => r.rows[0])
        .catch((e: unknown) => String((e as { message?: string }).message));
      await settle();
      await publisher.query('COMMIT');
      assert.deepEqual(await purge2, { purged_actions: '2', purged_sessions: '2' },
        'publish-wins must sweep the placeholder that committed before the snapshot');
      await purger.query('COMMIT');
      assert.equal((await purger.query<{ n: string }>(PURGE_ORPHANS)).rows[0].n, '0',
        'publish-wins must leave no orphan lineage');

      // ── the bypass: a writer that skipped ④ holds an action row lock. NOWAIT ⇒ typed, not 40P01.
      await seedRace();
      await purger.query('DROP TRIGGER coordinator_project_publish_fence ON project_action');
      await publisher.query('BEGIN');
      await publisher.query(`UPDATE project_action SET detail = detail || '{"display":"x"}'::jsonb WHERE id='act-late'`);
      await purger.query('BEGIN');
      const contended = await purger.query(`SELECT * FROM coordinator_purge_project('p1')`)
        .then(() => 'committed').catch((e: unknown) => String((e as { message?: string }).message));
      assert.match(contended, /PROJECT_PURGE_CONTENDED/, 'the bypass produced a native deadlock, not a typed refusal');
      assert.match(contended, /owner=SYSTEM, recovery=EVENT/, 'the contention refusal names no owner or recovery');
      await purger.query('ROLLBACK');
      await publisher.query('COMMIT');
      assert.deepEqual((await purger.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`)).rows[0], { purged_actions: '2', purged_sessions: '1' },
      'the retry after that transaction settles must succeed — the refusal has to be idempotent');

      // ── reverse control: without ③-2 and ④ the same interleaving aborts the whole purge at COMMIT.
      await seedRace();
      await purger.query('DROP TRIGGER coordinator_project_publish_fence ON project_action');
      await purger.query('DROP TRIGGER coordinator_project_publish_fence ON session');
      await installPurge113(purger, { lockLedger: false, publishFence: false, base: false });
      await purger.query('BEGIN');
      await purger.query(`SELECT 1 FROM project WHERE id='p1' FOR UPDATE`);
      await purger.query(`SELECT set_config('coordinator.purging_project','p1',true)`);
      await purger.query(`SET CONSTRAINTS session_project_action_fk DEFERRED`);
      const doomed = (await purger.query<{ doomed: string[] }>(
        `SELECT COALESCE(array_agg(DISTINCT session_id), '{}'::text[]) AS doomed
           FROM coordinator_purge_ledger_pairs('p1') WHERE in_scope`)).rows[0].doomed;
      assert.deepEqual(doomed, ['s1'], 'positive control: the late publication is not in the snapshot yet');
      await publisher.query('BEGIN');
      await publisher.query(late('s-late'));
      await publisher.query(`UPDATE project_action SET status='APPLIED', result_session_id='s-late' WHERE id='act-late'`);
      await publisher.query('COMMIT');
      await purger.query(`DELETE FROM project WHERE id='p1'`);
      await purger.query(`DELETE FROM session WHERE id = ANY($1::text[])`, [doomed]);
      const aborted = await purger.query('COMMIT').then(() => 'committed')
        .catch((e: unknown) => String((e as { message?: string }).message));
      assert.match(aborted, /session_project_action_fk/,
        'PC-CX-61 must reproduce: without ③-2 and ④ the stale snapshot aborts the whole purge at COMMIT');
      assert.deepEqual((await purger.query<{ projects: string; actions: string; sessions: string }>(
        PURGE_CENSUS)).rows[0], { projects: '3', actions: '3', sessions: '2' },
      'PC-CX-61 must reproduce: the structural gate saves the invariant by rolling everything back — '
        + 'p1 keeps both of its actions and both Sessions, exactly as the review reported');
    } finally {
      await purger.query('ROLLBACK').catch(() => undefined);
      await publisher.query('ROLLBACK').catch(() => undefined);
      await Promise.all([purger.end(), publisher.end()]);
    }
  });

// A ledger row as an old write end would have left it: only the columns the schema demands. The
// result link is published in a third statement because `project_action_result_session_fk` is a
// real foreign key — `DISABLE TRIGGER USER` suspends the contract's gates, never the FK.
const legacyAction = (id: string, project: string, status: string, subjectType: string,
  subjectId: string): string =>
  `INSERT INTO project_action (id,idempotency_key,project_id,type,status,subject_type,subject_id,
     fencing_token,result_session_id,detail)
   VALUES ('${id}','k-${id}','${project}','DISPATCH_TASK','${status}','${subjectType}','${subjectId}',1,
     NULL,'{}'::jsonb)`;
const legacySession = (id: string, task: string | null, action: string): string =>
  `INSERT INTO session (id, task_id, status, dispatch_origin, project_action_id)
   VALUES ('${id}', ${task ? `'${task}'` : 'NULL'}, 'RUNNING', 'COORDINATOR', '${action}')`;
const legacyPublish = (action: string, session: string): string =>
  `UPDATE project_action SET status='APPLIED', result_session_id='${session}' WHERE id='${action}'`;

/**
 * §4.3 I11-A's attribution, shape by shape: the six ledgers v1.13's ⓪ called placeholders and
 * I11-A never did (v1.14, `PC-CX-62`). Each gets its own Project so the two entry points can be
 * run against the same committed fact twice, and each names what has to survive both runs.
 */
const UNDECIDABLE_114: {
  project: string; seed: () => string; reason: RegExp; kept: string;
  keptTask?: string; keptProject?: string;
}[] = [
  { project: 'p-terminal', kept: 's-terminal', reason: /never reached APPLIED/,
    seed: () => `INSERT INTO project VALUES ('p-terminal');
      INSERT INTO task VALUES ('t-terminal','p-terminal');
      ${legacyAction('a-terminal', 'p-terminal', 'REFUSED', 'TASK', 't-terminal')};
      ${legacySession('s-terminal', 't-terminal', 'a-terminal')};` },
  { project: 'p-claimed', kept: 's-claimed', reason: /never reached APPLIED/,
    seed: () => `INSERT INTO project VALUES ('p-claimed');
      INSERT INTO task VALUES ('t-claimed','p-claimed');
      ${legacyAction('a-claimed', 'p-claimed', 'CLAIMED', 'TASK', 't-claimed')};
      ${legacySession('s-claimed', 't-claimed', 'a-claimed')};` },
  { project: 'p-subject-type', kept: 's-subject-type', reason: /does not dispatch a TASK/,
    seed: () => `INSERT INTO project VALUES ('p-subject-type');
      INSERT INTO task VALUES ('t-subject-type','p-subject-type');
      ${legacyAction('a-subject-type', 'p-subject-type', 'CLAIMED', 'PROJECT', 'p-subject-type')};
      ${legacySession('s-subject-type', 't-subject-type', 'a-subject-type')};
      ${legacyPublish('a-subject-type', 's-subject-type')};` },
  { project: 'p-notask', kept: 's-notask', reason: /runs no task/,
    seed: () => `INSERT INTO project VALUES ('p-notask');
      INSERT INTO task VALUES ('t-notask','p-notask');
      ${legacyAction('a-notask', 'p-notask', 'CLAIMED', 'TASK', 't-notask')};
      ${legacySession('s-notask', null, 'a-notask')};
      ${legacyPublish('a-notask', 's-notask')};` },
  // The review's witness B: a formally complete two-way link whose Session runs another Project's Task.
  { project: 'p-owner', kept: 's-foreign', keptTask: 't-foreign', keptProject: 'p-foreign',
    reason: /different task than this session runs/,
    seed: () => `INSERT INTO project VALUES ('p-owner'), ('p-foreign');
      INSERT INTO task VALUES ('t-owner','p-owner'), ('t-foreign','p-foreign');
      ${legacyAction('a-owner', 'p-owner', 'CLAIMED', 'TASK', 't-owner')};
      ${legacySession('s-foreign', 't-foreign', 'a-owner')};
      ${legacyPublish('a-owner', 's-foreign')};` },
  // …and the same boundary crossed with the subject itself: the action dispatches the Task the
  // Session runs, but that Task has never belonged to this Project.
  { project: 'p-cross', kept: 's-cross', keptTask: 't-cross', keptProject: 'p-outside',
    reason: /belongs to another project/,
    seed: () => `INSERT INTO project VALUES ('p-cross'), ('p-outside');
      INSERT INTO task VALUES ('t-cross','p-outside');
      ${legacyAction('a-cross', 'p-cross', 'CLAIMED', 'TASK', 't-cross')};
      ${legacySession('s-cross', 't-cross', 'a-cross')};
      ${legacyPublish('a-cross', 's-cross')};` },
];

test('PC-CX-62 on real Postgres: the I11-A attribution closure decides both entry points',
  { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
    const c = await connect();
    const seedLegacy = async (shape: typeof UNDECIDABLE_114[number]): Promise<void> => {
      // Same discipline as PC-CX-60's fixtures: in the full topology D9 refuses every one of these
      // at the commit point (D9-d's counterexamples are exactly "wrong status / wrong Task /
      // wrong Project"), so the only way this data exists is an old write end — gates off, row in,
      // gates back on (D18-e ④). That is precisely why D20-i calls them existing data.
      await c.query('ALTER TABLE project_action DISABLE TRIGGER USER');
      await c.query('ALTER TABLE session DISABLE TRIGGER USER');
      const seeded = await txn(c, async () => { await c.query(shape.seed()); });
      await c.query('ALTER TABLE project_action ENABLE TRIGGER USER');
      await c.query('ALTER TABLE session ENABLE TRIGGER USER');
      assert.equal(seeded, '', `${shape.project}: the legacy fixture must land to be worth refusing`);
    };
    try {
      await installV19(c);
      await installPurge113(c);
      assert.equal(await seedPurgeFixture(c), '', 'the ordinary dispatch must commit first');

      for (const shape of UNDECIDABLE_114) {
        await seedLegacy(shape);
        const classified = (await c.query<{ in_scope: boolean; reason: string }>(
          `SELECT in_scope, reason FROM coordinator_purge_ledger_pairs('${shape.project}')`)).rows[0];
        assert.equal(classified.in_scope, false,
          `${shape.project}: ⓪ still admits a pair §4.3 I11-A does not attribute`);
        assert.match(classified.reason, shape.reason, `${shape.project}: classified for the wrong reason`);

        const answers: string[] = [];
        for (const sql of [`SELECT * FROM coordinator_purge_project('${shape.project}')`,
          `DELETE FROM project WHERE id='${shape.project}'`]) {
          const answer = await txn(c, async () => { await c.query(sql); });
          assert.match(answer, /PROJECT_PURGE_UNDECIDABLE/, `${shape.project}: not refused with D20-i's typed code`);
          assert.match(answer, shape.reason, `${shape.project}: refused for the wrong reason`);
          assert.match(answer, /owner=USER, recovery=HUMAN/, `${shape.project}: the refusal names no owner`);
          answers.push(answer);
        }
        assert.equal(answers[0], answers[1],
          `${shape.project}: the function and the bare DELETE give different answers — that is PC-CX-62`);
        assert.equal((await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM session WHERE id='${shape.kept}'`)).rows[0].n, '1',
        `${shape.project}: the Session I11-A does not attribute to this ledger was deleted anyway`);
        if (shape.keptProject) {
          assert.equal((await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM project WHERE id='${shape.keptProject}'`)).rows[0].n, '1',
          `${shape.project}: the other Project is gone`);
          assert.equal((await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM task WHERE id='${shape.keptTask}'`)).rows[0].n, '1',
          `${shape.project}: the other Project's Task is gone`);
        }
      }

      // Positive controls, so "it refuses everything" cannot pass this test: a placeholder that
      // satisfies I11-A column by column is still swept, and a Project with nothing to strand still
      // deletes on a bare statement.
      assert.deepEqual((await c.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('p1')`)).rows[0], { purged_actions: '1', purged_sessions: '1' },
      'a fully attributed placeholder must still purge in one call');
      assert.equal(await txn(c, async () => { await c.query(`DELETE FROM project WHERE id='p-empty'`); }), '',
        'and an empty Project must still delete on a bare statement');

      // Reverse control: the v1.13 predicate, with the same two committed facts the review reported.
      await installV19(c);
      await installPurge113(c, { scope: 'v113' });
      const terminal = UNDECIDABLE_114[0];
      const foreign = UNDECIDABLE_114[4];
      await seedLegacy(terminal);
      await seedLegacy(foreign);
      assert.equal((await c.query<{ in_scope: boolean }>(
        `SELECT in_scope FROM coordinator_purge_ledger_pairs('${terminal.project}')`)).rows[0].in_scope, true,
      'PC-CX-62 must reproduce: v1.13 admitted a REFUSED dispatch as an unpublished placeholder');
      assert.deepEqual((await c.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('${terminal.project}')`)).rows[0],
      { purged_actions: '1', purged_sessions: '1' });
      assert.equal((await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE id='${terminal.kept}'`)).rows[0].n, '0',
      'PC-CX-62 must reproduce: the function physically deleted it');
      await c.query(`INSERT INTO project VALUES ('${terminal.project}-bare')`);
      await c.query('ALTER TABLE project_action DISABLE TRIGGER USER');
      await c.query('ALTER TABLE session DISABLE TRIGGER USER');
      await c.query(`${legacyAction('a-bare', `${terminal.project}-bare`, 'REFUSED', 'TASK', 't-terminal')};
        ${legacySession('s-bare', null, 'a-bare')};`);
      await c.query('ALTER TABLE project_action ENABLE TRIGGER USER');
      await c.query('ALTER TABLE session ENABLE TRIGGER USER');
      assert.match(await txn(c, async () => {
        await c.query(`DELETE FROM project WHERE id='${terminal.project}-bare'`);
      }), /PROJECT_PURGE_UNDECLARED/,
      'PC-CX-62 must reproduce: the bare entry point keeps the same shape the function deleted');
      assert.equal((await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE id='s-bare'`)).rows[0].n, '1',
      'PC-CX-62 must reproduce: one committed fact, two different results');
      assert.deepEqual((await c.query<{ purged_actions: string; purged_sessions: string }>(
        `SELECT * FROM coordinator_purge_project('${foreign.project}')`)).rows[0],
      { purged_actions: '1', purged_sessions: '1' });
      assert.deepEqual((await c.query<{ session: string; project: string; task: string }>(
        `SELECT (SELECT count(*)::text FROM session WHERE id='${foreign.kept}') AS session,
                (SELECT count(*)::text FROM project WHERE id='${foreign.keptProject}') AS project,
                (SELECT count(*)::text FROM task    WHERE id='${foreign.keptTask}')    AS task`)).rows[0],
      { session: '0', project: '1', task: '1' },
      'PC-CX-62 must reproduce: purging one Project deleted the Session of another Project, '
        + 'while that Project and its Task stayed exactly where they were');
    } finally {
      await c.end();
    }
  });
