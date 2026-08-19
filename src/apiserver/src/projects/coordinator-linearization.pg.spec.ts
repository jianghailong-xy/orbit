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
