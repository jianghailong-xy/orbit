import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import { newFixtureIds, seedLockFixture, twoPartyDeadlockScenario } from './orbit-lock-fixture';
import { runScenario, type ScenarioSpec } from './pg-barrier';

const URL = process.env.COORDINATOR_PG_URL;

/**
 * The barrier harness's own properties, against a real fully-migrated PostgreSQL.
 *
 * Everything asserted here is true both before and after the production lock order is repaired:
 * that the scheduler advances on observed server state, that a barrier which never converges is
 * an error rather than a quiet pass, and that the row the two-party plan contends still carries
 * the foreign key the production report named. The claim that today's code LOSES that cycle is
 * the baseline command's (two-party-40p01.baseline.ts), deliberately not a test — a fix has to
 * break it, and a suite that permanently contains a case the fix breaks cannot be read.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable server
 * `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */
test('the barrier harness schedules on observed state', { skip: !URL, timeout: 120_000 }, async (t) => {
  const url = URL!;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  t.after(() => admin.end());

  await t.test('a declared block advances only when PostgreSQL reports the waiter blocked', async () => {
    const ids = newFixtureIds('harness-block');
    await seedLockFixture(admin, ids);
    // Plain row-lock contention on one Session — no cycle, so nothing here depends on the
    // production lock order.
    const spec: ScenarioSpec = {
      name: 'harness/row-lock-handoff',
      parties: [
        { name: 'holder', deadlockTimeout: '30min' },
        { name: 'waiter', deadlockTimeout: '30min' },
      ],
      plan: [
        { op: 'run', party: 'holder', label: 'hold',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId] },
        { op: 'block', party: 'waiter', label: 'wait',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId], blockedBy: ['holder'] },
        { op: 'finish', party: 'holder', action: 'COMMIT' },
        { op: 'settle', party: 'waiter' },
        { op: 'finish', party: 'waiter', action: 'COMMIT' },
      ],
    };
    const outcome = await runScenario(url, spec, 30_000);

    assert.equal(outcome.waitEdges.length, 1);
    const edge = outcome.waitEdges[0];
    assert.deepEqual(edge.blockingPids, [outcome.pids.holder]);
    assert.equal(edge.waitEventType, 'Lock');
    // The waiter's own ungranted lock is recorded, which is what makes the edge evidence and
    // not just a claim.
    assert.ok(
      edge.locks.some((l) => l.pid === outcome.pids.waiter && !l.granted),
      'no ungranted lock was captured for the waiter',
    );
    // Releasing the holder releases the waiter: the barrier observed a real wait, not a sleep.
    assert.deepEqual(
      outcome.statements.filter((s) => s.label === 'wait').map((s) => s.ok),
      [true],
    );
    assert.deepEqual(outcome.committed, { holder: true, waiter: true });
  });

  await t.test('a block that never blocks fails the run instead of passing', async () => {
    const ids = newFixtureIds('harness-nonblock');
    await seedLockFixture(admin, ids);
    const spec: ScenarioSpec = {
      name: 'harness/uncontended',
      parties: [
        { name: 'idle', deadlockTimeout: '30min' },
        { name: 'solo', deadlockTimeout: '30min' },
      ],
      plan: [
        // `idle` holds nothing, so this returns at once and `solo` is never blocked. The
        // scenario must fail rather than record a wait edge that did not happen.
        { op: 'block', party: 'solo', label: 'never-blocks',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId], blockedBy: ['idle'] },
        { op: 'settle', party: 'solo' },
        { op: 'finish', party: 'solo', action: 'COMMIT' },
      ],
    };
    await assert.rejects(
      () => runScenario(url, spec, 1_500),
      /finished without ever blocking/,
      'an unmet barrier must be an error, never a quiet pass',
    );

    // And a plan that declares a block on nobody is rejected outright, rather than being
    // trivially satisfied by an empty blocker set.
    const [blockStep] = spec.plan;
    assert.equal(blockStep.op, 'block');
    await assert.rejects(
      () => runScenario(url, { ...spec, plan: [{ ...blockStep, blockedBy: [] }] }, 1_500),
      /declares a block on nobody/,
    );
  });

  await t.test('an aborted transaction is never reported as committed', async () => {
    const ids = newFixtureIds('harness-aborted');
    await seedLockFixture(admin, ids);
    // A `lock_timeout` is a self-inflicted abort with no bearing on the production lock order:
    // it is here only to produce an aborted transaction cheaply. PostgreSQL then answers COMMIT
    // with the tag ROLLBACK, and `committed` has to say so.
    const spec: ScenarioSpec = {
      name: 'harness/aborted-commit',
      parties: [
        { name: 'holder', deadlockTimeout: '30min' },
        { name: 'loser', deadlockTimeout: '30min' },
      ],
      plan: [
        { op: 'run', party: 'holder', label: 'hold',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId] },
        { op: 'run', party: 'loser', label: 'arm-lock-timeout', sql: `SET LOCAL lock_timeout = '1s'` },
        { op: 'block', party: 'loser', label: 'give-up',
          sql: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
          values: [ids.contendedSessionId], blockedBy: ['holder'] },
        { op: 'settle', party: 'loser' },
        { op: 'finish', party: 'loser', action: 'COMMIT' },
        { op: 'finish', party: 'holder', action: 'COMMIT' },
      ],
    };
    const outcome = await runScenario(url, spec, 30_000);
    const gaveUp = outcome.statements.find((s) => s.label === 'give-up');
    assert.equal(gaveUp?.ok, false);
    assert.equal(gaveUp?.sqlstate, '55P03', 'expected lock_not_available');
    assert.deepEqual(outcome.committed, { loser: false, holder: true });
  });

  await t.test('deadlock_timeout is pinned per party, so the victim is configured not raced', async () => {
    const ids = newFixtureIds('harness-timeout');
    await seedLockFixture(admin, ids);
    await assert.rejects(
      () =>
        runScenario(
          url,
          {
            name: 'harness/bad-timeout',
            parties: [{ name: 'p', deadlockTimeout: 'not-a-duration' }],
            plan: [],
          },
          10_000,
        ),
      /could not pin deadlock_timeout|invalid value/i,
    );
  });

  await t.test('the two-party plan still contends the row the production report named', async () => {
    const ids = newFixtureIds('harness-shape');
    const spec = twoPartyDeadlockScenario(ids);
    // The victim's blocking statement names the Session the survivor holds FOR UPDATE — the
    // whole point of the fixture, and the part a careless edit would silently drop.
    const victimStep = spec.plan.find((s) => s.op === 'block' && s.party === 'task-create');
    const survivorLock = spec.plan.find((s) => s.op === 'run' && s.label.startsWith('B1'));
    assert.ok(victimStep && victimStep.op === 'block' && survivorLock && survivorLock.op === 'run');
    assert.match(survivorLock.sql, /FOR UPDATE/);
    assert.ok(survivorLock.values?.includes(ids.contendedSessionId));
    assert.ok(victimStep.values?.includes(ids.contendedSessionId));

    const { rows } = await admin.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'task' AND c.contype = 'f'
          AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                 WHERE attrelid = t.oid AND attname = 'creator_session_id')]`,
    );
    assert.deepEqual(rows.map((r) => r.conname), ['task_creator_session_id_fkey']);
  });
});
