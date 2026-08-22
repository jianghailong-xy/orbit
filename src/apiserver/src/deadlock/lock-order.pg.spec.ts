import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from 'pg';

import {
  ARRIVALS,
  capacityFenceScenario,
  heldRelations,
  orderedBatchCreateScenario,
  orderedCreateScenario,
  orderedDependencyScenario,
  reverseCycleScenario,
} from './lock-order-fixture';
import { newFixtureIds, seedLockFixture, seedThreePartyFixture } from './orbit-lock-fixture';
import { runScenario, type ScenarioOutcome } from './pg-barrier';

const URL = process.env.COORDINATOR_PG_URL;

/** The whole point: nobody is the victim of anything. */
function assertAllCommitted(outcome: ScenarioOutcome): void {
  const failed = outcome.statements.filter((s) => !s.ok);
  assert.deepEqual(
    failed.map((s) => `${s.party}/${s.label}: ${s.sqlstate ?? '?'} ${s.message ?? ''}`),
    [],
    `${outcome.name}: every statement must succeed`,
  );
  for (const [party, committed] of Object.entries(outcome.committed)) {
    assert.equal(committed, true, `${outcome.name}: ${party} did not commit`);
  }
  // Belt and braces: a 40P01 anywhere would already have shown up as a failed statement, but the
  // whole regression is about that one SQLSTATE, so it is named.
  assert.equal(
    outcome.statements.some((s) => s.sqlstate === '40P01'),
    false,
    `${outcome.name}: a deadlock was detected`,
  );
}

/** Every wait edge the scenario produced, as `waiter -> blocker` pairs. */
function edges(outcome: ScenarioOutcome): string[] {
  const byPid = new Map(Object.entries(outcome.pids).map(([name, pid]) => [pid, name]));
  return outcome.waitEdges.map(
    (e) => `${e.waiter} -> ${e.blockingPids.map((p) => byPid.get(p) ?? String(p)).join('+')}`,
  );
}

/**
 * The canonical lock order, against a real fully-migrated PostgreSQL.
 *
 * Two things are proven here, and they are different claims:
 *
 *  1. **The order holds under both arrival orders.** The 2026-08-21 barriers are replayed with
 *     the statements each path issues today (`lock-order-fixture.ts`), from BOTH directions, and
 *     every party commits inside a strict deadline. Running only the convenient direction would
 *     prove nothing: a lock order is exactly the property that has to survive the other one.
 *  2. **The lock sets are what the order says they are.** The reason the old code cycled was a
 *     lock nobody wrote — a foreign key re-check taken because a row had already been written by
 *     the same transaction. So the sets are read out of `pg_locks` rather than argued about.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable server
 * `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */
test('the canonical lock order holds from both directions', { skip: !URL, timeout: 180_000 }, async (t) => {
  const url = URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  t.after(() => admin.end());

  await t.test('a second write of one Session row is what takes the parent locks', async () => {
    const ids = newFixtureIds('lockorder-fk-recheck');
    await seedLockFixture(admin, ids);
    const probe = new Client({ connectionString: url });
    await probe.connect();
    const { rows } = await probe.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0].pid;
    try {
      await probe.query('BEGIN');
      // Exactly what a runner events transaction does: fence the row, then write it.
      await probe.query('SELECT id FROM "session" WHERE id = $1::uuid FOR UPDATE', [
        ids.telemetrySessionId,
      ]);
      await probe.query(
        `UPDATE "session" SET "last_turn_at" = $2, "updated_at" = $2 WHERE "id" = $1::uuid`,
        [ids.telemetrySessionId, ids.telemetryTurnAt],
      );
      const afterFirst = await heldRelations(admin, pid);
      assert.deepEqual(
        afterFirst,
        ['session'],
        'one write takes the Session row and nothing else — SELECT … FOR UPDATE does not arm the ' +
          're-check, because it leaves the tuple\'s xmin alone',
      );

      // The second write of the same row. Nothing about any foreign key column changed, and yet:
      await probe.query(
        `UPDATE "session" SET "last_assistant_text" = $2, "updated_at" = $3 WHERE "id" = $1::uuid`,
        [ids.telemetrySessionId, 'preview', ids.telemetryTurnAt],
      );
      const afterSecond = await heldRelations(admin, pid);
      for (const relation of ['user', 'workspace', 'runner', 'task']) {
        assert.ok(
          afterSecond.includes(relation),
          `the second write should re-check ${relation} (got ${afterSecond.join(', ')})`,
        );
      }
      // This is the measurement the one-write invariant (lock-order.ts, I3) exists to keep at
      // zero: four parent relations, locked by a statement that names none of them, from inside
      // a transaction already holding the Session — the reverse of the order a Task write uses.
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      await probe.end().catch(() => undefined);
    }
  });

  for (const arrival of ARRIVALS) {
    await t.test(`one Task create against a runner events batch (${arrival})`, async () => {
      const ids = newFixtureIds(`lockorder-create-${arrival}`);
      await seedLockFixture(admin, ids);
      const outcome = await runScenario(url, orderedCreateScenario(ids, arrival), 30_000);
      assertAllCommitted(outcome);
      assert.equal(outcome.waitEdges.length, 1, `${outcome.name}: exactly one wait, never a ring`);
      assert.deepEqual(
        edges(outcome),
        arrival === 'task-first'
          ? ['runner-events -> task-create']
          : ['task-create -> runner-events'],
      );
      // The create really did land, edge and all.
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM "task_dependency" WHERE "id" = $1::uuid`,
        [ids.dependencyId],
      );
      assert.equal(Number(rows[0].n), 1, 'the create committed its dependency edge');
    });

    await t.test(`createMany against a runner events batch (${arrival})`, async () => {
      const ids = newFixtureIds(`lockorder-batch-${arrival}`);
      await seedLockFixture(admin, ids);
      const outcome = await runScenario(url, orderedBatchCreateScenario(ids, arrival), 30_000);
      assertAllCommitted(outcome);
      assert.equal(outcome.waitEdges.length, 1, `${outcome.name}: exactly one wait, never a ring`);
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM "task" WHERE "id" = ANY($1::uuid[])`,
        [[ids.batchTaskId, ids.victimTaskId]],
      );
      assert.equal(Number(rows[0].n), 2, 'the batch committed whole');
    });

    await t.test(`a dependency mutation against two runner transactions (${arrival})`, async () => {
      const ids = newFixtureIds(`lockorder-dependency-${arrival}`);
      await seedThreePartyFixture(admin, ids);
      const outcome = await runScenario(url, orderedDependencyScenario(ids, arrival), 30_000);
      assertAllCommitted(outcome);
      // Two waits, and they are a chain rather than a ring: the baseline's three edges are two
      // now, because the dependency mutation never asks for a Session it does not already hold
      // and the telemetry transaction never asks for the owner at all.
      assert.equal(outcome.waitEdges.length, 2, `${outcome.name}: a chain, not a ring`);
      const { rows } = await admin.query<{ status: string; n: string }>(
        `SELECT t."status"::text AS status,
                (SELECT count(*) FROM "task_dependency" d WHERE d."id" = $2::uuid)::text AS n
           FROM "task" t WHERE t."id" = $1::uuid`,
        [ids.dependentTaskId, ids.dependencyId],
      );
      assert.equal(rows[0].status, 'IN_PROGRESS', 'the dependency transaction committed its status write');
      assert.equal(Number(rows[0].n), 1, 'and its edge');
    });

    await t.test(`the Project capacity fence still serializes admission (${arrival})`, async () => {
      const ids = newFixtureIds(`lockorder-capacity-${arrival}`);
      await seedLockFixture(admin, ids);
      const outcome = await runScenario(url, capacityFenceScenario(ids, arrival), 30_000);
      assertAllCommitted(outcome);
      assert.equal(outcome.waitEdges.length, 1);
      assert.deepEqual(
        edges(outcome),
        arrival === 'task-first' ? ['admission -> capacity'] : ['capacity -> admission'],
      );
      // The waiting side is waiting on the PROJECT row, which is the fence doing its job — a
      // Session leaving the live-claim set cannot commit beside a dispatch decision that counted
      // it, in either arrival order.
      const waiter = outcome.waitEdges[0];
      assert.ok(
        waiter.locks.some((l) => !l.granted && (l.locktype === 'tuple' || l.locktype === 'transactionid')),
        'the wait is a row-level one, as a fence on one Project row must be',
      );
    });
  }

  await t.test('a telemetry-only Session write takes no Project lock', async () => {
    const ids = newFixtureIds('lockorder-telemetry-scope');
    await seedLockFixture(admin, ids);
    const probe = new Client({ connectionString: url });
    await probe.connect();
    const { rows } = await probe.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT id FROM "session" WHERE id = $1::uuid FOR UPDATE', [
        ids.telemetrySessionId,
      ]);
      await probe.query(
        `UPDATE "session" SET "last_turn_at" = $2, "last_assistant_text" = $3, "updated_at" = $2
          WHERE "id" = $1::uuid`,
        [ids.telemetrySessionId, ids.telemetryTurnAt, 'preview'],
      );
      // The capacity fence is declared `UPDATE OF status, task_id, deleted_at` and the event
      // source `UPDATE OF status, deleted_at, merge_status`; a batch write names none of them, so
      // rank 40 stays out of the hottest transaction in the system entirely.
      assert.deepEqual(await heldRelations(admin, rows[0].pid), ['session']);
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      await probe.end().catch(() => undefined);
    }
  });

  await t.test('the owner graph mutex serializes two reverse edge writes', async () => {
    const ids = newFixtureIds('lockorder-reverse-cycle');
    await seedThreePartyFixture(admin, ids);
    const secondEdgeId = randomUUID();
    const outcome = await runScenario(url, reverseCycleScenario(ids, secondEdgeId), 30_000);
    // Not assertAllCommitted: `second` deliberately rolls back, standing in for the cycle check
    // rejecting it. What has to hold is that nothing FAILED — no 40P01, no statement error — and
    // that `first` landed.
    assert.deepEqual(
      outcome.statements.filter((s) => !s.ok).map((s) => `${s.party}/${s.label}: ${s.sqlstate}`),
      [],
    );
    assert.equal(outcome.committed.first, true);
    assert.deepEqual(edges(outcome), ['second -> first']);
    // `second` read the graph AFTER being let through the mutex, so the edge `first` wrote is
    // visible to it. That is the whole cycle-detection guarantee: the second writer judges
    // against the committed graph, not the snapshot it opened with.
    const read = outcome.statements.find((s) => s.label === 'S2 read-graph');
    assert.equal(read?.ok, true);
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM "task_dependency" WHERE "id" = ANY($1::uuid[])`,
      [[ids.dependencyId, secondEdgeId]],
    );
    // `second` rolled back — a real cycle check would have rejected it — so only the first edge
    // survives, and the graph never held both directions at once.
    assert.equal(Number(rows[0].n), 1);
  });
});
